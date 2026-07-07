"""Phase 21 — General-Purpose PCBA Design Engine v1.

Given ANY board request: parse -> classify -> fabrication decision -> pattern
selection -> capability check -> architecture plan -> gated board job. Every
stage is honest about what Compose has PROVEN (2/4-layer, 0.5mm TSSOP fanout,
the FL-1 pattern set) versus what is blocked (QFN-56 escape, HDI/microvia,
large BGA, high-speed SI/PI, RF signoff) — a request that needs unproven
capability gets architecture_only or blocked with the exact reason, never a
fake plan.

Extracted from FL-1 but NOT hard-coded to it: no FL-1 bus, Pico module, or
4-layer assumption unless the engine itself selects them.
"""
import re

DOMAINS = ("lab_instrument", "robotics", "sensor_node", "power_monitor",
           "motor_control", "industrial_control", "consumer_device",
           "space_electronics", "defense_electronics", "RF_adapter",
           "high_speed_digital", "AI_infrastructure", "backplane", "unknown")

FAMILIES = ("simple_breakout", "sensor_board", "MCU_carrier", "power_monitor",
            "power_supply_or_regulator", "motor_controller",
            "relay_or_switch_matrix", "calibration_reference",
            "external_instrument_interface", "digital_bringup_adapter",
            "backplane", "DUT_adapter", "data_acquisition",
            "RF_frontend_or_adapter", "high_speed_digital",
            "AI_accelerator_carrier", "space_or_high_reliability",
            "mixed_signal", "unknown")

BUILDABILITY = ("buildable_now", "buildable_with_review",
                "first_article_ready_with_review", "architecture_only",
                "blocked_by_missing_component_model",
                "blocked_by_unproven_fabrication", "blocked_by_unproven_routing",
                "blocked_by_unproven_high_speed", "blocked_by_unproven_safety",
                "blocked_by_external_solver_requirement")

# proven vs blocked capability (evidence: the FL-1 run history)
PROVEN = {"layers": [2, 4], "fine_pitch_mm": 0.5,
          "notes": "2/4-layer + 0.5mm TSSOP lane fanout proven on real runs"}
BLOCKED_CAPS = {
    "qfn56_escape": "QFN-56 0.4mm four-sided escape (Phase 18.8 exact blocker)",
    "hdi_microvia": "HDI / microvia / blind-buried vias never attempted",
    "large_bga": "large BGA escape never attempted",
    "high_speed_si_pi": "SI/PI signoff needs external solvers (honest since P13)",
    "controlled_impedance_signoff": "advisory-only impedance (IPC-2141 estimate)",
    "rf_performance": "no internal RF validation path (external-tool-first)",
    "power_stage": "no validated high-current power-stage primitives",
}

CLAIM_TYPES = ("schematic_generated", "layout_generated", "DRC_clean", "ERC_clean",
               "routed", "manufacturing_package_ready",
               "first_article_ready_with_review", "production_ready",
               "safety_compliant", "EMC_compliant", "thermal_compliant",
               "RF_compliant", "impedance_controlled", "high_speed_validated",
               "calibrated", "space_ready", "automotive_ready", "medical_ready")


# ---- Phase 1: request parsing -------------------------------------------------
_KW = {
    "sensor_node": ["environmental sensor", "sensor node", "battery", "temperature",
                    "humidity", "air quality"],
    "power_monitor": ["power monitor", "current monitor", "usb-c power", "energy meter"],
    "motor_control": ["motor controller", "brushed dc", "bldc", "stepper driver",
                      "servo controller", "esc"],
    "space_electronics": ["satellite", "cubesat", "space", "orbital", "watchdog board"],
    "RF_adapter": ["rf adapter", "rf ", "antenna", "50 ohm", "sma", "mixer", "lna"],
    "high_speed_digital": ["pcie", "serdes", "ddr", "10g", "100g", "224g", "448g",
                           "capture board"],
    "AI_infrastructure": ["ai accelerator", "gpu carrier", "npu", "tpu", "nvidia",
                          "accelerator carrier"],
    "backplane": ["backplane", "plugin cards", "card cage"],
    "robotics": ["robot", "actuator controller", "drone"],
    "lab_instrument": ["lab-grade", "instrument", "dmm", "oscilloscope", "calibration"],
    "industrial_control": ["relay control", "plc", "industrial", "24v io", "hat for relay"],
    "consumer_device": ["consumer", "wearable", "gadget"],
}


