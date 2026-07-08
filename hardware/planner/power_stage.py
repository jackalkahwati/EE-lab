"""M9 — High-Current / Power-Stage Rules v1.

Honest modeling and GATES for current-carrying design. Compose can size a
trace estimate and refuse a motor board; it cannot claim thermal or safety
anything. No mains/high-voltage support exists — requests are blocked.
"""

# IPC-2221 external-layer approximation, 10C rise, 1oz copper (ESTIMATE —
# review-required, never a thermal claim)
CURRENT_RULES = [
    (0.5, 0.25), (1.0, 0.5), (2.0, 1.2), (3.0, 2.0), (5.0, 4.0), (10.0, 9.0)]

REQUIRED_FOR_POWER_STAGE = (
    "mosfet_primitive_verified", "gate_driver_primitive_verified",
    "shunt_and_sense_path", "flyback_or_clamp_for_inductive",
    "fuse_or_protection", "connector_current_rating_verified",
    "copper_width_plan", "thermal_review_by_human",
    "creepage_clearance_review")

BLOCKED = ["thermal_performance", "safety_certification", "mains_voltage",
           "motor_drive_readiness", "current_rating_guarantee"]


def trace_width_estimate(amps):
    for a, w in CURRENT_RULES:
        if amps <= a:
            return {"amps": amps, "min_width_mm": w, "copper": "1oz external",
                    "basis": "IPC-2221 approximation, 10C rise — ESTIMATE, "
                             "review-required, NOT a thermal claim"}
    return {"amps": amps, "min_width_mm": None,
            "basis": "beyond modeled range — blocked, human power engineer "
                     "required"}


def power_stage_gate(present):
    missing = [r for r in REQUIRED_FOR_POWER_STAGE if not present.get(r)]
    if missing:
        return {"verdict": "blocked", "missing": missing,
                "blocked_claims": BLOCKED,
                "note": "motor/load-stage boards stay blocked until every "
                        "requirement is evidenced; no partial pass"}
    return {"verdict": "architecture_ready_for_review", "missing": [],
            "blocked_claims": BLOCKED,
            "note": "all requirements evidenced — still review-required, "
                    "still no thermal/safety claim"}


def mains_gate(voltage):
    if voltage > 48:
        return {"verdict": "blocked",
                "reason": "%sV exceeds the modeled envelope (<=48V); mains/"
                          "high voltage has NO support and NO creepage "
                          "table — human safety engineer required" % voltage}
    return {"verdict": "in_envelope_review_required", "voltage": voltage}
