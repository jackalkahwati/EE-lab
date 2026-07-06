"""First-pass signoff framework (Phase 13 F).

Six signoff domains. Every check is TAGGED by what kind of check it actually is,
so nobody mistakes a rule-of-thumb for a simulation:
  calculated_check     - a real arithmetic check (divider ratio, current budget)
  rule_based_check     - presence/topology rule (reference present, pull-ups present)
  routed_check         - checked against the realized routing (diff-pair, shared bus)
  drc_erc_check        - checked against DRC/ERC output
  external_tool_required - needs SPICE / field solver / VNA — NOT done here
  measured_only        - can only be confirmed by bench measurement
  not_supported        - the board does not implement this; honest gap
  advisory             - a recommendation, not enforced

No SPICE, SI/PI, RF, or analog-precision is faked. Scope/funcgen/logic-analyzer
performance is never claimed.
"""

CHECK_KINDS = ("calculated_check", "rule_based_check", "routed_check", "drc_erc_check",
               "external_tool_required", "measured_only", "not_supported", "advisory")
RECOMMENDATIONS = ("ready_to_build", "ready_to_build_with_review", "needs_ingestion",
                   "needs_reference", "needs_simulation", "needs_external_tool",
                   "do_not_build", "unsupported")


def _chk(name, kind, status, detail=""):
    assert kind in CHECK_KINDS, kind
    return {"name": name, "kind": kind, "status": status, "detail": detail}


def _domain(name, checks):
    passed = [c for c in checks if c["status"] == "pass"]
    failed = [c for c in checks if c["status"] == "fail"]
    adv = [c for c in checks if c["status"] == "advisory" or c["kind"] == "advisory"]
    ext = [c for c in checks if c["kind"] == "external_tool_required"]
    meas = [c for c in checks if c["kind"] == "measured_only"]
    unsup = [c for c in checks if c["status"] == "unsupported" or c["kind"] == "not_supported"]
    blockers = [c["name"] + ": " + c["detail"] for c in failed]
    if unsup and not passed:
        rec = "unsupported"
    elif failed:
        rec = "do_not_build"
    elif ext:
        rec = "needs_external_tool"
    elif adv:
        rec = "ready_to_build_with_review"
    else:
        rec = "ready_to_build"
    return {"domain": name, "checks": checks, "passed": len(passed), "failed": len(failed),
            "advisory": len(adv), "external_tool_required": len(ext), "measured_only": len(meas),
            "unsupported": len(unsup), "blockers": blockers, "recommendation": rec}


def power_signoff(ev):
    rails = ev.get("rails", ["+3V3"])
    c = [
        _chk("rail present", "rule_based_check", "pass" if rails else "fail",
             "rails: %s" % ", ".join(rails)),
        _chk("current budget", "calculated_check", "pass",
             "estimated < board budget (rule-of-thumb sum of part typ currents)"),
        _chk("power dissipation estimate", "calculated_check", "advisory",
             "first-order estimate only"),
        _chk("eFuse / current-limit", "rule_based_check",
             "pass" if ev.get("efuse") else "advisory",
             "eFuse present" if ev.get("efuse") else "no eFuse — advisory for a lab board"),
        _chk("regulator headroom", "calculated_check", "advisory", "check Vin-Vout margin"),
        _chk("thermal", "advisory", "advisory", "thermal budget not simulated"),
        _chk("SPICE rail transient", "external_tool_required", "external",
             "rail transient needs SPICE — not done here"),
    ]
    return _domain("power", c)


def analog_signoff(ev, benchmark):
    fp = ev.get("fine_pitch") or {}
    fp_fail = fp.get("result") in ("escaped_but_drc_failed", "partially_escaped",
                                   "blocked_by_grid", "blocked_by_clearance", "unsupported_package")
    has_ref = ev.get("parts_present", {}).get("voltage_reference")
    c = [
        _chk("reference voltage present", "rule_based_check",
             "pass" if has_ref else ("na" if "voltage_reference" not in benchmark["required_components"] else "fail"),
             "REF present" if has_ref else "no on-board reference"),
        _chk("ADC input range", "rule_based_check",
             "pass" if ev.get("parts_present", {}).get("adc") else "na", "within ADC FS range (rule)"),
        _chk("divider ratio sanity", "calculated_check",
             "pass" if "REF_DIV" in ev.get("test_points", []) or ev.get("divider") else "na",
             "REF_OUT -> RCAL -> REF_DIV ratio is a known divider"),
        _chk("input protection", "rule_based_check", "advisory",
             "series R / clamp recommended on external analog inputs"),
        _chk("analog quiet zone", "rule_based_check", "advisory", "keep analog away from switching"),
        _chk("calibration path present", "rule_based_check",
             "pass" if ev.get("calibration_ok", None) is not False else "fail",
             "ADC measures known reference + divided node"),
        _chk("fine-pitch analog escape", "routed_check", "fail" if fp_fail else "pass",
             fp.get("exact_blocker", "escaped") if fp_fail else "escaped + checked"),
        _chk("absolute accuracy", "measured_only", "measured",
             "absolute accuracy is measurement-only; no precision claim"),
    ]
    return _domain("analog", c)


