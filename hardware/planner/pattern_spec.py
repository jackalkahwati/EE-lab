"""Design Pattern Spec (Phase 2) — the structured, reusable engineering pattern
extracted from a reference design. NOT a copy of a design: it captures the
reusable topology, support circuitry, layout/routing constraints, firmware hooks,
validation, and known risks, each with provenance, confidence, and LICENSE status.

Support status is never "reusable" unless the license permits reuse AND the
evidence is strong. Honesty: a pattern from a manufacturer reference is at best
`reference_only`; an unknown license is `needs_review`; weak evidence is
`needs_review`, never `reusable`.

  from pattern_spec import make_pattern, validate, derive_status
"""
from reference_manifest import can_direct_reuse, allowed_use

PATTERN_VERSION = "1.0"

# adaptation zones — what a downstream design may change vs must preserve
ZONES = ("preserve_exactly", "adapt_allowed", "remove_allowed",
         "requires_simulation", "requires_FL1_validation", "requires_human_review")

# component roles that are HIGH-RISK to change (Phase 8 §8) — swapping/altering
# these must go through review, never silent adaptation
HIGH_RISK_ROLES = ("adc", "dac", "voltage_reference", "op_amp", "feedback",
                   "protection", "grounding", "precision_passive",
                   "regulator_compensation", "rf_matching", "calibration",
                   "impedance_critical")

SUPPORT_STATUS = ("reusable", "reusable_with_review", "reference_only",
                  "needs_review", "unsupported")


def make_pattern(name, category, source_type, license_status, **kw):
    return {
        "pattern_version": PATTERN_VERSION,
        "name": name, "category": category,
        "source_type": source_type, "source_files": kw.get("source_files", []),
        "license_status": license_status,
        "allowed_use": allowed_use(license_status),
        "direct_reuse_allowed": can_direct_reuse(license_status),
        "purpose": kw.get("purpose", ""),
        "topology": kw.get("topology", ""),
        "components": kw.get("components", []),         # [{ref/role, mpn, required, zone}]
        "required_components": kw.get("required_components", []),
        "optional_components": kw.get("optional_components", []),
        "required_passives": kw.get("required_passives", []),
        "interface_pins": kw.get("interface_pins", []),
        "power": kw.get("power", {}),
        "layout_constraints": kw.get("layout_constraints", []),
        "routing_constraints": kw.get("routing_constraints", []),
        "grounding": kw.get("grounding", ""),
        "keepout": kw.get("keepout", []),
        "thermal": kw.get("thermal", ""),
        "firmware_hooks": kw.get("firmware_hooks", []),
        "test_points": kw.get("test_points", []),
        "calibration": kw.get("calibration", ""),
        "expected_performance": kw.get("expected_performance", ""),
        "known_limitations": kw.get("known_limitations", []),
        "known_failure_modes": kw.get("known_failure_modes", []),
        "manufacturing_complexity": kw.get("manufacturing_complexity", "unknown"),
        "validation_procedure": kw.get("validation_procedure", ""),
        "adaptation_zones": kw.get("adaptation_zones", {}),   # {component/aspect: zone}
        "provenance": kw.get("provenance", {}),
        "confidence": kw.get("confidence", {}),
        "support_status": "needs_review",     # derive_status sets the real value
        "unknowns": kw.get("unknowns", []),
    }


def validate(p):
    errs = []
    if not p.get("category"):
        errs.append("missing category")
    if p.get("license_status") is None:
        errs.append("missing license_status (no reuse decision possible)")
    if not p.get("components") and not p.get("topology"):
        errs.append("no components or topology extracted")
    # a pattern that claims direct reuse must actually have a permissive license
    if p.get("direct_reuse_allowed") and not can_direct_reuse(p.get("license_status")):
        errs.append("direct_reuse_allowed but license is not permissive")
    return errs


def _mean_conf(p):
    c = list(p.get("confidence", {}).values())
    return sum(c) / len(c) if c else 0.0


def derive_status(p):
    """Compute the support_status HONESTLY from license + evidence.
    License gates reuse; evidence gates confidence."""
    errs = validate(p)
    if errs or not p.get("components"):
        return "unsupported", errs or ["no components"]
    reasons = []
    conf = _mean_conf(p)
    has_high_risk = any(c.get("zone") == "requires_human_review" or
                        c.get("role") in HIGH_RISK_ROLES for c in p.get("components", []))

    # license first — no permissive license => at best reference_only
    if not can_direct_reuse(p["license_status"]):
        reasons.append("license '%s' -> %s, not direct reuse"
                       % (p["license_status"], p["allowed_use"]))
        status = "reference_only" if p["license_status"] in (
            "manufacturer_reference_only", "copyleft_review_required",
            "attribution_required") else "needs_review"
        return status, reasons

    # permissive license: gate on evidence + risk
    if conf < 0.5:
        return "needs_review", ["low extraction confidence (%.2f)" % conf]
    if has_high_risk:
        return "reusable_with_review", ["permissive license but contains high-risk "
                                        "parts (ADC/ref/opamp/feedback) — review before reuse"]
    return "reusable", ["permissive license + strong evidence"]


def finalize(p):
    status, reasons = derive_status(p)
    p["support_status"] = status
    p["status_reasons"] = reasons
    return p