def _kw_hit(t, k):
    """Word-boundary match for short bare tokens ('sma' must not match inside
    'small' — a real bug the first non-FL-1 benchmark caught); substring match
    for phrases."""
    if " " in k or "-" in k or len(k) > 4:
        return k in t
    return re.search(r"\b%s\b" % re.escape(k.strip()), t) is not None


def parse_request(text):
    t = text.lower()
    domain = "unknown"
    for d, kws in _KW.items():
        if any(_kw_hit(t, k) for k in kws):
            domain = d
            break
    spec = {
        "request_text": text, "application_domain": domain,
        "intended_function": text,
        "environment": "space/vacuum" if domain == "space_electronics" else "bench/indoor (assumed)",
        "power_input": ("battery" if "battery" in t else
                        "usb-c" if "usb-c" in t or "usb c" in t else
                        "24V" if "24v" in t else "5V bench (assumed)"),
        "power_output": "motor phase power" if domain == "motor_control" else None,
        "interfaces": [i for i, kws in
                       [("i2c", ["i2c", "sensor"]), ("usb", ["usb"]),
                        ("spi", ["spi"]), ("uart", ["uart", "serial"]),
                        ("pcie", ["pcie"]), ("rf", ["rf ", "sma ", "antenna"]),
                        ("gpio", ["relay", "gpio", "hat"])]
                       if any(k in t for k in kws)],
        "high_speed": any(k in t for k in ("pcie", "serdes", "ddr", "10g", "224g", "448g")),
        "rf": any(_kw_hit(t, k) for k in ("rf", "rf adapter", "antenna", "sma", "50 ohm")),
        "high_current": any(k in t for k in ("motor", "24v", "power supply", "psu")),
        "high_reliability": domain in ("space_electronics", "defense_electronics"),
        "bga_or_dense_soc": any(k in t for k in ("accelerator", "gpu", "soc", "fpga carrier",
                                                 "nvidia", "pcie")),
        "quantity_target": "prototype (assumed)",
        "forbidden_claims": [], "evidence_requirements":
            ["all standard gates: DRC/ERC/role/validation/traceability"],
    }
    return spec


# ---- Phase 2: classifier --------------------------------------------------------
_FAMILY_MAP = {
    "sensor_node": ("sensor_board", ["battery power budget unverified"],
                    ["board identity EEPROM", "test-point policy"]),
    "power_monitor": ("power_monitor", ["accuracy needs calibration path"],
                      ["shunt + ADC monitor pattern", "board identity EEPROM"]),
    "motor_control": ("motor_controller", ["power stage + thermal + protection "
                      "unproven"], ["safe-default enable line", "interlock pattern"]),
    "space_electronics": ("space_or_high_reliability",
                          ["no space qualification path exists"],
                          ["board identity EEPROM", "evidence ledger pattern"]),
    "RF_adapter": ("RF_frontend_or_adapter", ["impedance advisory-only"],
                   ["test-point policy"]),
    "high_speed_digital": ("high_speed_digital", ["SI/PI external solver required"],
                           []),
    "AI_infrastructure": ("AI_accelerator_carrier",
                          ["HDI/BGA/SI-PI all unproven"], []),
    "backplane": ("backplane", ["connector keying policy applies"],
                  ["slot strap addressing", "I2C pull-up ownership",
                   "connector orientation/keying policy"]),
    "industrial_control": ("relay_or_switch_matrix", ["load ratings need evidence"],
                           ["relay/probe matrix pattern", "safe-default enable line"]),
    "lab_instrument": ("data_acquisition", ["no precision claim without calibration"],
                       ["calibration/reference pattern", "shunt + ADC monitor pattern"]),
    "robotics": ("MCU_carrier", ["actuator power unproven"],
                 ["protected GPIO bank", "safe-default enable line"]),
    "consumer_device": ("mixed_signal", ["cost/size targets unmodeled"], []),
    "unknown": ("unknown", ["request underspecified"], []),
}


def classify(spec):
    fam, risks, pats = _FAMILY_MAP.get(spec["application_domain"],
                                       ("unknown", ["unclassified"], []))
    second = []
    if spec.get("rf") and fam != "RF_frontend_or_adapter":
        second.append("RF_frontend_or_adapter")
    if spec.get("high_speed") and fam != "high_speed_digital":
        second.append("high_speed_digital")
    return {"board_family": fam, "secondary_families": second,
            "confidence": "high" if fam != "unknown" else "low",
            "reason": "domain '%s' from request keywords" % spec["application_domain"],
            "likely_risks": risks, "suggested_patterns": pats,
            "blocked_claims": _blocked_claims(spec)}


