"""Phase 22 — Physical Build + Fleet Learning Loop v1.

The learning system that will ingest physical evidence later. Today it ingests
what actually exists: generated jobs, routed boards, DRC/ERC results, blockers.
Structural rules, enforced in code:
  - simulated evidence can NEVER satisfy a physical evidence gate
  - failed evidence is preserved, never deleted
  - patterns are never physically promoted without physical evidence
  - no yield data, physical validation, or production readiness is invented
"""

EVIDENCE_TYPES = (
    "design_generated", "schematic_generated", "layout_generated", "DRC_result",
    "ERC_result", "routing_result", "role_completeness_result",
    "fabrication_decision", "capability_check", "architecture_plan",
    "manufacturing_package_audit", "human_review", "supplier_quote",
    "order_record", "incoming_inspection", "board_power_on", "board_bringup",
    "system_assembly", "validation_run", "COTS_instrument_measurement",
    "calibration_result", "failure_report", "rework_report", "yield_record",
    "field_failure", "RevB_recommendation", "RevC_costdown_recommendation")

PHYSICAL_ONLY_TYPES = {"incoming_inspection", "board_power_on", "board_bringup",
                       "system_assembly", "COTS_instrument_measurement",
                       "calibration_result", "yield_record", "field_failure"}

_counter = [0]


def make_evidence(board_job_id, board_family, evidence_type, status,
                  simulated_or_physical, source, claims_supported=None,
                  claims_blocked=None, notes="", artifacts=None):
    assert evidence_type in EVIDENCE_TYPES, evidence_type
    assert simulated_or_physical in ("simulated", "physical", "generated")
    _counter[0] += 1
    return {"evidence_id": "EV-%05d" % _counter[0],
            "board_job_id": board_job_id, "board_family": board_family,
            "design_revision": "v1", "source": source,
            "evidence_type": evidence_type,
            "timestamp": "run-time stamped by the ledger writer",
            "actor": "compose",
            "simulated_or_physical": simulated_or_physical,
            "artifact_links": artifacts or [],
            "status": status,  # pass / fail / unknown
            "claims_supported": claims_supported or [],
            "claims_blocked": claims_blocked or [],
            "confidence": "high" if simulated_or_physical == "physical" else
                          "design-time only",
            "notes": notes}


def satisfies_physical(evidence):
    """The gate: only physical evidence satisfies physical requirements."""
    return evidence["simulated_or_physical"] == "physical"


# ---- fleet memory ---------------------------------------------------------------
MEMORY_CATEGORIES = ("component_memory", "footprint_memory", "routing_memory",
                     "fabrication_memory", "pattern_memory", "validation_memory",
                     "manufacturing_memory", "supplier_memory", "failure_memory",
                     "claim_memory", "cost_memory", "yield_memory")


def empty_fleet_memory():
    m = {c: [] for c in MEMORY_CATEGORIES}
    m["yield_memory"] = []  # stays EMPTY until real yield data exists
    return m


# ---- failure taxonomy -----------------------------------------------------------
FAILURES = [
    # (class, detection, severity, blocks_build, blocks_production, needs_physical)
    ("missing_component_model", "capability check", "medium", True, True, False),
    ("missing_footprint", "capability check", "medium", True, True, False),
    ("missing_layout_primitive", "capability check", "medium", True, True, False),
    ("missing_routing_capability", "router/fanout", "high", True, True, False),
    ("DRC_failure", "DRC gate", "high", True, True, False),
    ("ERC_failure", "ERC gate", "high", True, True, False),
    ("unrouted_nets", "router", "high", True, True, False),
    ("role_incomplete", "role checker", "high", True, True, False),
    ("fabrication_class_unproven", "fabrication engine", "high", True, True, False),
    ("stackup_unproven", "fabrication engine", "medium", True, True, False),
    ("connector_orientation_risk", "orientation checker", "medium", False, True, False),
    ("pullup_ownership_error", "I2C checker", "medium", False, True, False),
    ("power_tree_error", "power budget", "high", True, True, False),
    ("thermal_unknown", "thermal concept", "medium", False, True, True),
    ("safety_unknown", "safety model", "high", False, True, True),
    ("RF_unknown", "RF policy", "medium", False, True, True),
    ("high_speed_SI_unknown", "SI policy", "high", True, True, True),
    ("external_solver_required", "fabrication engine", "medium", True, True, False),
    ("manufacturing_package_incomplete", "package audit", "medium", True, True, False),
    ("supplier_substitution_risk", "sourcing model", "medium", False, True, False),
    ("incoming_inspection_failure", "inspection", "high", False, True, True),
    ("solder_defect", "inspection/AOI", "high", False, True, True),
    ("wrong_part_installed", "inspection", "high", False, True, True),
    ("bringup_failure", "bring-up workflow", "high", False, True, True),
    ("validation_failure", "validation workflow", "high", False, True, True),
    ("calibration_failure", "calibration workflow", "medium", False, True, True),
    ("yield_failure", "yield tracking", "high", False, True, True),
    ("field_failure", "field reports", "high", False, True, True),
    ("unknown_failure", "any", "high", False, True, True),
]


def failure_taxonomy():
    return [{"failure_class": c, "detection_source": d, "severity": s,
             "blocks_buildability": bb, "blocks_production_readiness": bp,
             "requires_physical_evidence": ph,
             "next_action": "unblock the named capability" if bb else
                            "gather the named evidence"}
            for c, d, s, bb, bp, ph in FAILURES]


# ---- pattern learning -----------------------------------------------------------
PATTERN_STATES = ("candidate", "proven_in_generated_design",
                  "proven_in_routed_board", "proven_in_manufacturing_package",
                  "proven_in_physical_first_article", "proven_in_repeated_builds",
                  "deprecated", "blocked")

