"""Phase 23.6 — First Physical Evidence Loop v1.

The state model, promotion gate, and ingestion rules that turn ONE real board
into real physical validation evidence. Structural rules:
  - nothing past package_ready_with_review without human approval or
    real-world evidence
  - simulated evidence never satisfies the physical gate
  - photos alone are never electrical validation
  - one physical pass promotes ONLY the tested scope — never production_ready
  - the ledger starts EMPTY: no fake evidence, no placeholder passes
"""

EVIDENCE_STATES = ("design_generated", "routed_clean", "package_ready_with_review",
                   "human_approved_for_quote", "quote_requested", "quote_received",
                   "human_approved_for_order", "ordered", "fabricated", "received",
                   "visually_inspected", "electrically_tested",
                   "physically_validated", "failed_physical_validation",
                   "deprecated")

HUMAN_GATED = {"human_approved_for_quote": "human approval (signature)",
               "quote_requested": "human approval precedes any quote request",
               "human_approved_for_order": "human approval (signature)",
               "ordered": "human approval + order evidence"}
EVIDENCE_GATED = {"fabricated": "order/fab evidence",
                  "received": "receipt evidence (photos + log)",
                  "visually_inspected": "inspection checklist evidence",
                  "electrically_tested": "recorded measurements with units",
                  "physically_validated": "full gate pass (see promotion_gate)"}

READINESS_LADDER = ("generated", "routed_clean", "package_ready_with_review",
                    "approved_for_quote", "quoted", "approved_for_order",
                    "ordered", "received", "physically_tested",
                    "physically_validated", "pilot_ready_with_review",
                    "production_ready")

REQUIRED_FOR_PHYSICAL = ("human_approval_recorded", "fabricated_or_received",
                         "visual_inspection_pass", "continuity_pass",
                         "power_test_pass", "led_indicator_pass",
                         "testpoint_voltage_pass", "divider_measurement_pass",
                         "no_unresolved_safety_issue",
                         "no_unresolved_drc_erc_mfg_issue",
                         "signed_adjudication")


def advance(current, target, human_approval=False, evidence=None):
    """State machine: refuse transitions lacking approval/evidence."""
    order = list(EVIDENCE_STATES)
    if target in ("failed_physical_validation", "deprecated"):
        return target, "failure/deprecation recorded; evidence preserved"
    if target in HUMAN_GATED and not human_approval:
        return current, "REFUSED: %s requires %s" % (target, HUMAN_GATED[target])
    if target in EVIDENCE_GATED:
        if not evidence or evidence.get("simulated"):
            return current, ("REFUSED: %s requires REAL %s" %
                             (target, EVIDENCE_GATED[target]))
    if order.index(target) > order.index("package_ready_with_review") and \
            not human_approval and target not in EVIDENCE_GATED:
        return current, "REFUSED: past package_ready needs human approval"
    return target, "advanced"


def promotion_gate(evidence_set):
    """evidence_set: dict of REQUIRED_FOR_PHYSICAL keys -> evidence dicts
    ({pass: bool, simulated: bool, has_measurement: bool, units: str,
      photo_only: bool}). Returns (ok, missing/refusals)."""
    problems = []
    for req in REQUIRED_FOR_PHYSICAL:
        ev = evidence_set.get(req)
        if not ev:
            problems.append("MISSING: %s" % req)
            continue
        if ev.get("simulated"):
            problems.append("REFUSED simulated evidence for %s" % req)
        if req in ("continuity_pass", "power_test_pass",
                   "testpoint_voltage_pass", "divider_measurement_pass"):
            if ev.get("photo_only"):
                problems.append("REFUSED: photos alone are not electrical "
                                "validation (%s)" % req)
            if ev.get("has_measurement") and not ev.get("units"):
                problems.append("REFUSED: measurement without units (%s)" % req)
            if not ev.get("has_measurement"):
                problems.append("MISSING recorded measurement for %s" % req)
        if not ev.get("pass"):
            problems.append("FAILED: %s" % req)
    return (len(problems) == 0), problems


def validate_artifact(art):
    """Ingestion rules for one evidence artifact."""
    problems = []
    for k in ("artifact_type", "board_id", "run_id", "datetime", "operator"):
        if not art.get(k):
            problems.append("missing %s (evidence must be attributable)" % k)
    if art.get("measurement_value") is not None and not art.get("units"):
        problems.append("measurement without units")
    return (len(problems) == 0), problems


def promotion_scope():
    return {
        "board": "power-entry-header (2-layer variant) — the tested article only",
        "patterns": ["led_indicator", "testpoint_cluster",
                     "voltage_divider_monitor (only if divider measurement "
                     "evidence is within review-defined tolerance)"],
        "packs": ["power_entry_pack", "testpoint_inspection_pack"],
        "flows": ["2-layer fabrication flow — SCOPED to simple boards",
                  "synthesized_subcircuit_generator — SCOPED to the structures "
                  "on this board"],
        "explicitly_not_promoted": ["any other board", "QFN capability",
                                    "production readiness", "yield",
                                    "reliability", "certification"]}