def _blocked_claims(spec):
    out = ["production_ready (no physical evidence)"]
    if spec.get("rf"):
        out.append("RF_compliant / impedance_controlled (no RF validation path)")
    if spec.get("high_speed"):
        out.append("high_speed_validated (external SI/PI required)")
    if spec.get("high_reliability"):
        out.append("space_ready / qualification claims (no qualification evidence)")
    if spec.get("high_current"):
        out.append("safety_compliant / thermal_compliant (no power-stage evidence)")
    if spec["application_domain"] == "lab_instrument":
        out.append("calibrated (physical calibration evidence required)")
    return out


# ---- Phase 3: fabrication decision ---------------------------------------------
def fabrication_decision(spec, cls):
    fam = cls["board_family"]
    if fam == "AI_accelerator_carrier":
        return {"recommendation": "10+ layer, HDI required",
                "capability": "blocked_by_unproven_fabrication",
                "reason": "HDI/microvia + large BGA escape + SI/PI are all "
                          "unproven (%s)" % BLOCKED_CAPS["hdi_microvia"],
                "confidence": "high (that it is blocked)"}
    if spec.get("high_speed"):
        return {"recommendation": "6-8 layer, controlled impedance required",
                "capability": "architecture_only",
                "reason": "external SI/PI solver required; controlled-impedance "
                          "signoff is advisory-only in Compose",
                "confidence": "high (that it needs external tools)"}
    if spec.get("rf"):
        return {"recommendation": "4-layer, RF section advisory-only",
                "capability": "architecture_only" if "adapter" not in
                              spec["request_text"].lower() else "requires_new_capability",
                "reason": "impedance is IPC-2141 advisory; RF performance needs "
                          "external validation (VNA)", "confidence": "medium"}
    if spec.get("high_current"):
        return {"recommendation": "4-layer with copper-pour power section (2oz "
                                  "candidate)", "capability": "requires_new_capability",
                "reason": "no validated power-stage primitives; thermal/current "
                          "evidence required before any power claim",
                "confidence": "medium"}
    dense = fam in ("MCU_carrier", "data_acquisition", "mixed_signal", "power_monitor",
                    "calibration_reference", "relay_or_switch_matrix", "backplane")
    return {"recommendation": "4-layer (GND/3V3 planes)" if dense else
            "2-layer candidate, 4-layer if routing density demands",
            "capability": "proven_now",
            "reason": "within proven 2/4-layer + 0.5mm fine-pitch capability",
            "confidence": "high"}


# ---- Phase 4: claim gates --------------------------------------------------------
def claim_gates(spec, buildability):
    gates = {}
    for c in CLAIM_TYPES:
        if c in ("schematic_generated", "layout_generated", "DRC_clean", "ERC_clean",
                 "routed", "manufacturing_package_ready"):
            gates[c] = "allowed" if buildability in ("buildable_now",
                       "buildable_with_review") else "not_applicable"
        elif c == "first_article_ready_with_review":
            gates[c] = "allowed_with_review" if buildability in (
                "buildable_now", "buildable_with_review") else "blocked"
        elif c == "production_ready":
            gates[c] = ("forbidden_without_evidence (physical builds + "
                        "validation + yield + human approval)")
        elif c in ("safety_compliant", "EMC_compliant", "thermal_compliant"):
            gates[c] = "forbidden_without_evidence"
        elif c in ("RF_compliant", "impedance_controlled"):
            gates[c] = "blocked" if spec.get("rf") else "not_applicable"
        elif c == "high_speed_validated":
            gates[c] = "blocked" if spec.get("high_speed") else "not_applicable"
        elif c == "calibrated":
            gates[c] = "forbidden_without_evidence" if spec[
                "application_domain"] in ("lab_instrument", "power_monitor") else "not_applicable"
        elif c in ("space_ready", "automotive_ready", "medical_ready"):
            gates[c] = "blocked" if spec.get("high_reliability") else "not_applicable"
    return gates


