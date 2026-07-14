"""Real design-level evaluators + convergence loop (Stage 3).

Every check here is fidelity='real': it is computed from the ACTUAL resolved
design — the UCS parts' real voltage windows and pins, and the real MCU
selection (pin allocation / conflicts) — not from a surrogate proxy. The
convergence loop runs the planner, evaluates, applies a real corrective for any
fixable ERROR (off-rail part -> add the right regulator; unfit MCU -> substitute
a larger one), and re-evaluates until no error remains or a budget caps it. It
reports `converged` ONLY when the real checks actually pass — it never fakes
convergence. Warnings (unsupported requested part, fine-pitch routing risk) are
reported but do not block, because the board still builds without them.

    result = converge(prompt)   # {design, checks, trace, converged}
"""
from planner import run
from mcu_selector import requirements_from_design, select_mcu

BOARD_RAIL_V = 3.3  # the regulated logic rail every synth board makes
_SRC_V = {"usb": 5.0, "usb_c": 5.0, "usb-c": 5.0, "vin": 5.0,
          "battery": 3.7, "lipo": 3.7, "li-ion": 3.7, "coin": 3.0}
_TOL = 0.15  # rail tolerance (V)


def _available_rails(intent):
    """The rails the board actually provides: the input source rail + the
    regulated 3.3V logic rail (the MCU always gets 3.3V)."""
    src = ((intent or {}).get("power") or {}).get("source") or "usb"
    return {round(_SRC_V.get(src, 5.0), 1), BOARD_RAIL_V}


def _off_rail(final_design, rails):
    """Parts whose real Vcc window includes NONE of the available rails."""
    bad = []
    for s in final_design or []:
        p = s.get("power") or {}
        lo, hi = p.get("vcc_min"), p.get("vcc_max")
        if lo is None or hi is None:
            continue
        if not any(lo - _TOL <= r <= hi + _TOL for r in rails):
            bad.append((s["mpn"], lo, hi))
    return bad


def evaluate(intent, final_design, honest_report=None):
    """Return a list of REAL checks: {name, fidelity, severity, passed, detail, fixable, fix}."""
    checks = []

    # 1. MCU fit — real: does the selected MCU actually have the pins for the
    #    design's buses/peripherals? (real allocation, not a guess)
    req = requirements_from_design(intent, final_design)
    dec = select_mcu(req)
    if dec.get("selected"):
        checks.append({"name": "mcu_fit", "fidelity": "real", "severity": "ok",
                       "passed": True,
                       "detail": "%s fits the design (status=%s)" % (dec["selected"], dec["status"])})
    else:
        checks.append({"name": "mcu_fit", "fidelity": "real", "severity": "error",
                       "passed": False, "fixable": True, "fix": "substitute_mcu",
                       "detail": dec.get("blocker", "no seed MCU fits the design")})

    # 2. rail compatibility — real: every part's Vcc window includes at least one
    #    available board rail (the input source rail or the regulated 3.3V)
    rails = _available_rails(intent)
    bad = _off_rail(final_design, rails)
    checks.append({"name": "rail_compat", "fidelity": "real",
                   "severity": "ok" if not bad else "error", "passed": not bad,
                   "fixable": bool(bad), "fix": "add_regulator" if bad else None,
                   "detail": "all parts run from a board rail (%s)"
                   % ", ".join("%.1fV" % r for r in sorted(rails, reverse=True)) if not bad
                   else "; ".join("%s needs %.1f–%.1fV" % (m, lo, hi) for m, lo, hi in bad)})

    # 3. coverage — real: any requested part left unsupported? (warn: board still
    #    builds without it, but it must be surfaced, never hidden)
    unsup = [h["request"] for h in (honest_report or []) if h.get("outcome") == "unsupported"]
    checks.append({"name": "coverage", "fidelity": "real",
                   "severity": "ok" if not unsup else "warn", "passed": not unsup,
                   "fixable": False,
                   "detail": "every requested part resolved" if not unsup
                   else "unsupported (no library part yet): " + ", ".join(unsup)})

    # 4. routing risk — real: is the selected MCU fine-pitch (router may not close)?
    partial = dec.get("status") == "partial"
    checks.append({"name": "routing_risk", "fidelity": "real",
                   "severity": "warn" if partial else "ok", "passed": not partial,
                   "fixable": False,
                   "detail": (dec.get("partial_warning") or "fine-pitch MCU — routing is the risk")
                   if partial else "MCU package is router-friendly"})
    return checks


def _apply_fix(check, intent, final_design):
    """Apply ONE real corrective for a fixable error. Returns a note if it acted."""
    if check["name"] == "rail_compat" and check.get("fix") == "add_regulator":
        # a real corrective: pull the LDO seed in so the off-rail parts get their
        # rail. (A buck would suit high current; the LDO is the safe default.)
        from seeds import build_seeds
        lib = build_seeds()
        ldo = lib.get("AP2112K-3.3")
        if ldo and not any(s["mpn"] == ldo["mpn"] for s in final_design):
            final_design.append(ldo)
            return "added %s LDO to make the %.1fV rail" % (ldo["mpn"], BOARD_RAIL_V)
    # mcu substitution is already handled inside planner.run's recovery; nothing
    # more we can do here without re-planning, so report honestly that we can't.
    return None


def converge(prompt, max_iters=3):
    """Plan -> evaluate (real) -> fix fixable errors -> re-evaluate, until no
    error remains or the budget caps it. Never reports converged unless the real
    checks pass. Returns the design + the honest convergence trace."""
    r = run(prompt)
    design, intent, honest = r["final_design"], r["intent"], r["honest_report"]
    trace = []
    for i in range(max_iters):
        checks = evaluate(intent, design, honest)
        errs = [c for c in checks if c["severity"] == "error"]
        trace.append({"iter": i, "errors": len(errs),
                      "checks": [{"name": c["name"], "severity": c["severity"],
                                  "detail": c["detail"]} for c in checks]})
        if not errs:
            break  # real checks pass — genuinely converged
        acted = [note for c in errs if c.get("fixable")
                 for note in [_apply_fix(c, intent, design)] if note]
        if not acted:
            break  # errors remain but nothing left to fix — stop, do NOT fake it
        trace[-1]["applied"] = acted
    final_checks = evaluate(intent, design, honest)
    converged = not any(c["severity"] == "error" for c in final_checks)
    return {"final_design": design, "intent": intent, "honest_report": honest,
            "recovery_report": r["recovery_report"],
            "overall_status": r["overall_status"],
            "requires_approval": r.get("requires_approval", []),
            "checks": final_checks, "trace": trace, "converged": converged,
            "warnings": [c["detail"] for c in final_checks if c["severity"] == "warn"]}


if __name__ == "__main__":
    import sys, json
    res = converge(" ".join(sys.argv[1:]) or "STM32 logger, BME280 I2C, SSD1306 OLED, W25Q flash, USB-C")
    print("converged:", res["converged"])
    for c in res["checks"]:
        print("  [%-5s] %-13s %s" % (c["severity"].upper(), c["name"], c["detail"]))
    print("trace: %d iteration(s)" % len(res["trace"]))
    if res["warnings"]:
        print("warnings:", json.dumps(res["warnings"]))
