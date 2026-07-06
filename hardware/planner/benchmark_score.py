"""Benchmark scoring engine (Phase 13 E).

Compares a generated FL-1 board/artifact package to its benchmark and produces a
per-category score + an overall status. It CONSUMES evidence (fine-pitch escape,
shared-bus connectivity, DRC/ERC, ingestion, test points) and never reinterprets
it: if the fine-pitch escape failed and DRC failed, the board is do_not_build,
full stop, regardless of how complete the architecture is.

Evidence dict (all optional; missing => that category is 'unknown'):
  parts_present:   {component_class: bool}      # required components present
  ingested:        {component_class: bool}      # required components ingested/usable
  shared_bus:      "connected"|"modeled_not_connected"|...   (from shared_bus)
  fine_pitch:      {"result": ..., "exact_blocker": ...}     (from fine_pitch_escape)
  drc:             {"violations": int, "shorts": int}
  erc:             "PASS"|"FAIL"|None
  routing:         "N/M"
  test_points:     [nets]
  patterns:        {"covered": int, "needed": int}
  protection:      {"present": [...], "missing": [...]}
  manufacturing:   "standard_4_layer"|...
  claimed:         [strings]   # any performance claims the board makes (for forbidden check)
"""

CATEGORIES = ["architecture_completeness", "component_readiness",
              "symbol_footprint_confidence", "reference_pattern_coverage",
              "layout_rule_coverage", "fine_pitch_escape_status", "protection_coverage",
              "calibration_readiness", "test_point_coverage", "fl1_validation_readiness",
              "manufacturing_readiness", "unsupported_risk_severity", "drc_erc_status"]

STATUSES = ("benchmark_pass", "benchmark_pass_with_review", "benchmark_partial",
            "benchmark_fail", "do_not_build")


def _frac(present, total):
    return round(present / total, 2) if total else 1.0