# ---- Phase 5: pattern library (extracted from FL-1, made generic) ----------------
PATTERNS = [
    ("board identity EEPROM", "every board self-identifies on a shared bus",
     "any board with I2C", "24LC02-class + straps", "read_board_id validation"),
    ("slot strap addressing", "duplicate boards coexist via slot-driven addresses",
     "backplane systems", "strap pins + pull-downs", "identity scan"),
    ("I2C pull-up ownership", "exactly one bus owner; effective-pullup checker",
     "any multi-board I2C", "4.7k + DNP variants", "pull-up checker + measurement"),
    ("connector orientation/keying policy", "no reversible critical connectors "
     "without mitigation", "any board-to-board system", "keyed/shrouded Rev B",
     "orientation checker + inspection"),
    ("safe-default enable line", "outputs disabled at boot until firmware enables",
     "relays/motors/power stages", "gated OE + pull-up", "boot-state check"),
    ("protected GPIO bank", "series-R protected external IO", "DUT/instrument IO",
     "100R + labeled header", "loopback"),
    ("relay/probe matrix pattern", "safe multiplexed switching", "switching boards",
     "relays + driver + gated SR", "continuity validation"),
    ("calibration/reference pattern", "known-voltage nodes measured by own ADC",
     "instruments", "reference + divider + ADC", "sanity now, calibration later"),
    ("shunt + ADC monitor pattern", "conservative V/I monitoring",
     "power monitors", "shunt + divider + protected ADC", "sense sanity"),
    ("external instrument bridge pattern", "COTS instruments in the evidence loop",
     "lab systems", "TTL UART + trigger IO", "loopback + instrument identity"),
    ("interlock/fault/reset/trigger pattern", "system safety lines",
     "multi-board systems", "dedicated MCU pins + bus lines", "continuity + policy"),
    ("test-point policy", "probeable nets by design", "all boards",
     "1.5mm labeled TPs", "probe access check"),
    ("QR/serial traceability", "every article traceable", "all boards",
     "serial plan + QR payload", "scan at inspection"),
    ("evidence ledger pattern", "append-only, failures preserved", "all systems",
     "ledger files", "audit"),
    ("human-gated order package", "Compose never spends money", "all orders",
     "approval forms + order stubs", "human signature"),
    ("manufacturing package audit", "package completeness before quotes",
     "all boards", "artifact checklist + hashes", "audit run"),
    ("build variant model", "standalone vs system population differences",
     "multi-board systems", "BOM/DNP views", "variant verification"),
    ("incoming inspection plan", "receive with evidence", "all boards",
     "checklists + photos", "ledger entries"),
    ("RevA->RevB feedback loop", "physical findings drive the next rev",
     "all products", "evidence-cited change requests", "human review"),
]


def pattern_library():
    return [{"name": n, "intent": i, "applicable": a, "requires": r,
             "validation": v, "source": "FL-1 (proven on real runs)",
             "portability": "generic — no FL-1 naming or bus assumption",
             "forbidden_claims": "pattern presence is never a compliance claim"}
            for n, i, a, r, v in PATTERNS]


# ---- Phase 6: capability checker --------------------------------------------------
KNOWN = {
    "pico module": "supported", "ads1115": "supported", "ref3025": "supported",
    "24lc02": "supported", "eeprom": "supported", "signal relay": "supported",
    "74hc595": "supported", "uln2803": "supported", "sn65hvd230": "supported",
    "headers": "supported", "0402 passives": "supported", "shunt": "supported",
    "tssop-10 0.5mm": "supported", "i2c sensor": "supported",
    "mcu": "supported (Pico module is the validated MCU primitive)",
    "watchdog mcu": "supported_with_review (Pico-class MCU; NO space claim)",
    "protection": "supported (series R + fuse recommendation pattern)",
    "current sense": "supported_with_review (shunt+ADC proven; INA unvalidated)",
    "sma connector": "missing_footprint (SMA not ingested)",
    "50-ohm traces": "supported_with_review (advisory-only impedance, IPC-2141)",
    "pcie connector": "missing_footprint (never ingested)",
    "gate driver": "missing_component_model (no validated power-stage parts)",
    "rp2040 bare qfn-56": "blocked_by_qfn56_escape",
    "hdi/microvia": "blocked", "large bga": "blocked",
    "224g/448g serdes": "architecture_only / external_solver_required",
    "usb-c connector": "missing_footprint (DRC-clean USB-C footprint pending — "
                       "2-pin power inlet is the proven stand-in)",
    "power mosfet stage": "missing_layout_primitive (no validated power stage)",
    "ina-class monitor": "supported_with_review (routes; measurement path "
                         "unvalidated)",
    "mcp4725 dac": "supported_with_review (ingests clean; not approved)",
}


