"""M12 — Advanced Reliability / Space / Defense Classes v1. Class mapping +
gates; mission-ready claims are structurally blocked without evidence."""

CLASSES = {
    "commercial": {"derating": "none modeled", "evidence": "standard flow"},
    "industrial": {"derating": "review-required", "evidence": "extended-temp "
                   "BOM review (NOT automated)"},
    "high_reliability": {"derating": "50-70% review-required",
                         "redundancy": "human architecture decision",
                         "evidence": "IPC Class 3 fab/assembly REVIEW + lot "
                         "traceability + burn-in — ALL ABSENT"},
    "space": {"radiation": "NO modeling (TID/SEE unknown)",
              "evidence": "rad-hard parts + qualification + conformal "
              "coating review — ALL ABSENT"},
    "defense": {"evidence": "MIL-standard review + traceability + ITAR "
                "handling — ALL ABSENT (process, not code)"},
    "medical_implantable": {"evidence": "BLOCKED entirely (long-standing "
                            "gate; not a Compose claim domain)"},
}
BLOCKED = ["space_readiness", "defense_readiness", "mission_critical",
           "radiation_tolerance", "IPC_class_3", "burn_in", "derating_"
           "verified", "implantable_readiness"]


def classify_request(text):
    t = text.lower()
    for k in ("implant", "medical"):
        if k in t:
            return "medical_implantable", "blocked"
    for k in ("space", "satellite", "orbit", "leo"):
        if k in t:
            return "space", "architecture_only"
    for k in ("defense", "military", "mil-spec"):
        if k in t:
            return "defense", "architecture_only"
    for k in ("mission critical", "high reliability", "hi-rel"):
        if k in t:
            return "high_reliability", "architecture_only"
    if "industrial" in t:
        return "industrial", "review_required"
    return "commercial", "standard"