def score(benchmark, evidence):
    """Score a board package against its benchmark. Returns a report dict."""
    ev = evidence or {}
    cats = {}
    hard_fails = []
    exact_blocker = None

    # architecture completeness: required blocks that appear present (best-effort:
    # count required components present)
    req_comp = benchmark["required_components"]
    present = ev.get("parts_present", {})
    cats["architecture_completeness"] = _frac(sum(1 for c in req_comp if present.get(c)),
                                              len(req_comp)) if req_comp else (
        1.0 if not benchmark["required_blocks"] else _frac(
            sum(1 for _b in benchmark["required_blocks"] if present), len(benchmark["required_blocks"])))

    # component readiness + symbol/footprint confidence: ingestion status
    ing = ev.get("ingested", {})
    cats["component_readiness"] = _frac(sum(1 for c in req_comp if ing.get(c)), len(req_comp)) \
        if req_comp else 1.0
    cats["symbol_footprint_confidence"] = cats["component_readiness"]
    # a required component that is not ingested is a hard fail when the benchmark
    # says so (keeps scope-lite / stimulus honest: nothing ingested != a pass)
    if any("not ingested" in r for r in benchmark["hard_fail_rules"]):
        missing_ing = [c for c in req_comp if not ing.get(c)]
        if missing_ing:
            hard_fails.append("required component not ingested: %s" % ", ".join(missing_ing))

    # reference pattern coverage
    pat = ev.get("patterns", {})
    cats["reference_pattern_coverage"] = _frac(pat.get("covered", 0), pat.get("needed", 0)) \
        if pat.get("needed") else "n/a"

    # fine-pitch escape status (EVIDENCE — consumed verbatim)
    fp = ev.get("fine_pitch")
    if fp:
        res = fp.get("result")
        cats["fine_pitch_escape_status"] = res
        if res in ("escaped_but_drc_failed", "partially_escaped", "blocked_by_grid",
                   "blocked_by_clearance", "unsupported_package"):
            if "fine-pitch escape failed" in benchmark["hard_fail_rules"]:
                hard_fails.append("fine-pitch escape failed (%s)" % fp.get("exact_blocker", res))
                exact_blocker = fp.get("exact_blocker") or "fine_pitch_escape_failed"
    else:
        cats["fine_pitch_escape_status"] = "n/a"

    # layout rule coverage: test points + required layout features (best-effort)
    tps = set(ev.get("test_points", []))
    req_tp = set(benchmark["required_test_points"])
    cats["test_point_coverage"] = _frac(len(req_tp & tps), len(req_tp)) if req_tp else 1.0
    cats["layout_rule_coverage"] = cats["test_point_coverage"]

    # protection coverage
    prot = ev.get("protection", {})
    req_prot = benchmark["required_protection"]
    if req_prot:
        missing = [p for p in req_prot if p not in prot.get("present", []) and "advisory" not in p]
        cats["protection_coverage"] = _frac(len(req_prot) - len(missing), len(req_prot))
        if missing and "required protection missing" in benchmark["hard_fail_rules"]:
            hard_fails.append("required protection missing: %s" % ", ".join(missing))
    else:
        cats["protection_coverage"] = "n/a"

    # calibration readiness
    req_cal = benchmark["required_calibration_hooks"]
    cats["calibration_readiness"] = (1.0 if not req_cal else
                                     (1.0 if ev.get("calibration_ok", None) is not False else 0.0))
    if req_cal and ev.get("calibration_ok") is False and \
            "calibration path missing" in benchmark["hard_fail_rules"]:
        hard_fails.append("required calibration path missing")

    # FL-1 validation + manufacturing
    cats["fl1_validation_readiness"] = 1.0 if ev.get("fl1_validation", True) else 0.0
    cats["manufacturing_readiness"] = 1.0 if ev.get("manufacturing") in benchmark[
        "required_manufacturing"] or not ev.get("manufacturing") else 0.7

    # shared bus (a hard fail when required + disconnected)
    if benchmark["required_nets"] and any(n in ("I2C_SDA", "I2C_SCL") for n in benchmark["required_nets"]):
        sb = ev.get("shared_bus")
        if sb and sb != "connected" and "shared bus disconnected" in benchmark["hard_fail_rules"]:
            hard_fails.append("required shared bus disconnected (%s)" % sb)

    # DRC/ERC status (EVIDENCE)
    drc = ev.get("drc", {})
    shorts = drc.get("shorts", 0)
    viol = drc.get("violations", 0)
    erc = ev.get("erc")
    drc_ok = shorts == 0 and viol == 0 and erc != "FAIL"
    cats["drc_erc_status"] = "pass" if drc_ok else ("shorts=%d viol=%d erc=%s" % (shorts, viol, erc))
    if not drc_ok and "DRC/ERC failed" in benchmark["hard_fail_rules"]:
        hard_fails.append("DRC/ERC failed (shorts=%d, viol=%d)" % (shorts, viol))

    # unsupported-risk severity: forbidden performance claims actually made
    claimed = ev.get("claimed", [])
    forbidden_hit = [c for c in benchmark["unsupported_claims_forbidden"]
                     if any(c.lower() in str(cl).lower() for cl in claimed)]
    cats["unsupported_risk_severity"] = "high" if forbidden_hit else "none"
    for f in forbidden_hit:
        hard_fails.append("forbidden unsupported claim made: %s" % f)

    # reference coverage (Phase D.5.6): references add CONFIDENCE, never direct reuse.
    # An external-only reference set cannot alone raise a board to benchmark_pass;
    # an unresolved license/trust issue caps it at pass_with_review.
    refcov = ev.get("reference_coverage") or {}
    cats["reference_pattern_coverage"] = refcov.get("reference_coverage_score",
                                                    cats["reference_pattern_coverage"])
    license_review_needed = refcov.get("open_source_reference_coverage", 0) > 0 and \
        refcov.get("reusable_reference_count", 0) == 0
    external_only = refcov.get("internal_reference_coverage", 1) == 0 and \
        refcov.get("reference_count", 0) > 0

    # overall
    numeric = [v for v in cats.values() if isinstance(v, (int, float))]
    avg = round(sum(numeric) / len(numeric), 2) if numeric else 0.0
    thresh = benchmark["scoring_rules"]
    if hard_fails:
        # a fine-pitch/DRC hard fail is do_not_build; other hard fails are fail
        status = "do_not_build" if (exact_blocker or shorts > 0) else "benchmark_fail"
    elif avg >= thresh.get("pass_threshold", 0.8):
        status = "benchmark_pass"
    elif avg >= thresh.get("review_threshold", 0.6):
        status = "benchmark_pass_with_review"
    else:
        status = "benchmark_partial"
    # a board cannot be a clean pass on external references alone / with open
    # license questions — downgrade to pass_with_review
    if status == "benchmark_pass" and (external_only or license_review_needed):
        status = "benchmark_pass_with_review"

    return {
        "benchmark": benchmark["name"],
        "board_class": benchmark["board_class"],
        "status": status,
        "overall_score": avg,
        "categories": cats,
        "hard_fails": hard_fails,
        "exact_blocker": exact_blocker,
        "trust": benchmark["trust"],
        "reference_coverage": {
            "score": refcov.get("reference_coverage_score"),
            "internal": refcov.get("internal_reference_coverage"),
            "manufacturer": refcov.get("manufacturer_reference_coverage"),
            "open_source": refcov.get("open_source_reference_coverage"),
            "reusable": refcov.get("reusable_reference_count"),
            "unlicensed": refcov.get("unlicensed_reference_count"),
            "missing_source_files": refcov.get("needs_source_file_count"),
            "risk_level": refcov.get("reference_risk_level"),
            "license_review_needed": license_review_needed,
        },
    }


def to_markdown(reports):
    lines = ["# Benchmark score report", ""]
    for r in reports:
        lines.append("## %s (%s) - **%s** (score %.2f)" %
                     (r["benchmark"], r["board_class"], r["status"], r["overall_score"]))
        if r["exact_blocker"]:
            lines.append("- exact blocker: **%s**" % r["exact_blocker"])
        for hf in r["hard_fails"]:
            lines.append("- HARD FAIL: %s" % hf)
        lines.append("- categories: %s" % ", ".join("%s=%s" % (k, v) for k, v in r["categories"].items()))
        lines.append("")
    return "\n".join(lines)
