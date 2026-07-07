"""Architecture Search + Trade-Space Explorer v1 (Phase 18).

Compares candidate architectures BEFORE any board is generated or ordered: internal
board vs external COTS vs hybrid vs multi-board vs reduced-scope vs mock-only vs
hold. Every candidate is grounded in the real evidence layers (ingestion library,
build-readiness, validation/calibration models, reference library), and HARD
BLOCKERS DOMINATE: no aggregate score can hide do_not_build, a missing physical
validation path, a fake precision claim, unrouteable fine pitch, missing ingestion,
or an unsafe default state.

Nothing here orders, claims production readiness, or fakes simulation/precision.
"""

READINESS = ("concept_only", "architecture_only", "design_attempt_candidate",
             "ready_for_compose_attempt", "ready_for_reviewed_order_package",
             "blocked_by_missing_ingestion", "blocked_by_router_capability",
             "blocked_by_validation_capability", "blocked_by_calibration_capability",
             "blocked_by_external_tool_requirement", "do_not_build")

SCORE_DIMS = ("capability_fit", "manufacturability", "routing_feasibility",
              "validation_feasibility", "calibration_feasibility", "bom_availability",
              "sourcing_risk", "firmware_complexity", "software_complexity",
              "bringup_complexity", "safety_risk", "cost_risk", "schedule_risk",
              "future_expandability", "reuse_of_existing_patterns",
              "reuse_of_existing_validated_boards", "evidence_quality")

HARD_BLOCKERS = ("do_not_build", "unsupported_capability_claim",
                 "missing_physical_validation_path", "fake_precision_claim",
                 "external_si_pi_required_unavailable", "unrouteable_fine_pitch",
                 "missing_component_ingestion", "unsafe_default_state")

VALIDATION_STATES = ("validation_ready_physical", "validation_ready_with_cots",
                     "validation_ready_with_internal_reference",
                     "validation_ready_mock_only", "validation_blocked",
                     "validation_unsupported")

CAL_STATES = ("not_calibratable", "uncalibrated", "sanity_checkable", "cots_verifiable",
              "internally_calibratable", "externally_calibratable", "calibration_blocked")


def _score(v, confidence, reason, evidence, caveats=None):
    return {"score": v, "confidence": confidence, "reason": reason,
            "evidence_source": evidence, "caveats": caveats or []}


def candidate(cid, target, name, desc, **kw):
    c = {
        "candidate_id": cid, "target_capability": target,
        "board_family": kw.get("family", target),
        "architecture_name": name, "architecture_description": desc,
        "functional_blocks": kw.get("blocks", []),
        "component_classes": kw.get("components", []),
        "concrete_candidate_parts": kw.get("parts", []),
        "interfaces": kw.get("interfaces", ["FL-1 bus v2 (I2C + safety + ID straps)"]),
        "power_domains": kw.get("power", ["+5V", "+3V3"]),
        "analog_domains": kw.get("analog", []),
        "digital_domains": kw.get("digital", ["3V3 logic"]),
        "safety_paths": kw.get("safety", ["FAULT/INTERLOCK on bus v2"]),
        "calibration_paths": kw.get("cal_paths", []),
        "validation_hooks": kw.get("val_hooks", ["Phase 14 command layer"]),
        "expected_board_count": kw.get("boards", 1),
        "estimated_layer_count": kw.get("layers", 4),
        "estimated_bom_complexity": kw.get("bom", "low"),
        "estimated_routing_complexity": kw.get("routing", "low"),
        "estimated_firmware_complexity": kw.get("firmware", "low"),
        "estimated_validation_complexity": kw.get("validation", "low"),
        "estimated_calibration_complexity": kw.get("calibration", "n/a"),
        "manufacturing_risk": kw.get("mfg_risk", "low"),
        "sourcing_risk": kw.get("src_risk", "low"),
        "known_blockers": kw.get("blockers", []),
        "hard_blockers": kw.get("hard_blockers", []),
        "unsupported_claims": kw.get("forbidden", []),
        "validation_path": kw.get("val_path", "validation_ready_with_cots"),
        "calibration_path": kw.get("cal_path", "sanity_checkable"),
        "scores": kw.get("scores", {}),
        "readiness": kw.get("readiness", "architecture_only"),
        "recommended_next_step": kw.get("next_step", "review"),
    }
    assert c["readiness"] in READINESS
    assert c["validation_path"] in VALIDATION_STATES
    assert c["calibration_path"] in CAL_STATES
    for hb in c["hard_blockers"]:
        assert hb in HARD_BLOCKERS, hb
    return c


