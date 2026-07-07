"""Phase 23.2 — General Physical Board Synthesis Engine v1.

request -> functional intent IR -> implementation planner -> {existing blocks,
JIT primitives, synthesized subcircuits, sourced parts, honest blockers} ->
power tree -> connector strategy -> constraint-driven placement -> compose spec.

The move from "assemble known blocks" to "synthesize ordinary board structure
from intent" — with every synthesized structure review-required, every unproven
domain blocked, and FL-1 assumptions applied ONLY to FL-1 boards.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "blocks"))
import compose  # noqa: E402
import pcba_engine as pe  # noqa: E402

# ---- Phase 2: functional intent IR ----------------------------------------------
INTENTS = ("provide_5v_power_input", "provide_usb_c_5v_input",
           "provide_battery_input", "regulate_to_3v3", "host_i2c_sensor",
           "host_spi_sensor", "expose_i2c_header", "expose_uart_header",
           "expose_spi_header", "expose_debug_header", "measure_voltage",
           "measure_current", "switch_low_current_load",
           "indicate_power_status", "read_user_button", "select_i2c_address",
           "provide_test_points", "protect_power_input", "mount_to_plate",
           "expose_expansion_header", "host_compute", "provide_board_identity")

HIGH_RISK_INTENTS_BLOCKED_V1 = ("high_current_power_stage", "mains_input",
                                "high_voltage", "rf_frontend",
                                "high_speed_serdes", "medical", "implantable",
                                "safety_critical_control")

IR_FIELDS = ("functions", "power_domains", "required_rails", "signal_groups",
             "sensors", "actuators", "compute", "communication", "connectors",
             "user_io", "debug", "protection", "measurement", "calibration",
             "mechanical", "environmental", "safety", "validation",
             "manufacturing", "blocked_claims", "assumptions_review_required",
             "missing_information", "unsupported_items")


def compile_intent(request_text):
    """Request -> functional intent IR (via the Phase 21 parser). Inferred
    values are review-required; high-risk functionality is never silently
    inferred."""
    spec = pe.parse_request(request_text)
    cls = pe.classify(spec)
    t = request_text.lower()
    fns, review, unsupported = [], [], []
    if "usb-c" in t or "usb c" in t:
        fns.append("provide_usb_c_5v_input")
    elif "battery" in t:
        fns.append("provide_battery_input")
    else:
        fns.append("provide_5v_power_input")
        review.append("power input inferred as bench 5V header")
    if any(k in t for k in ("sensor", "temperature", "humidity", "pressure",
                            "environmental")):
        fns.append("host_i2c_sensor")
    if any(k in t for k in ("logger", "adc", "measure", "data acquisition",
                            "acquisition")):
        fns += ["measure_voltage", "expose_uart_header"]
    if "relay" in t or "switch" in t:
        fns.append("switch_low_current_load")
    if "breakout" in t:
        fns.append("expose_i2c_header")
    if any(k in t for k in ("mcu", "logger", "relay", "controller", "hat")):
        fns.append("host_compute")
    if "motor" in t:
        unsupported.append({"intent": "high_current_power_stage",
                            "why": "power-stage/gate-driver/thermal/safety "
                                   "rules not supported in v1 — BLOCKED"})
    if spec.get("rf"):
        unsupported.append({"intent": "rf_frontend",
                            "why": "RF unproven — architecture_only"})
    if spec.get("high_speed"):
        unsupported.append({"intent": "high_speed_serdes",
                            "why": "external SI/PI required — architecture_only"})
    fns += ["indicate_power_status", "provide_test_points", "mount_to_plate"]
    review.append("status LED + test points + mounting inferred as standard "
                  "practice (review-required)")
    return {"request": request_text, "board_family": cls["board_family"],
            "functions": sorted(set(fns)),
            "blocked_claims": cls["blocked_claims"],
            "assumptions_review_required": review,
            "missing_information": [] if spec["application_domain"] != "unknown"
                                    else ["application domain unclear"],
            "unsupported_items": unsupported}


# ---- Phase 4: intent -> implementation ------------------------------------------
IMPL = {
    "provide_5v_power_input": ("existing_block", "power (2-pin inlet + bulk cap)"),
    "provide_usb_c_5v_input": ("JIT_primitive", "usbcsink (USB4125 power-only, "
                               "CC pulldowns; no PD/data/compliance claims)"),
    "provide_battery_input": ("existing_block", "power inlet reused as battery "
                              "input (rail-naming caveat recorded; no charger)"),
    "regulate_to_3v3": ("existing_block", "Pico module 3V3OUT when compute "
                        "present; standalone regulator = review-required"),
    "host_i2c_sensor": ("sourced_part_contract", "source_part I2C sensor "
                        "(LM75B-class) or JIT (BME280)"),
    "expose_i2c_header": ("synthesized_subcircuit", "i2c_header"),
    "expose_uart_header": ("synthesized_subcircuit", "uart_header"),
    "expose_spi_header": ("synthesized_subcircuit", "spi_header"),
    "expose_debug_header": ("synthesized_subcircuit", "debug_header"),
    "measure_voltage": ("existing_block", "calref/dutmonitor ADC chain "
                        "(uncalibrated)"),
    "measure_current": ("existing_block", "dutmonitor shunt chain (monitor-only)"),
    "switch_low_current_load": ("existing_block", "relaymatrix (safe-default OE)"),
    "indicate_power_status": ("synthesized_subcircuit", "led_indicator"),
    "read_user_button": ("synthesized_subcircuit", "button"),
    "select_i2c_address": ("synthesized_subcircuit", "address_jumper"),
    "provide_test_points": ("synthesized_subcircuit", "testpoint_cluster "
                            "(+ universal TP row)"),
    "protect_power_input": ("architecture_only_placeholder", "inline fuse "
                            "recommendation; no protection-circuit claim"),
    "mount_to_plate": ("existing_block", "universal M3 corner holes"),
    "expose_expansion_header": ("existing_block", "gpiobank (protected GPIO)"),
    "host_compute": ("existing_block", "mcu (Pico module — the validated "
                     "compute primitive)"),
    "provide_board_identity": ("existing_block", "boardid (generic GND-strap "
                               "mode off-FL-1)"),
}


def plan_implementation(ir):
    rows, blocked = [], []
    for fn in ir["functions"]:
        strat, what = IMPL.get(fn, ("blocked", "no strategy for %s" % fn))
        rows.append({"intent": fn, "strategy": strat, "selection": what,
                     "evidence_state": "review_required" if strat ==
                     "synthesized_subcircuit" else "per selected primitive",
                     "blocked_claims": ["physically_validated",
                                        "production_ready"]})
    for u in ir["unsupported_items"]:
        blocked.append(u)
    return {"decisions": rows, "blocked": blocked,
            "rules": ["proven blocks preferred", "JIT for acquireable gaps",
                      "synthesis only for low-risk generic patterns",
                      "high-current/HV/RF/high-speed/medical BLOCKED in v1"]}


# ---- Phase 6: conservative power tree --------------------------------------------
def power_tree(ir):
    fns = set(ir["functions"])
    tree = {"input": None, "rails": [], "generated": [], "blocked_claims":
            ["low_power_validated", "thermal_compliant", "battery_safety_"
             "validated", "USB_certified"], "caveats": []}
    if "provide_usb_c_5v_input" in fns:
        tree["input"] = ("USB-C 5V sink (USB4125 power-only; "
                         "default-current sink only)")
    elif "provide_battery_input" in fns:
        tree["input"] = ("battery 2-pin inlet (input ONLY — no "
                         "charger primitive)")
        tree["caveats"].append("rail net named +5V by composer convention; "
                               "Pico VSYS tolerates 1.8-5.5V")
    else:
        tree["input"] = "bench 5V 2-pin inlet"
    tree["rails"].append("+5V (input rail)")
    if "host_compute" in fns:
        tree["rails"].append("+3V3 from the Pico module 3V3OUT (proven)")
    else:
        tree["caveats"].append(
            "no compute module: +3V3 loads must come from the host via a "
            "header (breakout convention) — no regulator invented")
    if "indicate_power_status" in fns:
        tree["generated"].append("led_indicator subcircuit")
    tree["generated"].append("power test points (universal row)")
    tree["caveats"].append("inline fuse RECOMMENDED at the bench; no "
                           "protection-circuit claim")
    return tree


# ---- Phase 7: connector strategy --------------------------------------------------
def connector_strategy(ir):
    fns = set(ir["functions"])
    conns = []
    def add(name, kind, keyed, note):
        conns.append({"connector": name, "kind": kind, "keyed": keyed,
                      "orientation_risk": "review_required" if not keyed else "low",
                      "silk": "pin-1 mark + net legend", "note": note})
    if "provide_usb_c_5v_input" in fns:
        add("USB-C receptacle (USB4125)", "power input", True,
            "reversible BY DESIGN (USB-C); power-only part")
    else:
        add("2-pin power header", "power input", False,
            "unkeyed — inspection mitigation")
    if "expose_i2c_header" in fns:
        add("1x04 I2C header", "expansion", False, "unkeyed — review-required")
    if "expose_uart_header" in fns:
        add("1x04 UART header", "debug/expansion", False, "unkeyed")
    if "expose_expansion_header" in fns:
        add("1x05 protected GPIO header", "expansion", False, "100R series")
    return {"connectors": conns,
            "rules": ["orientation/keying risk explicit", "unkeyed = "
                      "review-required", "unsupported footprints -> JIT or "
                      "architecture_only", "RF/high-speed connectors never "
                      "imply RF/high-speed validation"]}


# ---- Phase 8: constraint-driven placement -----------------------------------------
def placement_plan(ir):
    fns = set(ir["functions"])
    groups = [
        {"group": "power entry", "constraint": "board edge (band 0, col 0)",
         "rationale": "cable access + short bulk path"},
        {"group": "compute", "constraint": "central band" if "host_compute"
         in fns else "n/a", "rationale": "minimizes bus stubs"},
        {"group": "sensors/analog", "constraint": "away from switching "
         "(separate band from relays)", "rationale": "noise partitioning"},
        {"group": "connectors/headers", "constraint": "top access edge",
         "rationale": "operator access"},
        {"group": "test points", "constraint": "bottom margin row (universal)",
         "rationale": "probe access"},
        {"group": "mounting/fiducials", "constraint": "corner margin band "
         "(universal)", "rationale": "fixturing"},
    ]
    return {"groups": groups,
            "implementation_note": "v1 maps constraint groups onto the proven "
            "band/column layout machinery (ROW/COL); a free-form constraint "
            "solver is a recorded future capability, not a claim",
            "fl1_isolation": "FL-1 floorplan rows apply ONLY when FL-1 blocks "
            "are present; non-FL-1 boards get generic bands",
            "conflicts": []}


# ---- Phase 10: role framework v2 ---------------------------------------------------
ROLE_TEMPLATES = {
    "sensor_board": {"required": ["power input", "sensor on a bus", "test "
                     "points", "mounting", "silk"], "blocked_claims":
                     ["calibrated", "accuracy"]},
    "MCU_carrier": {"required": ["power input", "compute", "debug path",
                    "test points", "mounting"], "blocked_claims": []},
    "power_entry": {"required": ["power input", "power indicator",
                    "test points", "mounting"], "blocked_claims":
                    ["USB_certified", "protection claims"]},
    "USB_C_power_entry": {"required": ["USB-C receptacle", "CC pulldowns",
                          "power indicator", "test points"], "blocked_claims":
                          ["USB_certified", "PD", "data", "charger"]},
    "power_monitor": {"required": ["sense path", "protected ADC inputs",
                      "limits on silk"], "blocked_claims": ["DMM", "precision"]},
    "relay_controller": {"required": ["safe-default enable", "channel map",
                         "flyback protection"], "blocked_claims":
                         ["HV", "high-current"]},
    "simple_data_acquisition": {"required": ["ADC path", "reference or "
                                "uncal note", "comms header"],
                                "blocked_claims": ["calibrated"]},
    "connector_breakout": {"required": ["target part", "access header",
                           "bus pull-up ownership", "test points"],
                           "blocked_claims": ["performance claims"]},
    "lab_instrument_adapter": {"required": ["instrument link", "trigger "
                               "safe-default"], "blocked_claims":
                               ["internal instrument claims"]},
    "backplane": {"required": ["slots", "bus", "identity scheme",
                  "system pull-up owner"], "blocked_claims": []},
    "environmental_sensor": {"required": ["T/H/P sensor", "I2C", "identity "
                             "optional", "test points"], "blocked_claims":
                             ["calibrated", "accuracy", "low_power"]},
}


def synthesize(request_text):
    """The full chain for one request: IR -> plan -> power tree -> connectors
    -> placement. Returns everything needed to build a compose spec."""
    ir = compile_intent(request_text)
    return {"ir": ir, "implementation": plan_implementation(ir),
            "power_tree": power_tree(ir),
            "connectors": connector_strategy(ir),
            "placement": placement_plan(ir),
            "role_template": ROLE_TEMPLATES.get(ir["board_family"],
                                                ROLE_TEMPLATES["sensor_board"])}


# ---- Phase 1: machine audit of compose.py -----------------------------------------
def audit_compose():
    blocks = []
    fl1_keys = {"fl1bus", "boardid", "comms", "relaymatrix", "calref",
                "calrefext", "dutmonitor", "backplane6"}
    generic_keys = {"power", "mcu", "usbc", "gpiobank", "spibus", "uartbridge",
                    "statusled", "bme280", "bme280breakout", "usbcsink",
                    "standalone", "tempsensor", "imu"}
    for key, fn in compose.BLOCK_TABLE.items():
        blocks.append({"block": key, "doc": (fn.__doc__ or "").split("\\n")[0][:100],
                       "scope": ("fl1" if key in fl1_keys else
                                 "generic" if key in generic_keys else "mixed"),
                       "replaceable_by_synthesis": key in
                       ("statusled", "spibus", "uartbridge", "gpiobank")})
    return {"version": "v1", "block_count": len(blocks), "blocks": blocks,
            "subcircuit_kinds": sorted(compose.SUBCIRCUITS.keys()),
            "assumptions": {
                "placement": "band/column regions (ROW/COL) + width budget",
                "routing": "flroute grid + fine-pitch fanout (<=0.7mm rows) + "
                           "plane stitcher",
                "fabrication": "automated 4-layer stackup (2-layer automated "
                               "flow = recorded gap)",
                "layer_count": "4 (GND/3V3 inner planes)",
                "rail_naming": "+5V/+3V3 convention (genericity caveat)",
                "manufacturing": "package hash -> gerbers at order time",
                "fl1_specific": "bus v2 header, slot straps, safety nets — "
                                "applied only when FL-1 blocks requested"},
            "known_blockers": ["QFN-56 quadrant escape", "HDI/microvia",
                               "large BGA", "external SI/PI", "power stages",
                               "2-layer automated flow"]}