def capability_check(required):
    rows = []
    for part in required:
        k = part.lower()
        status = "missing_component_model"
        for known, st in KNOWN.items():
            if known in k or k in known:
                status = st
                break
        rows.append({"item": part, "status": status})
    worst = "supported"
    order = ["supported", "supported_with_review", "missing_footprint",
             "missing_layout_primitive", "missing_component_model",
             "architecture_only / external_solver_required",
             "blocked_by_qfn56_escape", "blocked"]
    for r in rows:
        base = r["status"].split(" (")[0]
        if order.index(base) > order.index(worst.split(" (")[0]):
            worst = base
    return {"items": rows, "worst": worst}


# ---- Phase 7+8: planner + job -------------------------------------------------------
def plan(spec):
    cls = classify(spec)
    fab = fabrication_decision(spec, cls)
    required = _required_parts(spec, cls)
    cap = capability_check(required)
    build = _buildability(fab, cap)
    job = {
        "board_name": spec["request_text"][:60],
        "board_family": cls["board_family"],
        "intended_function": spec["intended_function"],
        "allowed_claims": [c for c, g in claim_gates(spec, build).items()
                           if g == "allowed"],
        "forbidden_claims": cls["blocked_claims"],
        "required_components": required,
        "interfaces": spec["interfaces"],
        "power": spec["power_input"],
        "layer_recommendation": fab["recommendation"],
        "layer_confidence": fab["confidence"],
        "patterns": cls["suggested_patterns"],
        "validation_plan": "per-pattern validation + standard gates",
        "manufacturing_plan": "package audit + quote checklist (Phase 20 model)",
        "evidence_gates": "DRC/ERC/role/traceability/human-order-gate",
        "buildability": build,
    }
    return {"spec": spec, "classification": cls, "fabrication": fab,
            "capability": cap, "job": job,
            "next_required_capability": _next_capability(fab, cap)}


def _required_parts(spec, cls):
    fam = cls["board_family"]
    base = {"sensor_board": ["Pico module OR small MCU", "I2C sensor", "0402 passives",
                             "headers", "EEPROM"],
            "power_monitor": ["ADS1115", "shunt 0402", "headers", "EEPROM",
                              "USB-C connector" if "usb" in spec["power_input"] else "headers"],
            "motor_controller": ["MCU", "power MOSFET stage", "gate driver",
                                 "current sense", "protection"],
            "relay_or_switch_matrix": ["signal relay", "74HC595", "ULN2803",
                                       "headers", "EEPROM"],
            "space_or_high_reliability": ["watchdog MCU", "EEPROM", "headers"],
            "RF_frontend_or_adapter": ["SMA connector", "50-ohm traces (advisory)"],
            "high_speed_digital": ["PCIe connector", "224G/448G SerDes class parts"],
            "AI_accelerator_carrier": ["large BGA SoC", "HDI/microvia stackup",
                                       "high-current VRM"],
            "backplane": ["headers", "0402 passives"],
            "data_acquisition": ["ADS1115", "REF3025", "EEPROM", "headers"],
            "MCU_carrier": ["Pico module", "headers", "0402 passives"],
            "mixed_signal": ["MCU", "headers"]}
    return base.get(fam, ["headers"])


def _buildability(fab, cap):
    if fab["capability"] == "blocked_by_unproven_fabrication":
        return "blocked_by_unproven_fabrication"
    if cap["worst"].startswith("blocked_by_qfn56"):
        return "blocked_by_unproven_routing"
    if cap["worst"] == "blocked":
        return "blocked_by_unproven_fabrication"
    if fab["capability"] == "architecture_only" or \
       cap["worst"].startswith("architecture_only"):
        return "architecture_only"
    if cap["worst"] in ("missing_component_model", "missing_layout_primitive",
                        "missing_footprint"):
        return "blocked_by_missing_component_model" \
            if cap["worst"] == "missing_component_model" else "architecture_only"
    if fab["capability"] == "requires_new_capability":
        return "architecture_only"
    if cap["worst"] == "supported_with_review":
        return "buildable_with_review"
    return "buildable_with_review"  # honest default: review always required


def _next_capability(fab, cap):
    for r in cap["items"]:
        if "blocked" in r["status"] or "missing" in r["status"]:
            return "unblock: %s (%s)" % (r["item"], r["status"])
    if fab["capability"] != "proven_now":
        return fab["reason"]
    return None