def aggregate(c):
    """Aggregate score — but hard blockers DOMINATE: any hard blocker pins the
    verdict regardless of the numeric total."""
    nums = [s["score"] for s in c["scores"].values() if isinstance(s.get("score"), (int, float))]
    avg = round(sum(nums) / len(nums), 2) if nums else 0.0
    if c["hard_blockers"]:
        return {"aggregate": avg, "verdict": "BLOCKED",
                "dominated_by": c["hard_blockers"],
                "note": "hard blockers dominate — the numeric score is informational only"}
    return {"aggregate": avg, "verdict": "viable" if avg >= 0.55 else "weak"}


# =============================================================================
# The FL-1 candidate library — grounded in the real evidence state:
#   ingested+proven: ADS1115, REF3025, 24LC02, SN65HVD230, 74HC595, ULN2803,
#     relays, Pico; validated boards: 4x Batch 1 (review-ready)
#   NOT ingested: INA-class monitor, DAC, fast ADC, mux, level shifters
# =============================================================================
def _c(*a, **k):
    return candidate(*a, **k)


TARGETS = {
    "power_current_monitor": [
        _c("PCM-1", "power_current_monitor", "internal monitor board (INA-class)",
           "Pico + INA-class I2C current monitor + kelvin shunt + protected rail on the "
           "proven FL-1 board pattern",
           components=["monitor(I2C)", "shunt", "eeprom"], parts=["INA219/INA228 (NOT ingested)"],
           blocks=["mcu", "current monitor", "shunt", "fl1 bus", "board id"],
           cal_paths=["shunt value known; cots_verifiable vs external DMM"],
           readiness="blocked_by_missing_ingestion",
           blockers=["INA-class part not ingested"], boards=1,
           val_path="validation_ready_with_cots", cal_path="cots_verifiable",
           scores={"capability_fit": _score(0.85, "high", "direct fit", "benchmark suite"),
                   "reuse_of_existing_patterns": _score(0.8, "high", "shared-bus + board-id proven", "Batch 1"),
                   "bom_availability": _score(0.6, "medium", "monitor part needs ingestion", "ingest library"),
                   "validation_feasibility": _score(0.8, "high", "COTS PSU/DMM validate it", "Phase 14 COTS spec")},
           next_step="ingest INA-class part -> compose attempt"),
        _c("PCM-2", "power_current_monitor", "external COTS PSU + DMM only",
           "no internal board; programmable supply + DMM through the adapter layer",
           components=[], boards=0, readiness="ready_for_compose_attempt",
           val_path="validation_ready_with_cots", cal_path="cots_verifiable",
           scores={"capability_fit": _score(0.7, "high", "covers bench needs, no FL-1 integration", "COTS spec"),
                   "schedule_risk": _score(0.9, "high", "zero build", "n/a"),
                   "future_expandability": _score(0.4, "medium", "no internal automation", "n/a")},
           next_step="use COTS now; revisit internal after Batch 1 bring-up"),
        _c("PCM-3", "power_current_monitor", "hybrid: COTS supply + internal monitor tap",
           "COTS PSU provides power; a small internal board only MEASURES (shunt + monitor)",
           components=["monitor(I2C)", "shunt"], parts=["INA-class (NOT ingested)"],
           readiness="blocked_by_missing_ingestion", boards=1,
           blockers=["INA-class part not ingested"],
           val_path="validation_ready_with_cots", cal_path="cots_verifiable",
           scores={"capability_fit": _score(0.8, "high", "measurement without PSU risk", "design"),
                   "safety_risk": _score(0.85, "high", "no internal power switching", "design")},
           next_step="same ingestion gate as PCM-1; lower safety risk"),
    ],
    "dmm_lite": [
        _c("DMM-1", "dmm_lite", "ADS1115 + REF3025 + input divider (proven parts)",
           "reuses the EXACT proven cal-board measurement chain with an input divider + "
           "protection for external inputs",
           components=["adc(ADS1115)", "voltage_reference(REF3025)", "eeprom"],
           parts=["ADS1115 (ingested+routed)", "REF3025 (ingested+routed)"],
           cal_paths=["against Calibration/Reference board AFTER it exists physically"],
           readiness="ready_for_compose_attempt", boards=1,
           forbidden=["precision claim without calibration evidence", "6.5-digit"],
           val_path="validation_ready_with_internal_reference", cal_path="internally_calibratable",
           scores={"capability_fit": _score(0.75, "high", "16-bit basic DMM path", "cal board evidence"),
                   "reuse_of_existing_validated_boards": _score(0.9, "high",
                       "the cal board v2 chain is routed+clean", "fl1-cal-board-v4"),
                   "calibration_feasibility": _score(0.7, "medium",
                       "internally_calibratable once the cal board is physical", "Phase 16 model")},
           next_step="HOLD until Calibration/Reference is fabricated + verified; then compose"),
        _c("DMM-2", "dmm_lite", "higher-resolution ADC (new part)",
           "24-bit sigma-delta ADC for better resolution",
           parts=["ADS1256/AD7124 class (NOT ingested)"],
           readiness="blocked_by_missing_ingestion",
           blockers=["24-bit ADC not ingested; likely fine-pitch"],
           forbidden=["precision claim without calibration evidence"],
           val_path="validation_ready_with_cots", cal_path="cots_verifiable",
           scores={"capability_fit": _score(0.85, "medium", "better resolution ONLY if calibrated", "none yet"),
                   "routing_feasibility": _score(0.6, "medium", "likely fine-pitch (fanout exists now)", "Phase 16.5")},
           next_step="defer; DMM-1 first"),
        _c("DMM-3", "dmm_lite", "external COTS DMM only",
           "no internal DMM; COTS DMM through the adapter layer",
           boards=0, readiness="ready_for_compose_attempt",
           val_path="validation_ready_with_cots", cal_path="cots_verifiable",
           scores={"capability_fit": _score(0.8, "high", "real accuracy today", "COTS spec"),
                   "future_expandability": _score(0.4, "medium", "no internal automation", "n/a")},
           next_step="use COTS now; DMM-1 after cal board exists"),
    ],
    "scope_lite": [
        _c("SCP-1", "scope_lite", "external COTS oscilloscope (RECOMMENDED)",
           "scope through the adapter layer; FL-1 orchestrates, the scope measures",
           boards=0, readiness="ready_for_compose_attempt",
           val_path="validation_ready_with_cots", cal_path="cots_verifiable",
           scores={"capability_fit": _score(0.9, "high", "real bandwidth today", "COTS spec"),
                   "evidence_quality": _score(0.9, "high", "instrument identity in ledger", "Phase 16")},
           next_step="COTS-first; no internal scope attempt"),
        _c("SCP-2", "scope_lite", "internal fast-ADC scope board",
           "internal scope-class capture", parts=["fast ADC (NOT ingested)"],
           readiness="do_not_build",
           hard_blockers=["do_not_build", "missing_component_ingestion",
                          "missing_physical_validation_path"],
           blockers=["no fast ADC/AFE/clocking/capture capability (Phase 12 verdict stands)"],
           forbidden=["oscilloscope-class bandwidth/ENOB/sample-rate"],
           val_path="validation_unsupported", cal_path="calibration_blocked",
           scores={"capability_fit": _score(0.3, "low", "cannot honestly hit scope-class", "Phase 12/13")},
           next_step="HOLD — external-COTS-first stands"),
        _c("SCP-3", "scope_lite", "reduced-scope: slow waveform logger",
           "ADS1115-based sub-kHz waveform logging (NOT a scope)",
           components=["adc(ADS1115)"], readiness="design_attempt_candidate",
           forbidden=["oscilloscope-class anything — this is a <=~100Hz logger"],
           val_path="validation_ready_with_cots", cal_path="sanity_checkable",
           scores={"capability_fit": _score(0.35, "high", "honest but very limited", "ADS1115 rate"),
                   "schedule_risk": _score(0.8, "high", "proven parts", "cal board")},
           next_step="only if a slow-logger need is real; never call it a scope"),
    ],
    "external_instrument_interface": [
        _c("EII-1", "external_instrument_interface", "controller + serial/USB bridge board "
           "(LOWEST-RISK NEXT BOARD)",
           "Pico USB + UART/RS485 headers + trigger IO + protected GPIO on bus v2 — maps "
           "COTS instruments into the FL-1 validation layer",
           components=["mcu", "gpio bank", "eeprom"],
           parts=["all ingested/proven (Pico, headers, 24LC02)"],
           blocks=["mcu", "spi", "gpio bank", "fl1 bus", "board id"],
           readiness="ready_for_compose_attempt", boards=1,
           val_path="validation_ready_with_cots", cal_path="sanity_checkable",
           scores={"capability_fit": _score(0.85, "high", "bridges COTS into FL-1", "Phase 14"),
                   "reuse_of_existing_patterns": _score(0.95, "high",
                       "digital-bringup v2.1 is 80% of this board", "fl1-core-digital-v21"),
                   "bom_availability": _score(0.95, "high", "all parts proven", "ingest library"),
                   "schedule_risk": _score(0.85, "high", "compose-ready today", "Batch 1")},
           next_step="compose attempt after Batch 1 order decision"),
        _c("EII-2", "external_instrument_interface", "ethernet/LXI bridge",
           "LAN instrument control", parts=["ethernet PHY (NOT ingested)"],
           readiness="blocked_by_missing_ingestion",
           blockers=["ethernet PHY not ingested; RMII routing unproven"],
           val_path="validation_ready_with_cots", cal_path="not_calibratable",
           scores={"capability_fit": _score(0.7, "medium", "nice-to-have", "none")},
           next_step="defer; USB/serial first"),
        _c("EII-3", "external_instrument_interface", "no board: host-PC drives COTS directly",
           "pure software adapters", boards=0, readiness="ready_for_compose_attempt",
           val_path="validation_ready_with_cots", cal_path="not_calibratable",
           scores={"capability_fit": _score(0.6, "high", "works, no trigger fan-out", "Phase 14"),
                   "future_expandability": _score(0.5, "medium", "no FL-1 bus presence", "n/a")},
           next_step="acceptable interim; EII-1 adds trigger/interlock integration"),
    ],
    "logic_capture": [
        _c("LC-1", "logic_capture", "reduced-scope: Pico GPIO event capture",
           "protected GPIO inputs + Pico timestamping — EVENT capture, NOT analyzer-class",
           components=["mcu", "gpio bank"], parts=["all proven"],
           readiness="design_attempt_candidate",
           forbidden=["logic-analyzer-class timing/skew/sample-rate claims"],
           val_path="validation_ready_with_cots", cal_path="sanity_checkable",
           scores={"capability_fit": _score(0.5, "high", "honest event capture (~us class)", "Pico"),
                   "reuse_of_existing_patterns": _score(0.9, "high", "digital board + gpio bank", "Batch 1")},
           next_step="limited-scope design attempt when a concrete need exists"),
        _c("LC-2", "logic_capture", "PIO-based capture (Pico PIO)",
           "RP2040 PIO for tighter capture timing",
           readiness="blocked_by_validation_capability",
           blockers=["timing VALIDATION requires an external analyzer/scope first"],
           forbidden=["logic-analyzer-class claims without measured timing evidence"],
           val_path="validation_blocked", cal_path="calibration_blocked",
           scores={"capability_fit": _score(0.65, "medium", "PIO can sample fast; UNVERIFIED", "none")},
           next_step="needs external timing evidence path first"),
        _c("LC-3", "logic_capture", "external COTS logic analyzer",
           "COTS LA through the adapter layer", boards=0,
           readiness="ready_for_compose_attempt",
           val_path="validation_ready_with_cots", cal_path="cots_verifiable",
           scores={"capability_fit": _score(0.85, "high", "real timing today", "COTS spec")},
           next_step="COTS-first for anything timing-critical"),
    ],
    "stimulus_funcgen": [
        _c("STM-1", "stimulus_funcgen", "reduced-scope: DC setpoint + slow ramp source",
           "I2C DAC (needs ingestion) for DC/slow stimulus — NOT a function generator",
           parts=["MCP4725-class DAC (ingestion previously validated the footprint fix)"],
           readiness="blocked_by_missing_ingestion",
           blockers=["DAC not approved into the library yet"],
           forbidden=["function-generator-class amplitude/frequency/distortion claims"],
           val_path="validation_ready_with_cots", cal_path="cots_verifiable",
           scores={"capability_fit": _score(0.55, "high", "honest DC/slow stimulus", "ingest test"),
                   "bom_availability": _score(0.7, "medium", "MCP4725 ingests clean (test suite)", "test_ingest")},
           next_step="approve MCP4725 into library -> limited compose attempt"),
        _c("STM-2", "stimulus_funcgen", "external COTS function generator",
           "COTS funcgen through the adapter layer", boards=0,
           readiness="ready_for_compose_attempt",
           val_path="validation_ready_with_cots", cal_path="cots_verifiable",
           scores={"capability_fit": _score(0.9, "high", "real waveforms today", "COTS spec")},
           next_step="COTS-first for real waveform needs"),
        _c("STM-3", "stimulus_funcgen", "Pico PWM + RC filter",
           "zero-new-parts PWM DAC — very limited",
           readiness="design_attempt_candidate",
           forbidden=["any waveform-quality claim without measurement"],
           val_path="validation_ready_with_cots", cal_path="sanity_checkable",
           scores={"capability_fit": _score(0.35, "high", "crude but free", "Pico"),
                   "schedule_risk": _score(0.95, "high", "no new parts", "n/a")},
           next_step="only as a bring-up convenience"),
    ],
    "rf_50ohm": [
        _c("RF-1", "rf_50ohm", "external-tool-first: SMA breakout + external VNA",
           "passive SMA breakout; ALL RF characterization external",
           readiness="blocked_by_external_tool_requirement",
           blockers=["no VNA/S-parameter capability internally (honest since Phase 12)"],
           forbidden=["impedance guarantee", "RF performance claims"],
           val_path="validation_ready_with_cots", cal_path="externally_calibratable",
           scores={"capability_fit": _score(0.6, "medium", "estimate-only traces + external test", "IPC-2141")},
           next_step="external-tool-first stands; board only when a VNA path exists"),
        _c("RF-2", "rf_50ohm", "internal RF measurement", "internal RF metrology",
           readiness="do_not_build",
           hard_blockers=["do_not_build", "external_si_pi_required_unavailable"],
           forbidden=["any RF accuracy claim"],
           val_path="validation_unsupported", cal_path="calibration_blocked",
           scores={"capability_fit": _score(0.2, "low", "no internal RF path exists", "Phase 12/13")},
           next_step="HOLD"),
        _c("RF-3", "rf_50ohm", "50-ohm advisory routing on existing boards",
           "keep the advisory-only microstrip capability; no dedicated board",
           boards=0, readiness="ready_for_compose_attempt",
           forbidden=["guaranteed impedance"],
           val_path="validation_ready_mock_only", cal_path="not_calibratable",
           scores={"capability_fit": _score(0.5, "high", "already exists, advisory-only", "advanced routing")},
           next_step="status quo"),
    ],
    "relay_matrix_expansion": [
        _c("RMX-1", "relay_matrix_expansion", "second 4-channel board on the backplane "
           "(slot straps make duplicates work)",
           "reuse the PROVEN relay v2.1 design as-is; slot straps give unique IDs",
           parts=["all proven"], readiness="ready_for_reviewed_order_package",
           val_path="validation_ready_with_cots", cal_path="cots_verifiable",
           scores={"capability_fit": _score(0.8, "high", "8 channels total via 2 boards", "relay v2.1"),
                   "reuse_of_existing_validated_boards": _score(1.0, "high", "identical design", "fl1-core-relay-v21"),
                   "schedule_risk": _score(0.95, "high", "zero new design", "n/a")},
           next_step="order more of the SAME board when channel count demands"),
        _c("RMX-2", "relay_matrix_expansion", "8-relay single board (595 cascade)",
           "double the relays with a second 74HC595 in cascade",
           readiness="ready_for_compose_attempt",
           blockers=["larger board; coil current budget check needed"],
           val_path="validation_ready_with_cots", cal_path="cots_verifiable",
           scores={"capability_fit": _score(0.85, "high", "denser channels", "relay pattern"),
                   "reuse_of_existing_patterns": _score(0.9, "high", "cascade is standard", "74HC595")},
           next_step="compose attempt when >4 channels per slot needed"),
        _c("RMX-3", "relay_matrix_expansion", "analog mux instead of relays",
           "solid-state mux for signal-level switching",
           parts=["TMUX-class (ingests clean per test suite, not approved)"],
           readiness="blocked_by_missing_ingestion",
           forbidden=["low-leakage/precision switching claims without measurement"],
           val_path="validation_ready_with_cots", cal_path="cots_verifiable",
           scores={"capability_fit": _score(0.7, "medium", "fast, no coil power; limits vs relays", "TMUX ingest test")},
           next_step="approve TMUX into library when signal-level-only switching suffices"),
    ],
    "calibration_expansion": [
        _c("CALX-1", "calibration_expansion", "multi-point reference board "
           "(divider ladder on the proven chain)",
           "extend the proven REF3025+divider+ADS1115 chain with a tapped ladder for "
           "multiple known nodes",
           parts=["all proven"], readiness="ready_for_compose_attempt",
           cal_paths=["extends the internal calibration chain"],
           forbidden=["accuracy claims without traceable external calibration"],
           val_path="validation_ready_with_internal_reference", cal_path="internally_calibratable",
           scores={"capability_fit": _score(0.75, "high", "more cal points, same parts", "cal board v2"),
                   "reuse_of_existing_validated_boards": _score(0.95, "high", "direct extension", "fl1-cal-board-v4")},
           next_step="AFTER the base cal board is physical + verified"),
        _c("CALX-2", "calibration_expansion", "precision multi-reference (new parts)",
           "multiple reference ICs at different voltages",
           parts=["additional REF30xx values (need ingestion approval)"],
           readiness="blocked_by_missing_ingestion",
           val_path="validation_ready_with_internal_reference", cal_path="externally_calibratable",
           scores={"capability_fit": _score(0.8, "medium", "better coverage; more sourcing", "ingest")},
           next_step="defer to after CALX-1"),
        _c("CALX-3", "calibration_expansion", "external calibrator only",
           "send boards out / use external calibrated sources", boards=0,
           readiness="ready_for_compose_attempt",
           val_path="validation_ready_with_cots", cal_path="externally_calibratable",
           scores={"capability_fit": _score(0.7, "high", "traceable but slow/manual", "n/a")},
           next_step="the traceability ANCHOR regardless of internal boards"),
    ],
}


