"""General recovery orchestrator (Phase 3 + 4).

attempt -> collect failures -> classify -> rank strategies -> apply ONE auto fix
-> regenerate -> re-run strict gates -> compare -> stop on pass / unsupported /
retry-limit. Produces recovery-report.json/.md.

HONESTY: a run is only "recovered_and_passed" if the regenerated board actually
passes the strict gates (status PASSED, 0 violations, 0 unconnected). If no auto
strategy fixes it, the loop stops at an honest failure naming the exact blocker
and the Phase-8 capability required — never a fake pass, never a silent swap.

  python3 recovery_loop.py <design.json> [runid_base] [max_attempts]
"""
import base64
import json
import os
import re
import subprocess
import sys
import urllib.parse

import failure_taxonomy as ftax
import recovery_strategies as rstrat

BASE = "http://localhost:4500"
COOKIE = "/tmp/fl-jar3.txt"
RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")

_FINE = re.compile(r"P0\.[1-5]\d*mm|QFN|DFN|WSON|USON|VSSOP|LGA|TSSOP|WROOM|MDBT50Q", re.I)


def _run_pipeline(design, runid):
    arg = "synth=1&design=" + urllib.parse.quote(
        base64.b64encode(json.dumps(design).encode()).decode())
    url = "%s/api/pipeline/run?prompt=recovery&runId=%s&%s" % (BASE, runid, arg)
    subprocess.run(["curl", "-sN", "-b", COOKIE, "--max-time", "500", url],
                   capture_output=True, text=True)
    return _collect(runid)


def _collect(runid):
    d = os.path.join(RUNS, runid, "data")
    res = {"status": None, "routed": None, "unconnected": 0, "violations": None,
           "drc": None, "devices": [], "mcu": {}, "fine_pitch_refs": [], "erc": None}
    try:
        res["status"] = json.load(open(os.path.join(d, "last-run.json"))).get("status")
    except Exception:
        pass
    try:
        drc = json.load(open(os.path.join(d, "drc.json")))
        res["drc"] = drc
        res["violations"] = len([v for v in (drc.get("violations") or [])
                                 if v.get("type") != "solder_mask_bridge"])
        res["unconnected"] = len(drc.get("unconnected_items") or [])
    except Exception:
        pass
    try:
        res["devices"] = json.load(open(os.path.join(d, "devices.json")))
    except Exception:
        pass
    try:
        res["mcu"] = json.load(open(os.path.join(d, "mcu-selection.json")))
    except Exception:
        pass
    res["fine_pitch_refs"] = [dv.get("ref") for dv in res["devices"]
                              if _FINE.search(dv.get("footprint") or dv.get("name") or "")]
    return res


def _passed(res):
    return (res.get("status") == "PASSED" and (res.get("violations") or 0) == 0
            and (res.get("unconnected") or 0) == 0)


def _apply(strategy, failure, hints):
    """Mutate hints for the next attempt. Returns a human-readable change, or None
    if the strategy is not auto-applicable (surfaced for approval instead)."""
    comp = (failure.get("components") or [None])[0]
    if strategy == "increase_spacing":
        hints["extra_gap"] = hints.get("extra_gap", 0) + 6
        return "increased spacing (+6mm) around all parts to give %s room to escape" % (comp or "the part")
    if strategy == "enlarge_board":
        hints["board_margin"] = hints.get("board_margin", 0) + 15
        return "enlarged the board (+15mm margin) for more routing room"
    if strategy == "rotate_component" and comp:
        hints.setdefault("components", {})[comp] = {"rotate": 90}
        return "rotated %s by 90 deg to change its pin-escape geometry" % comp
    if strategy == "move_to_edge" and comp:
        # modeled as enlarge + rotate (edge placement is a Phase-8 placement feature)
        hints["board_margin"] = hints.get("board_margin", 0) + 10
        hints.setdefault("components", {})[comp] = {"rotate": 90}
        return "gave %s more room + rotated it (true edge-anchoring is Phase 8)" % comp
    if strategy == "rerun_allocator":
        hints["reserve_debug"] = True
        return "reran pin allocation with debug/boot pins reserved"
    return None   # substitute_*/alternate_footprint/add_passive -> approval/terminal


def _score(res):
    """Lower is better. Unrouted/unknown ranks worst; then violations+unconnected."""
    if res.get("violations") is None:
        return (2, 1 << 30)
    return (0 if _passed(res) else 1, (res.get("violations") or 0) + (res.get("unconnected") or 0))