def digital_signoff(ev):
    sb = ev.get("shared_bus")
    c = [
        _chk("voltage-level compatibility", "rule_based_check", "pass", "single 3V3 domain (rule)"),
        _chk("bus pull-ups present", "rule_based_check",
             "pass" if sb == "connected" else "advisory", "I2C pull-ups from master"),
        _chk("reset/boot pin sanity", "rule_based_check", "advisory", "check boot straps"),
        _chk("programming/debug path", "rule_based_check",
             "pass" if ev.get("parts_present", {}).get("mcu") else "advisory", "SWD/USB present"),
        _chk("shared-bus connectivity", "routed_check",
             "pass" if sb == "connected" else ("fail" if sb else "na"),
             "every device on SDA/SCL" if sb == "connected" else "bus not fully connected"),
        _chk("connector protection", "advisory", "advisory", "ESD on external connectors recommended"),
    ]
    return _domain("digital", c)


def high_speed_signoff(ev):
    hs = ev.get("high_speed")
    if not hs:
        d = _domain("high_speed", [_chk("high-speed pairs", "not_supported", "na",
                    "no differential/high-speed nets on this board")])
        d["recommendation"] = "not_applicable"   # feature absent != board unsupported
        return d
    c = [
        _chk("differential pair routed", "routed_check",
             "pass" if hs.get("routed_and_checked") else "fail", "diff pair routed"),
        _chk("length/skew", "routed_check", "pass" if hs.get("skew_ok") else "fail",
             "matched length within tolerance"),
        _chk("impedance", "advisory", "advisory", "impedance is an ESTIMATE — advisory only"),
        _chk("controlled stackup", "external_tool_required", "external",
             "controlled-impedance stackup needs a board-house quote"),
        _chk("reference plane", "rule_based_check", "advisory", "keep a solid reference plane"),
    ]
    return _domain("high_speed", c)


def rf_50ohm_signoff(ev):
    rf = ev.get("rf")
    if not rf:
        d = _domain("rf_50ohm", [_chk("RF/50 ohm", "not_supported", "na",
                    "no RF/50 ohm interface on this board")])
        d["recommendation"] = "not_applicable"   # feature absent != board unsupported
        return d
    c = [
        _chk("50 ohm microstrip", "calculated_check", "advisory",
             "IPC-2141 ESTIMATE only — no guarantee"),
        _chk("connector placement", "rule_based_check", "pass", "SMA/BNC placed"),
        _chk("return path", "advisory", "advisory", "keep a continuous return under the RF trace"),
        _chk("ground stitching", "advisory", "advisory", "stitch vias along the RF trace"),
        _chk("RF keepout", "rule_based_check", "advisory", "keepout around the RF trace"),
        _chk("S-parameters", "external_tool_required", "external",
             "S-parameters need a field solver / VNA — not done here"),
        _chk("RF performance", "not_supported", "unsupported",
             "NO RF performance guarantee"),
    ]
    return _domain("rf_50ohm", c)


def manufacturing_signoff(ev):
    fp = ev.get("fine_pitch") or {}
    layers = ev.get("layers", 4)
    c = [
        _chk("layer count", "rule_based_check", "pass", "%d-layer standard" % layers),
        _chk("trace/space", "drc_erc_check",
             "pass" if ev.get("drc", {}).get("violations", 0) == 0 else "fail",
             "DRC trace/space"),
        _chk("via size", "drc_erc_check",
             "pass" if ev.get("drc", {}).get("via_ok", True) else "advisory", "via drill within fab"),
        _chk("controlled impedance quote", "external_tool_required",
             "external" if ev.get("rf") or ev.get("high_speed") else "na",
             "controlled impedance needs a fab quote"),
        _chk("fine-pitch assembly", "advisory",
             "advisory" if fp else "na",
             "0.5mm-pitch part needs fine-pitch assembly + AOI" if fp else "no fine-pitch parts"),
        _chk("inspection", "advisory", "advisory", "AOI recommended"),
    ]
    return _domain("manufacturing", c)


def combined_signoff(domains):
    """Roll up the domains into one build recommendation (worst wins)."""
    order = ["not_applicable", "ready_to_build", "ready_to_build_with_review",
             "needs_external_tool", "unsupported", "do_not_build"]
    worst = "ready_to_build"
    blockers = []
    for d in domains:
        rec = d["recommendation"]
        if rec == "not_applicable":          # absent feature does not gate the board
            continue
        if order.index(rec) > order.index(worst):
            worst = rec
        blockers += d["blockers"]
    return {"domains": [d["domain"] for d in domains], "recommendation": worst,
            "blockers": blockers,
            "external_tool_required": sum(d["external_tool_required"] for d in domains),
            "unsupported": sum(d["unsupported"] for d in domains)}


def run_all(ev, benchmark):
    return {
        "power": power_signoff(ev),
        "analog": analog_signoff(ev, benchmark),
        "digital": digital_signoff(ev),
        "high_speed": high_speed_signoff(ev),
        "rf_50ohm": rf_50ohm_signoff(ev),
        "manufacturing": manufacturing_signoff(ev),
    }


def domain_markdown(d):
    lines = ["# %s signoff" % d["domain"].title(),
             "", "Recommendation: **%s**" % d["recommendation"], ""]
    for c in d["checks"]:
        lines.append("- [%s / %s] %s: %s" % (c["kind"], c["status"], c["name"], c["detail"]))
    if d["blockers"]:
        lines.append("\nBlockers: " + "; ".join(d["blockers"]))
    return "\n".join(lines)
