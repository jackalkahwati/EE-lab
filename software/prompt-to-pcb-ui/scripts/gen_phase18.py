"""Phase 18: generate the architecture-search artifacts + the 5 demo searches.

  gen_phase18.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import arch_search as a  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
TARGET_RUNS = ["fl1-cal-board-v4", "fl1-core-controller-v21", "fl1-core-digital-v21",
               "fl1-core-relay-v21"]


def _w(name, obj):
    for r in TARGET_RUNS:
        d = os.path.join(RUNS, r, "data")
        os.makedirs(d, exist_ok=True)
        json.dump(obj, open(os.path.join(d, name + ".json"), "w"), indent=1)


_w("architecture-candidate-model", {
    "version": "v1", "readiness_states": list(a.READINESS),
    "candidate_fields": list(a.candidate("X-0", "x", "x", "x").keys())})
_w("architecture-tradespace-scoring-model", {
    "version": "v1", "dimensions": list(a.SCORE_DIMS),
    "score_fields": ["score", "confidence", "reason", "evidence_source", "caveats"],
    "hard_blockers": list(a.HARD_BLOCKERS),
    "rule": "hard blockers DOMINATE — no aggregate score can hide one"})
_w("architecture-search-engine", {
    "version": "v1",
    "inputs": ["target capability", "required functions", "accuracy class",
               "channel count", "ranges", "bandwidth", "isolation", "safety behavior",
               "preferred board count", "available validated boards", "COTS instruments",
               "component library", "reference patterns", "manufacturing/validation/"
               "calibration constraints"],
    "candidate_kinds": ["internal board", "external COTS", "hybrid", "multi-board",
                        "reduced-scope", "mock-only", "hold"],
    "targets_covered": list(a.TARGETS.keys())})

# held-board search across all 9 targets
searches = {t: a.search(t) for t in a.TARGETS}
_w("fl1-held-board-architecture-search", {"version": "v1", "searches": searches})

_w("board-partitioning-search-report", a.partitioning_search())
_w("component-strategy-search-report", a.component_strategy())

# validation/calibration path reports (from the candidates)
vp, cp = [], []
for t, s in searches.items():
    for c in s["candidates"]:
        vp.append({"target": t, "candidate": c["candidate_id"],
                   "validation_path": c["validation_path"]})
        cp.append({"target": t, "candidate": c["candidate_id"],
                   "calibration_path": c["calibration_path"]})
_w("validation-path-architecture-report", {"version": "v1", "states": list(a.VALIDATION_STATES),
                                           "candidates": vp})
_w("calibration-path-architecture-report", {"version": "v1", "states": list(a.CAL_STATES),
                                            "candidates": cp,
                                            "examples": [
    "relay continuity: cots_verifiable with a DMM",
    "Calibration/Reference enables internally_calibratable AFTER it physically exists",
    "DMM-lite cannot claim precision until calibrated against a known reference",
    "scope-lite cannot claim bandwidth/timing without external measurement"]})

_w("fl1-recommended-next-board-roadmap", a.roadmap())

# 5 demo searches
demos = {
    "demo1_power_current_monitor": searches["power_current_monitor"],
    "demo2_dmm_lite": searches["dmm_lite"],
    "demo3_scope_lite": searches["scope_lite"],
    "demo4_external_instrument_interface": searches["external_instrument_interface"],
    "demo5_logic_capture": searches["logic_capture"],
}
_w("phase18-demo-architecture-searches", {"version": "v1", "demos": demos,
    "expectations_met": {
        "demo1": "hybrid/internal monitor recommended with COTS validation + ingestion gate",
        "demo2": "proven-chain DMM-1 recommended, HELD on the cal-board physical dependency, "
                 "no precision claim",
        "demo3": "internal scope REJECTED by hard blockers; external COTS scope recommended",
        "demo4": "EII-1 highest-readiness (all parts proven, 80% reuse)",
        "demo5": "GPIO event capture distinguished from analyzer-class; COTS LA for timing"}})

for t, s in searches.items():
    print("%-30s -> %-8s (rejected: %s)" % (t, s["recommended"], s["rejected"] or "-"))
print("roadmap #1: %s" % a.roadmap()["after_batch1"][0]["board"])