def search(target):
    """Rank a target's candidates. Hard blockers dominate; blocked candidates are
    listed but never recommended."""
    cands = TARGETS.get(target, [])
    ranked = sorted(cands, key=lambda c: (bool(c["hard_blockers"]),
                                          -aggregate(c)["aggregate"]))
    viable = [c for c in ranked if not c["hard_blockers"]]
    return {
        "target": target,
        "candidates": [{**c, "aggregate": aggregate(c)} for c in ranked],
        "rejected": [c["candidate_id"] for c in ranked if c["hard_blockers"]],
        "hard_blockers": {c["candidate_id"]: c["hard_blockers"]
                          for c in ranked if c["hard_blockers"]},
        "recommended": viable[0]["candidate_id"] if viable else None,
        "recommended_next_action": viable[0]["recommended_next_step"] if viable else "hold",
    }


def partitioning_search():
    """Board partitioning comparison for the FL-1 instrument stack."""
    options = [
        {"option": "backplane + plugin modules (CURRENT DIRECTION)",
         "connector_complexity": "medium (bus v2 2x07 per slot)",
         "board_count": "1 backplane + N modules", "bringup": "per-module, isolated",
         "validation": "per-module workflows exist", "calibration_chain":
         "cal board serves the whole stack over the shared bus",
         "risk_isolation": "high (a bad module doesn't kill the stack)",
         "repairability": "high", "future_expansion": "8 slots per segment",
         "verdict": "SELECTED — matches Batch 1 + slot straps"},
        {"option": "single mega-board",
         "connector_complexity": "low", "board_count": "1",
         "bringup": "all-or-nothing", "risk_isolation": "none",
         "verdict": "rejected: one fine-pitch failure would hold everything"},
        {"option": "controller + daughtercards",
         "verdict": "equivalent to backplane+modules at this scale; revisit at higher density"},
        {"option": "external COTS + adapter board only",
         "verdict": "valid interim (EII-1); not a replacement for internal calibration path"},
        {"option": "mock-only",
         "verdict": "development only — never physical evidence"},
    ]
    relationships = [
        {"pair": "DMM-lite <-> Calibration/Reference",
         "partition": "separate boards; DMM-lite calibrates AGAINST the cal board over the bus",
         "why": "cal chain isolation + the cal board is also the ID/traceability anchor"},
        {"pair": "power monitor <-> Calibration/Reference",
         "partition": "separate; monitor is cots_verifiable without the cal board",
         "why": "no hard dependency; internal cal improves it later"},
        {"pair": "relay matrix <-> controller",
         "partition": "separate (proven); controller is bus master, matrix is a module",
         "why": "already validated as Batch 1 architecture"},
        {"pair": "external instrument adapter <-> stack",
         "partition": "own module (EII-1) on the bus",
         "why": "brings COTS evidence into the same ledger"},
    ]
    return {"options": options, "relationships": relationships}


