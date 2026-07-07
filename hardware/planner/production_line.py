"""Phase 20 — production line + supply chain model for the seven-board FL-1
system. The readiness state machine is HARD-CAPPED: nothing can pass
first_article_ready_for_human_approval without physical boards, validation
evidence, yield data, and recorded human approval.
"""

READINESS_STATES = ("design_ready_for_review", "first_article_ready_for_human_approval",
                    "first_article_ordered", "first_article_received",
                    "first_article_validated", "revb_required",
                    "pilot_build_ready", "production_ready")

# components where silent substitution is FORBIDDEN (traceable review required)
PROTECTED = {
    "precision_reference": "REF3025 — accuracy-defining",
    "adc": "ADS1115 — pinout + escape designed for it",
    "shunt": "value/rating load-bearing for the current claim",
    "relay": "footprint/pinout/coil safety-relevant",
    "safety_interlock_parts": "FAULT/INTERLOCK path components",
    "board_to_backplane_connectors": "mating interface + orientation mitigations",
    "eeprom": "24LC02 address/package behavior is the identity system",
    "mcu_module": "Pico module — the validated MCU primitive",
}


def readiness_state(evidence):
    """The ONLY path to advanced states runs through physical evidence.
    evidence keys (all default False/None):
      human_approval_recorded, boards_ordered, boards_received,
      system_validation_passed_physical, yield_data_exists,
      revb_findings_open, pilot_approved, production_human_approval
    """
    e = {k: evidence.get(k) for k in
         ("human_approval_recorded", "boards_ordered", "boards_received",
          "system_validation_passed_physical", "yield_data_exists",
          "revb_findings_open", "pilot_approved", "production_human_approval")}
    if not e["human_approval_recorded"]:
        return "first_article_ready_for_human_approval"
    if not e["boards_ordered"]:
        return "first_article_ready_for_human_approval"
    if not e["boards_received"]:
        return "first_article_ordered"
    if not e["system_validation_passed_physical"]:
        return "first_article_received"
    if e["revb_findings_open"]:
        return "revb_required"
    if not e["yield_data_exists"]:
        return "first_article_validated"
    if not e["pilot_approved"]:
        return "first_article_validated"
    if not e["production_human_approval"]:
        return "pilot_build_ready"
    return "production_ready"


def current_state():
    """Today: designs done, gates green, human approval NOT recorded,
    nothing ordered."""
    return readiness_state({})
