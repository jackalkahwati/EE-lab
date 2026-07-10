"""Phase 15 build policy gate + package policy + order dashboard.

Consumes Phase 13 (build-readiness, benchmark, signoff) and Phase 14 (validation
readiness, adapter availability) and decides, per FL-1 board, what may actually be
generated: an architecture package, an honest design-attempt package, or a real
order-ready PCBA package. The gate is the discipline of Phase 15: only boards the
evidence system says are safe get an order package; everything else is honestly held.

Nothing here overrides Phase 13/14. do_not_build stays do_not_build.
"""
import json
import os

PACKAGE_TYPES = ("architecture_package", "design_attempt_package", "order_ready_pcba_package",
                 "mock_validation_package", "cots_validation_package", "internal_validation_package")
ORDER_RECS = ("order_5_pcba", "order_3_pcba_review_required", "architecture_only",
              "design_attempt_only", "do_not_order", "unsupported")


def package_policy():
    return {
        "version": "v1",
        "package_types": {
            "architecture_package": "may exist for not-ready boards (reports only)",
            "design_attempt_package": "may exist for HONEST failures (routed attempt + exact blocker)",
            "order_ready_pcba_package": "requires ALL strict gates: DRC/ERC clean + benchmark + "
                                        "signoff + assembly-ready + sourced + validation-ready",
            "mock_validation_package": "always simulated evidence",
            "cots_validation_package": "requires an external COTS adapter spec; not a physical run",
            "internal_validation_package": "requires the internal board to EXIST + be calibrated",
        },
    }


def build_policy(board, evidence):
    """Decide the policy flags for one board. `evidence` carries the real build
    result + Phase 13/14 status."""
    ev = evidence or {}
    br = ev.get("build_recommendation", "unknown")     # from the REAL build or Phase 13
    routes_clean = ev.get("routes_clean", False)
    assembly_ready = ev.get("assembly_ready", False)
    # Missing evidence is not a pass.  In particular, a review label must not
    # bypass assembly or sourcing readiness and accidentally create an order
    # package from a merely routed board.
    sourced = ev.get("sourced", False)
    drc_clean = ev.get("drc_violations", 1) == 0
    validation = ev.get("validation_readiness_status")
    blockers = list(ev.get("exact_blockers", []))

    do_not_build = br in ("do_not_build", "unsupported")
    strict_ready = routes_clean and drc_clean and assembly_ready and sourced
    order_ok = br == "ready_to_build" and strict_ready
    review_ok = br == "ready_to_build_with_review" and strict_ready
    routed_candidate = (br in ("ready_to_build", "ready_to_build_with_review")
                        and routes_clean and drc_clean)

    # package type + order recommendation
    if br == "unsupported":
        pkg, order, attempt = "architecture_package", "unsupported", False
    elif br == "do_not_build":
        # honest design attempt allowed (routed + exact blocker), NO order package
        pkg = "design_attempt_package" if ev.get("attempted") else "architecture_package"
        order, attempt = "do_not_order", ev.get("attempted", False)
    elif order_ok:
        # a genuinely clean, sourced, routed board — first internal fab: small qty + review
        pkg, order, attempt = "order_ready_pcba_package", "order_3_pcba_review_required", True
    elif review_ok:
        pkg, order, attempt = "order_ready_pcba_package", "order_3_pcba_review_required", True
    elif routed_candidate:
        # The electrical design may still be exercised/reviewed, but missing
        # assembly or sourcing evidence keeps it out of the order path.
        pkg, order, attempt = "design_attempt_package", "design_attempt_only", True
    elif br == "needs_ingestion":
        pkg, order, attempt = "design_attempt_package", "design_attempt_only", ev.get("attempted", False)
    elif br in ("needs_reference", "needs_external_tool"):
        pkg, order, attempt = "architecture_package", "architecture_only", False
    else:
        pkg, order, attempt = "architecture_package", "architecture_only", False

    human_review = (order.endswith("review_required")
                    or br == "ready_to_build_with_review" or order_ok)

    return {
        "board": board,
        "allowed_to_attempt_board": attempt or order_ok or review_ok,
        "allowed_to_generate_order_package": order_ok or review_ok,
        "allowed_to_mark_ready_to_order": order_ok or review_ok,
        "allowed_to_validate_with_mock": True,     # mock is always allowed (simulated)
        "allowed_to_validate_with_cots": not do_not_build and validation and
        "cots" in str(validation),
        "allowed_to_validate_with_internal_board": False,   # no internal board fabricated yet
        "required_human_review": bool(human_review),
        "package_type": pkg,
        "order_recommendation": order,
        "physical_validation_blocked": do_not_build,
        "exact_blockers": blockers,
    }


def adapter_mapping(board_id, provides_capabilities):
    """Map a board's functions to Phase 14 instrument commands."""
    return {"board": board_id, "instrument_commands": provides_capabilities,
            "note": "these commands are available via a future_internal_board adapter once the "
                    "board is fabricated + calibrated; mock adapter simulates them now"}


def order_pack_validation(run_data_dir):
    """Validate a board's manufacturing order pack — which required artifacts exist."""
    def has(name):
        return os.path.exists(os.path.join(run_data_dir, name))

    ar = json.load(open(os.path.join(run_data_dir, "assembly-readiness.json"))) \
        if has("assembly-readiness.json") else {}
    board = json.load(open(os.path.join(run_data_dir, "board.json"))) if has("board.json") else {}
    checks = {
        "bom_present": has("bom.json") or has("bom.csv"),
        "pick_and_place_present": has("pick_and_place.csv"),
        "assembly_report_present": has("assembly-readiness.json"),
        "devices_present": has("devices.json"),
        "sourcing_present": has("sourcing-report.json"),
        "drc_present": has("drc.json"),
        # gerbers/drill/STEP are generated into the order zip at order time
        "gerbers_drill_step": "generated_at_order (pcba-package.zip)",
        "assembly_ready": ar.get("ready_for_assembly", False),
        "no_missing_parts": len(ar.get("missing_parts", [])) == 0,
        "no_unavailable_parts": len(ar.get("unavailable_parts", [])) == 0,
        "board_dimensions_sane": bool(board.get("boardSize")),
        "layer_count": board.get("layers"),
    }
    required = ["bom_present", "pick_and_place_present", "assembly_report_present",
                "assembly_ready", "no_missing_parts", "no_unavailable_parts"]
    ok = all(checks.get(k) is True for k in required)
    return {"order_pack_valid": ok, "checks": checks,
            "missing": [k for k in required if checks.get(k) is not True]}