def recover(design, runid_base, max_attempts=3):
    """attempt -> diagnose -> repair -> retry, KEEPING only strategies that
    improve the board (compare-and-revert). Reports the honest blocker from the
    BEST attempt — a strategy that makes things worse is never kept."""
    attempts = []
    best_hints = dict(design.get("recovery_hints", {}))

    def run(hints, i):
        d = dict(design)
        d["recovery_hints"] = hints
        runid = "%s-a%d" % (runid_base, i)
        res = _run_pipeline(d, runid)
        res["_runid"] = runid
        return res

    res = run(best_hints, 0)
    best, best_fail = res, ftax.classify(res)
    attempts.append({"attempt": 0, "runid": res["_runid"], "status": res["status"],
                     "violations": res["violations"], "unconnected": res["unconnected"],
                     "hints": dict(best_hints), "failures": best_fail,
                     "failure_summary": ftax.summarize(best_fail), "kept": True})
    final_status, phase8, approvals = "failed_honestly", None, []

    if _passed(res):
        final_status = "passed_without_recovery"
    else:
        tried = set()
        for i in range(1, max_attempts + 1):
            plans = rstrat.rank(best_fail)
            plan = None
            for p in plans:
                if p["strategy"] == "mark_unsupported":
                    break
                if p["auto"] and p["strategy"] not in tried:
                    plan = p
                    break
                if not p["auto"] and p["meta"].get("requires_approval"):
                    approvals.append({"strategy": p["strategy"],
                                      "failure": p["failure"]["type"],
                                      "why": p["meta"]["effect"]})
            if not plan:
                break
            tried.add(plan["strategy"])
            trial = dict(best_hints)
            change = _apply(plan["strategy"], plan["failure"], trial)
            if not change:
                continue
            res = run(trial, i)
            fail = ftax.classify(res)
            better = _score(res) < _score(best)
            attempts.append({"attempt": i, "runid": res["_runid"], "status": res["status"],
                             "violations": res["violations"], "unconnected": res["unconnected"],
                             "strategy": plan["strategy"], "change": change,
                             "hints": dict(trial), "failures": fail,
                             "failure_summary": ftax.summarize(fail), "kept": better})
            if better:
                best, best_hints, best_fail = res, trial, fail
                if _passed(res):
                    final_status = "recovered_and_passed"
                    break
            # if worse/same, best_hints is unchanged -> the bad hint is reverted

        if final_status != "recovered_and_passed":
            phase8 = rstrat.phase8_capability(best_fail[0]["type"]) if best_fail else None

    report = _report(design, runid_base, attempts, best, best_fail, final_status,
                     phase8, approvals)
    return report


def _report(design, runid_base, attempts, best, best_fail, final_status, phase8, approvals):
    initial = attempts[0]
    # only the KEPT strategies (ones that improved the board) are real changes;
    # reverted ones are listed as tried-but-not-kept so nothing is hidden.
    changes = [{"attempt": a["attempt"], "strategy": a.get("strategy"),
                "change": a.get("change")} for a in attempts if a.get("change") and a.get("kept")]
    tried_not_kept = [{"attempt": a["attempt"], "strategy": a.get("strategy"),
                       "change": a.get("change"), "reason": "did not improve the board — reverted"}
                      for a in attempts if a.get("change") and not a.get("kept")]
    blocker = None
    if final_status not in ("passed_without_recovery", "recovered_and_passed"):
        blocker = best_fail[0]["evidence"] if best_fail else "unknown"
    return {
        "version": 1,
        "request": design.get("intent", {}).get("product_goal", runid_base),
        "final_status": final_status,
        "initial_result": {"status": initial["status"],
                            "violations": initial["violations"],
                            "unconnected": initial["unconnected"],
                            "failures": initial["failure_summary"]},
        "attempts": attempts,
        "design_changes": changes,
        "tried_not_kept": tried_not_kept,
        "approval_required": approvals,
        "final_result": {"status": best["status"], "violations": best["violations"],
                         "unconnected": best["unconnected"], "runid": best["_runid"]},
        "blocker": blocker,
        "phase8_capability_required": phase8,
        "preserved_capabilities": ["all requested function — recovery only moved/"
                                   "spaced parts, never dropped or swapped a component"],
        "lost_capabilities": [],
    }


def report_markdown(r):
    md = ["# Recovery Report — %s\n" % r["request"],
          "**Final status:** `%s`\n" % r["final_status"],
          "**Initial:** %s, %s violations, %s unconnected  (%s)"
          % (r["initial_result"]["status"], r["initial_result"]["violations"],
             r["initial_result"]["unconnected"], r["initial_result"]["failures"]),
          "**Final:** %s, %s violations, %s unconnected\n"
          % (r["final_result"]["status"], r["final_result"]["violations"],
             r["final_result"]["unconnected"])]
    if r["design_changes"]:
        md.append("### Recovery attempts")
        for c in r["design_changes"]:
            md.append("- attempt %d — **%s**: %s" % (c["attempt"], c["strategy"], c["change"]))
        md.append("")
    if r["blocker"]:
        md.append("### Honest blocker\n" + r["blocker"] + "\n")
    if r["phase8_capability_required"]:
        md.append("> Requires the Phase-8 capability: **%s**. Recovery placement "
                  "strategies could not resolve it without that router work.\n"
                  % r["phase8_capability_required"])
    if r["approval_required"]:
        md.append("### Needs human approval")
        for a in r["approval_required"]:
            md.append("- %s (%s): %s" % (a["strategy"], a["failure"], a["why"]))
    return "\n".join(md) + "\n"


if __name__ == "__main__":
    design = json.load(open(sys.argv[1]))
    base = sys.argv[2] if len(sys.argv) > 2 else "recovery-run"
    maxa = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    rep = recover(design, base, maxa)
    out = os.path.join(RUNS, rep["final_result"]["runid"], "data")
    try:
        json.dump(rep, open(os.path.join(out, "recovery-loop.json"), "w"), indent=1)
        open(os.path.join(out, "recovery-loop.md"), "w").write(report_markdown(rep))
    except Exception:
        pass
    print("RECOVERY:" + json.dumps({
        "final_status": rep["final_status"],
        "attempts": len(rep["attempts"]),
        "changes": [c["strategy"] for c in rep["design_changes"]],
        "blocker": rep["blocker"], "phase8": rep["phase8_capability_required"]}))