def component_strategy():
    return {"strategies": [
        {"function": "DMM-lite ADC", "choice": "ADS1115 (ingested, routed, fanout-proven)",
         "alternatives": ["24-bit sigma-delta (needs ingestion, better res, unproven route)"],
         "rule": "proven part first; upgrade only with a calibration path"},
        {"function": "stimulus DAC", "choice": "MCP4725-class (ingest-clean, needs approval)",
         "alternatives": ["Pico PWM+RC (free, crude)", "COTS funcgen (real waveforms)"],
         "rule": "COTS for waveform quality; DAC for DC/slow setpoints"},
        {"function": "current sense", "choice": "INA-class (NEEDS ingestion — the gate)",
         "alternatives": ["shunt + ADS1115 differential (proven parts, lower accuracy)"],
         "rule": "shunt+ADS1115 is buildable TODAY; INA after ingestion"},
        {"function": "switch expansion", "choice": "second relay board (zero new design)",
         "alternatives": ["595 cascade 8-relay", "TMUX solid-state (ingest-clean, unapproved)"],
         "rule": "duplicate the proven board first"},
        {"function": "logic capture", "choice": "Pico GPIO/PIO (proven, honest event-class)",
         "alternatives": ["FPGA (no ingestion, no toolchain claim)", "COTS LA (real timing)"],
         "rule": "COTS for timing truth; Pico for event capture"},
        {"function": "external instrument link", "choice": "Pico USB/serial (proven)",
         "alternatives": ["Ethernet PHY (needs ingestion)"],
         "rule": "USB/serial first"},
    ]}