PHYSICAL_STATES = {"proven_in_physical_first_article", "proven_in_repeated_builds"}


def promote(current_state, target_state, evidence):
    """Promotion is gated: physical states require PHYSICAL evidence; failed
    evidence demotes instead. Returns (new_state, reason)."""
    if evidence["status"] == "fail":
        return ("candidate" if current_state in PHYSICAL_STATES else current_state,
                "failed evidence demotes/holds — preserved in failure_memory")
    if target_state in PHYSICAL_STATES and not satisfies_physical(evidence):
        return (current_state,
                "REFUSED: %s requires physical evidence; got %s" %
                (target_state, evidence["simulated_or_physical"]))
    order = list(PATTERN_STATES)
    if order.index(target_state) - order.index(current_state) > 1 \
            and target_state not in ("deprecated", "blocked"):
        return (current_state, "REFUSED: no skipping states silently")
    return (target_state, "promoted with evidence %s" % evidence["evidence_id"])


# ---- capability gaps ------------------------------------------------------------
GAPS = [
    # (capability, status, boards_unlocked, families, complexity 1-5)
    ("USB-C connector + protection pattern", "missing_footprint",
     ["USB-C power monitor", "consumer devices", "modern power inputs"],
     ["power_monitor", "consumer_device", "sensor_board"], 2),
    ("SMA / RF connector footprint", "missing_footprint",
     ["RF adapter (passive)"], ["RF_frontend_or_adapter"], 1),
    ("gate-driver + power-stage primitives", "missing_component_model",
     ["24V motor controller", "DUT power control", "power supplies"],
     ["motor_controller", "power_supply_or_regulator"], 4),
    ("QFN-56 quadrant escape", "blocked_by_qfn56_escape",
     ["bare RP2040 core", "monolithic cost-down", "most modern MCUs/sensors in QFN"],
     ["MCU_carrier", "mixed_signal", "sensor_board"], 4),
    ("bare RP2040 core test board", "blocked (depends on QFN-56 escape)",
     ["productized FL-1 cards", "cost-down monolith"], ["MCU_carrier"], 3),
    ("controlled impedance advisory -> modeled", "advisory_only",
     ["better RF/high-speed guidance"], ["RF_frontend_or_adapter",
                                         "high_speed_digital"], 3),
    ("external SI/PI integration", "external_solver_required",
     ["PCIe capture", "DDR carriers"], ["high_speed_digital"], 5),
    ("HDI / microvia rules", "blocked",
     ["AI accelerator carrier", "dense SoC boards"],
     ["AI_accelerator_carrier", "high_speed_digital"], 5),
    ("large BGA escape", "blocked",
     ["AI accelerator carrier", "FPGA carriers"],
     ["AI_accelerator_carrier"], 5),
    ("space qualification evidence model", "no_qualification_path",
     ["satellite watchdog beyond bench claims"],
     ["space_or_high_reliability"], 3),
]


def gap_ranking():
    ranked = []
    for cap, status, boards, fams, cx in GAPS:
        score = round(len(boards) * 2 + len(fams) * 3 - cx * 1.5, 1)
        ranked.append({"capability": cap, "current_status": status,
                       "boards_unlocked": boards, "families_unlocked": fams,
                       "implementation_complexity_1to5": cx,
                       "priority_score": score,
                       "next_action": "build + prove on a benchmark board"
                       if cx <= 3 else "dedicated capability phase"})
    ranked.sort(key=lambda r: -r["priority_score"])
    return ranked


# ---- benchmark selector ---------------------------------------------------------
BENCH = [
    ("battery environmental sensor", "buildable_with_review", 0.9, 0.9, 0.6, 0.95,
     "proves non-FL-1 generalization on the cheapest possible board"),
    ("Raspberry Pi HAT relay controller", "buildable_with_review", 0.9, 0.85, 0.7,
     0.9, "proven relay pattern in a NON-FL-1 mechanical format (HAT outline)"),
    ("USB-C power monitor", "architecture_only (USB-C primitive first)", 0.4, 0.8,
     0.8, 0.7, "unlocks after the USB-C connector/protection primitive"),
    ("RF adapter (passive)", "architecture_only (SMA footprint first)", 0.4, 0.5,
     0.5, 0.5, "cheap unlock but narrow value; advisory impedance only"),
    ("bare RP2040 core", "blocked (QFN-56 escape first)", 0.2, 0.9, 0.9, 0.8,
     "highest strategic value, hardest prerequisite"),
    ("24V motor controller", "blocked (power-stage primitives)", 0.1, 0.7, 0.3, 0.5,
     "safety risk + missing primitives — NOT near-term"),
    ("PCIe capture", "architecture_only (external SI/PI)", 0.05, 0.6, 0.2, 0.3,
     "NOT near-term"),
    ("AI accelerator carrier", "blocked (HDI/BGA/SI-PI)", 0.02, 0.7, 0.1, 0.2,
     "NOT near-term"),
]


def benchmark_selector():
    rows = []
    for name, status, buildability, value, coverage, regression, note in BENCH:
        score = round(buildability * 0.4 + value * 0.25 + coverage * 0.15 +
                      regression * 0.2, 3)
        rows.append({"candidate": name, "status": status, "score": score,
                     "note": note})
    rows.sort(key=lambda r: -r["score"])
    return {"ranked": rows, "recommendation": rows[0]["candidate"],
            "runner_up": rows[1]["candidate"],
            "excluded_near_term": [r["candidate"] for r in rows
                                   if r["score"] < 0.4],
            "rule": "benchmarks must be low-safety-risk, cheap, and prove "
                    "non-FL-1 generalization; blocked boards are never "
                    "near-term benchmarks"}
