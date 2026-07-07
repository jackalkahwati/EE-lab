"""Phase 22.2 — Just-in-Time Primitive Acquisition Engine v1.

When a design needs a missing primitive, Compose acquires or synthesizes a
CANDIDATE from trusted sources (KiCad libraries, datasheets via the proven
resolve_part/source_part ingestion path, reference designs), quarantines it,
verifies it, and assigns an evidence state. Candidates are never trusted like
proven primitives: gate functions in this module make that structural.

The junior-EE-with-a-strict-reviewer model:
  fast    - candidates on demand
  honest  - candidate/review-required until evidence
  reusable - checked primitives join the library
  learning - failures demote
"""

GAP_TYPES = ("component_model", "schematic_symbol", "footprint", "pin_map",
             "package_model", "layout_primitive", "routing_rule",
             "reference_circuit", "protection_pattern", "validation_workflow",
             "manufacturing_rule", "claim_gate")

EVIDENCE_STATES = ("missing", "candidate_from_text", "candidate_from_datasheet",
                   "candidate_from_reference_design", "candidate_from_library_import",
                   "symbol_supported", "footprint_supported_with_review",
                   "schematic_supported_with_review", "layout_supported_with_review",
                   "routed_in_sandbox", "manufacturing_package_supported_with_review",
                   "physically_validated", "repeatedly_validated",
                   "deprecated", "blocked")

CANDIDATE_STATES = {"candidate_from_text", "candidate_from_datasheet",
                    "candidate_from_reference_design", "candidate_from_library_import"}
PHYSICAL_STATES = {"physically_validated", "repeatedly_validated"}

HIGH_RISK_CLAIMS = ("production_ready", "safety_compliant", "medical_ready",
                    "space_ready", "RF_compliant", "high_speed_validated",
                    "USB_certified", "battery_safety_validated")

ACQUISITION_SOURCES = ("existing_compose_library", "kicad_library_import",
                       "manufacturer_footprint", "third_party_footprint",
                       "datasheet_extraction (resolve_part/source_part — the "
                       "proven ingestion path)", "reference_design",
                       "generated_from_dimensions")


def can_support_claim(state, claim):
    """Gate: what a primitive at `state` may support. Structural, not advisory."""
    if claim in HIGH_RISK_CLAIMS:
        return state in PHYSICAL_STATES and claim == "production_ready" and False \
            or (state == "repeatedly_validated" and claim not in
                ("medical_ready", "space_ready"))  # even then: separate qualification
    if claim in ("routed", "DRC_clean", "ERC_clean"):
        return state in ("routed_in_sandbox",
                         "manufacturing_package_supported_with_review") \
            or state in PHYSICAL_STATES
    if claim == "schematic_generated":
        return state not in ("missing", "blocked", "deprecated")
    if claim == "first_article_ready_with_review":
        return state in ("manufacturing_package_supported_with_review",) \
            or state in PHYSICAL_STATES
    return False


def satisfies_physical(state):
    return state in PHYSICAL_STATES


def promote(current, target, evidence_kind, status="pass"):
    """evidence_kind in {'library_import','datasheet','sandbox_route',
    'manufacturing_package','physical_test','repeat_builds'}."""
    if status == "fail":
        return ("deprecated" if current in PHYSICAL_STATES else
                "candidate_from_library_import" if current not in CANDIDATE_STATES
                and current != "missing" else current,
                "failed evidence demotes; failure preserved")
    if target in PHYSICAL_STATES and evidence_kind not in ("physical_test",
                                                           "repeat_builds"):
        return current, ("REFUSED: %s requires physical evidence, got %s"
                         % (target, evidence_kind))
    if target == "routed_in_sandbox" and evidence_kind != "sandbox_route":
        return current, "REFUSED: routed_in_sandbox requires a sandbox route"
    return target, "promoted (%s)" % evidence_kind


def verify_footprint(pinmap_pins, footprint_meta):
    """The footprint gate. footprint_meta keys: pad_count, pitch_mm,
    datasheet_pitch_mm, has_courtyard, has_pin1_marker, silk_clear, source."""
    problems = []
    if footprint_meta.get("pad_count") != pinmap_pins:
        problems.append("pad count %s != pin map %s — BLOCKS primitive"
                        % (footprint_meta.get("pad_count"), pinmap_pins))
    dp = footprint_meta.get("datasheet_pitch_mm")
    if dp and abs(footprint_meta.get("pitch_mm", 0) - dp) > 0.01:
        problems.append("pitch mismatch vs datasheet — BLOCKS primitive")
    if not footprint_meta.get("has_courtyard"):
        problems.append("no courtyard — review required")
    if not footprint_meta.get("has_pin1_marker"):
        problems.append("missing pin-1 marker — BLOCKS automatic use")
    if not footprint_meta.get("silk_clear", True):
        problems.append("silk overlaps pads — review required")
    blocked = any("BLOCKS" in p for p in problems)
    state = "blocked" if blocked else "footprint_supported_with_review"
    if footprint_meta.get("source") == "third_party_footprint" and not blocked:
        state = "footprint_supported_with_review"  # never auto-trusted
    return {"state": state, "problems": problems,
            "note": "third-party and generated footprints are NEVER fully "
                    "trusted automatically"}


def pinmap_gate(pins):
    """pins = [{name, number, kind}]; kind in power/ground/signal/nc/unknown."""
    unknown = [p["number"] for p in pins if p.get("kind") == "unknown"]
    no_pwr = not any(p.get("kind") == "power" for p in pins)
    no_gnd = not any(p.get("kind") == "ground" for p in pins)
    problems = []
    if unknown:
        problems.append("unknown pins %s BLOCK automatic use" % unknown)
    if no_pwr or no_gnd:
        problems.append("power/ground pins must be explicit — BLOCKS")
    return {"ok": not problems, "problems": problems,
            "confidence": "low" if unknown else "library/datasheet"}


def runtime_workflow():
    return {"steps": [
        "1 gap detector identifies the missing primitive",
        "2 acquisition source selected (trust-ordered)",
        "3 datasheet/library/reference design ingested (resolve_part path)",
        "4 symbol + pin map generated (pinmap_gate)",
        "5 footprint acquired or generated (verify_footprint)",
        "6 reference circuit extracted (advisory until checked)",
        "7 claim gates created (can_support_claim)",
        "8 sandbox test board generated when appropriate",
        "9 evidence state assigned",
        "10 board job updated with the primitive's state + review flags"],
        "outcomes": ["primitive_ready_with_review", "primitive_candidate_only",
                     "primitive_blocked", "board_can_continue_with_review",
                     "board_architecture_only", "board_blocked"]}