def roadmap():
    return {
        "version": "v1",
        "after_batch1": [
            {"rank": 1, "board": "External Instrument Interface (EII-1)",
             "why": "lowest risk, all parts proven, 80% reuse of digital v2.1, brings COTS "
                    "evidence into the FL-1 ledger",
             "needs": "nothing new — compose-ready", "when": "after Batch 1 order decision"},
            {"rank": 2, "board": "Power/Current monitor — shunt+ADS1115 variant OR after "
                     "INA ingestion",
             "why": "high value, cots_verifiable; the shunt+ADS1115 variant is buildable today",
             "needs": "INA-class ingestion for the better variant", "when": "next design cycle"},
            {"rank": 3, "board": "DMM-lite (DMM-1)",
             "why": "reuses the cal-board chain; internally_calibratable",
             "needs": "Calibration/Reference board PHYSICAL + verified first",
             "when": "after cal board bring-up"},
            {"rank": 4, "board": "Relay expansion (RMX-1: duplicate boards)",
             "why": "zero design work thanks to slot straps", "needs": "channel demand",
             "when": "on demand"},
        ],
        "stay_external_cots": ["oscilloscope-class capture", "function-generator-class "
                               "waveforms", "logic-analyzer-class timing", "RF characterization"],
        "stay_mock_only": ["50-ohm advisory routing checks"],
        "deferred": ["scope-lite internal (do_not_build stands)", "Ethernet/LXI bridge",
                     "24-bit ADC DMM", "FPGA logic capture"],
        "ingestion_needed": ["INA-class current monitor", "MCP4725 DAC approval",
                             "TMUX analog mux approval"],
        "validation_capability_needed": ["external timing evidence path (for any PIO "
                                         "capture claim)"],
        "calibration_capability_needed": ["Calibration/Reference board fabricated + "
                                          "verified -> unlocks internally_calibratable"],
        "external_tools_required": ["VNA for RF", "calibrated external references for "
                                    "traceability anchoring"],
        "rule": "build the boards the evidence system says are safe; keep everything "
                "else external, mock, or held",
    }
