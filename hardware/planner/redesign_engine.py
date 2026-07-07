"""Closed-loop redesign recommendation engine v1 (Phase 16 P10).

Converts failures (validation / signoff / inspection / bring-up / calibration /
fabrication) into structured Rev B recommendations. Rules:
  - a recommendation always CITES its evidence
  - Rev B is never created automatically — explicit request + human approval
  - failed Rev A evidence is preserved, never hidden
  - requirements are never silently relaxed
"""

RECOMMENDATION_TYPES = (
    "keep_design", "revise_layout", "revise_component", "revise_connector",
    "revise_test_points", "revise_silkscreen", "revise_power_protection",
    "revise_bus_topology", "revise_relay_safe_default", "revise_firmware",
    "revise_validation_workflow", "add_calibration_path", "add_reference_pattern",
    "do_not_redesign_until_external_tool", "human_review_required")

# failure class -> (recommendation type, compose can attempt, confidence)
_MAP = {
    "relay_stuck": ("revise_component", False, "medium"),
    "relay_chatter": ("revise_relay_safe_default", True, "high"),
    "relay_continuity_failure": ("revise_layout", True, "medium"),
    "safe_disconnect_failure": ("revise_relay_safe_default", True, "high"),
    "unrouted_net": ("revise_layout", True, "high"),
    "drc_violation": ("revise_layout", True, "high"),
    "erc_violation": ("revise_layout", True, "high"),
    "role_incomplete": ("revise_connector", True, "high"),
    "fine_pitch_escape_failure": ("do_not_redesign_until_external_tool", False, "high"),
    "shared_bus_failure": ("revise_bus_topology", True, "medium"),
    "power_rail_failure": ("revise_power_protection", True, "medium"),
    "current_limit_failure": ("revise_power_protection", True, "medium"),
    "board_id_read_failure": ("revise_component", True, "medium"),
    "firmware_flash_failure": ("revise_firmware", True, "medium"),
    "debug_console_failure": ("revise_firmware", True, "low"),
    "bus_test_failure": ("revise_bus_topology", True, "low"),
    "gpio_failure": ("revise_layout", True, "low"),
    "interlock_failure": ("revise_connector", True, "medium"),
    "fault_line_failure": ("revise_connector", True, "medium"),
    "trigger_sync_failure": ("revise_connector", True, "medium"),
    "measurement_out_of_range": ("add_calibration_path", False, "low"),
    "calibration_failure": ("add_calibration_path", False, "medium"),
    "manufacturing_defect": ("human_review_required", False, "low"),
    "assembly_defect": ("human_review_required", False, "low"),
    "component_substitution_issue": ("revise_component", True, "medium"),
    "missing_component": ("revise_component", True, "high"),
    "bad_symbol_or_footprint": ("revise_component", True, "high"),
    "design_intent_mismatch": ("human_review_required", False, "medium"),
    "external_instrument_error": ("keep_design", False, "high"),
    "adapter_error": ("keep_design", False, "high"),
    "operator_error": ("keep_design", False, "high"),
    "unknown_failure": ("human_review_required", False, "low"),
}


def recommend(failure):
    """One failure record -> one Rev B recommendation, evidence attached."""
    fclass = failure.get("failure_class", "unknown_failure")
    rtype, compose_fix, confidence = _MAP.get(fclass, ("human_review_required", False, "low"))
    rec = {
        "recommendation_id": "RB-%s" % failure.get("failure_id", "unknown"),
        "recommendation_type": rtype,
        "affected_board": failure.get("board_type"),
        "affected_revision": "V2/revA",
        "evidence": failure.get("evidence_links", []) or ["failure:%s" % failure.get("failure_id")],
        "reason": "%s at %s (%s): %s" % (fclass, failure.get("workflow_step"),
                                         failure.get("affected"),
                                         failure.get("suspected_cause", "unknown")),
        "confidence": confidence,
        "expected_improvement": _improvement(rtype, failure),
        "risks": ["Rev B respins cost time+money; verify root cause before commit",
                  "changed constraints must be re-run through ALL gates"],
        "required_human_review": True,       # every Rev B needs a human
        "automatic_redesign_allowed": False,  # NEVER automatic
        "compose_can_attempt_fix": compose_fix,
        "proposed_revb_changes": _changes(rtype, failure),
        "rev_a_evidence_preserved": True,
    }
    assert rec["recommendation_type"] in RECOMMENDATION_TYPES
    return rec


def _improvement(rtype, failure):
    return {
        "revise_relay_safe_default": "relays provably OFF through power-up/reset",
        "revise_layout": "clean routing/DRC at the failed area",
        "revise_component": "replace the failing part (%s)" % failure.get("affected"),
        "revise_connector": "role line physically present + testable",
        "revise_power_protection": "rail survives the failing condition",
        "revise_bus_topology": "bus enumerates every device",
        "add_calibration_path": "measurement gets a calibration route",
        "do_not_redesign_until_external_tool": "no board change helps until the missing "
                                               "capability (e.g. finer-grid fanout) exists",
        "keep_design": "no board change needed (external/operator cause)",
    }.get(rtype, "resolve the failure honestly")


def _changes(rtype, failure):
    if rtype == "keep_design":
        return []
    if rtype == "do_not_redesign_until_external_tool":
        return ["HOLD: fix the tool/capability first, then re-evaluate"]
    return ["%s: address %s (%s)" % (rtype, failure.get("affected"),
                                     failure.get("workflow_step"))]


def engine_model():
    return {"version": "v1", "recommendation_types": list(RECOMMENDATION_TYPES),
            "inputs": ["DRC/ERC reports", "benchmark/signoff reports",
                       "role-completeness reports", "first-article reviews",
                       "validation evidence ledger", "incoming inspection results",
                       "bring-up results", "calibration results", "failure taxonomy",
                       "manufacturing reports", "reference library", "pattern library"],
            "rules": ["Rev B is never created automatically",
                      "failed Rev A evidence is never hidden",
                      "requirements are never silently relaxed",
                      "simulated evidence never becomes physical evidence",
                      "every recommendation cites its evidence"]}
