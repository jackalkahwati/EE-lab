"""Phase 23.4 — layer-count decision model v2 + 2-layer eligibility checker +
low-cost fabrication optimizer. 2-layer is a GATED candidate flow: routed
clean is never physical validation, cost numbers are placeholders until
quotes, and the 4-layer fallback always remains.
"""

DECISION_STATES = ("2_layer_candidate", "2_layer_attempt_allowed",
                   "2_layer_routed_clean", "2_layer_failed_with_reason",
                   "stay_4_layer", "requires_4_layer", "consider_6_layer_later",
                   "blocked_by_density", "blocked_by_noise_or_grounding",
                   "blocked_by_power_integrity", "blocked_by_unproven_fabrication",
                   "architecture_only")


def eligibility(board):
    """board: dict with keys net_count, component_count, fine_pitch,
    precision_analog, high_current, rf, high_speed, measurement_grounding,
    fl1_reviewed (bool: FL-1 board needing explicit review). Returns
    (state, reasons)."""
    reasons = []
    if board.get("rf"):
        return "not_eligible", ["RF requires impedance/ground control — 4-layer+ "
                                "and external validation"]
    if board.get("high_speed"):
        return "not_eligible", ["high-speed requires reference planes + SI"]
    if board.get("high_current"):
        return "not_eligible", ["high-current thermal/copper rules missing"]
    if board.get("medical"):
        return "not_eligible", ["medical/implantable blocked entirely"]
    if board.get("precision_analog") or board.get("measurement_grounding"):
        return "not_eligible", ["measurement/reference stability argues for the "
                                "continuous inner GND plane — stay 4-layer"]
    if board.get("fl1_reviewed"):
        return "not_eligible", ["FL-1 board: layer change requires explicit "
                                "human review, not automatic downgrade"]
    if board.get("net_count", 99) > 20 or board.get("component_count", 99) > 40:
        return "not_eligible", ["density: routing congestion risk on 2 layers"]
    if board.get("fine_pitch"):
        reasons.append("fine-pitch present — allowed WITH REVIEW (fanout "
                       "dogbones reach the B.Cu pour)")
        reasons.append("low net/component count")
        return "eligible_with_review", reasons
    reasons += ["low net count", "low component count", "no high-speed/RF",
                "no high-current", "no precision analog",
                "ground pour strategy sufficient (F+B pours + stitching)"]
    return "eligible", reasons


PROFILE = {
    "layers": ["F.Cu", "B.Cu"],
    "vias": "through only (no HDI, no microvia, no blind/buried)",
    "material": "standard FR-4, 1.6mm",
    "ground_strategy": "GND pours on BOTH outer layers + through-via stitching; "
                       "no internal planes exist",
    "power_strategy": "+3V3 and +5V are ROUTED nets (no PWR plane); power "
                      "traces review-required when current unknown",
    "min_trace_space": "0.2/0.2mm (0.13 fine-pitch class where fanout demands)",
    "copper_pour": "GND only; pour continuity reviewed per board",
    "blocked_claims": ["controlled_impedance", "RF", "high_speed",
                       "precision_analog_grounding", "physical_validation",
                       "production_ready", "cheapest_without_quotes"],
    "review": "every 2-layer board is review-required; all DRC/ERC gates active",
}


def compare(pairs):
    """pairs: list of dicts with run_4l/run_2l facts. Emits the comparison."""
    rows = []
    for p in pairs:
        ok2 = p.get("routed_2l") and p.get("drc_2l", 1) == 0
        rows.append({
            **p,
            "recommended": "prefer_2_layer_with_review" if ok2 else
                           ("2_layer_failed_keep_4_layer" if p.get("attempted")
                            else "not_eligible_for_2_layer"),
            "cost_delta": "ESTIMATE/PLACEHOLDER: 2-layer fab typically 30-50% "
                          "cheaper at prototype quantity — REAL QUOTES REQUIRED "
                          "before any cost claim",
            "risk_delta": "no inner GND plane: noise margin reduced — "
                          "review-required; physical behavior unmeasured"})
    return rows


def optimizer(board_kind, eligible_state, routed_2l_clean):
    if eligible_state == "not_eligible":
        return {"build_type": "standard_4layer_with_review",
                "reason": "2-layer not eligible for this board class"}
    if routed_2l_clean:
        return {"build_type": "low_cost_2layer_with_review",
                "reason": "2-layer routed clean through all gates; cost values "
                          "remain placeholders until quotes",
                "fallback": "known-good 4-layer package remains available"}
    return {"build_type": "quote_required",
            "reason": "eligible but not yet routed clean on 2 layers"}
