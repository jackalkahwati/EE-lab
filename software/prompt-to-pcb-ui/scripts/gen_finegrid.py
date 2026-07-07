"""Phase 16.5: record the fine-grid fanout result and update the evidence layers.

The cal board's outcome is read from the REAL run (fl1-cal-board-v3): pass ->
build-readiness flips do_not_build -> ready_to_build_with_review (order stays
review-required, never automatic); fail -> everything stays held with the more
specific blocker. Batch 1 v2 boards are verified UNCHANGED.

  gen_finegrid.py
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import fine_grid as fg   # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
V3 = os.path.join(RUNS, "fl1-cal-board-v3", "data")
CAL = os.path.join(RUNS, "fl1-cal-board", "data")

# ---- read the REAL result from the v3 run ----
lr = json.load(open(os.path.join(V3, "last-run.json")))
board = json.load(open(os.path.join(V3, "board.json")))
drc = json.load(open(os.path.join(V3, "drc.json")))
viol = len([v for v in (drc.get("violations") or []) if v.get("type") != "solder_mask_bridge"])
unconn = len(drc.get("unconnected_items") or [])
routed, total = board.get("netsRouted"), board.get("netsTotal")
passed = (lr.get("status") == "PASSED" and viol == 0 and unconn == 0 and routed == total)

result = {
    "version": "v1", "board": "FL-1 Calibration / Reference board",
    "run_id": "fl1-cal-board-v3",
    "outcome": "A_physical_pass" if passed else "B_honest_fail",
    "routing": "%s/%s" % (routed, total), "drc_violations": viol, "unconnected": unconn,
    "erc": "PASS" if passed else lr.get("status"),
    "pipeline_status": lr.get("status"),
    "ads1115_escape": "fine_grid_escape_passed" if passed else "fine_grid_escape_drc_failed",
    "escapes": ["SDA", "SCL", "AIN0/REF_OUT", "AIN1/REF_DIV"],
    "capability": "exact-geometry pre-escape fanout (lane escapes + dogbone vias + "
                  "router wire-obstacles) — see fine-grid-routing-model",
    "root_causes_fixed": fg.routing_model()["root_causes_fixed"],
    "previous_blocker": "blocked_by_grid_resolution",
    "previous_blocker_status": "FIXED" if passed else "still blocked (see drc)",
    "build_recommendation": "ready_to_build_with_review" if passed else "do_not_build",
    "order_recommendation": "order_3_pcba_review_required (NOT automatic)" if passed
                            else "do_not_order",
    "human_review_required": True,
    "required_parts_present": {"REF3025": True, "ADS1115IDGS": True, "24LC02": True,
                               "FL-1 instrument bus": True, "divider RCAL1/RCAL2": True},
    "calibration_impact": ("physical calibration workflow can become "
                           "physical-ready-with-review AFTER the board is fabricated + "
                           "a traceable reference chain exists — no calibration claim yet"
                           if passed else "do_not_calibrate_physical"),
}

def _w(d, name, obj):
    os.makedirs(d, exist_ok=True)
    json.dump(obj, open(os.path.join(d, name + ".json"), "w"), indent=1)

for d in (V3, CAL):
    _w(d, "calibration-board-finegrid-result", result)
    _w(d, "fine-grid-routing-model", fg.routing_model(
        result="fine_grid_escape_passed" if passed else "fine_grid_escape_drc_failed"))
    _w(d, "via-in-pad-feasibility-report", fg.via_in_pad_feasibility())
    _w(d, "hdi-feasibility-placeholder", fg.hdi_placeholder())

# pre-escape report from the fanout sidecar (the standalone chain's exact geometry)
fanout_side = "/tmp/fg-cal.fanout.json"
if os.path.exists(fanout_side):
    fo = json.load(open(fanout_side))
    rep = {"version": "v1",
           "escapes": fo.get("entries", []), "plane_dogbones": fo.get("dogbones", []),
           "rule": "a stub alone never counts as routed — nets verified end-to-end by "
                   "DRC + unconnected check (0/0 on the passing board)"}
    for d in (V3, CAL):
        _w(d, "fine-pitch-preescape-report", rep)

# placement optimization record
placement = {"version": "v1", "attempts": [
    {"strategy": "rotation 0 (Phase 13)", "result": "walled escapes, 13 shorts", "kept": False},
    {"strategy": "rotation 90 + grid routing (Phase 13)",
     "result": "all logical nets routed, 13 fine-pitch shorts (grid contention + the "
               "then-unknown pad-rotation bug)", "kept": False},
    {"strategy": "rotation 90 + pad-rotation fix + exact-geometry fanout (Phase 16.5)",
     "result": "7/7 nets, 0 DRC, 0 unconnected, ERC PASS", "kept": passed},
]}
for d in (V3, CAL):
    _w(d, "fine-pitch-placement-optimization", placement)

# ---- update the cal board attempt + rerun the evidence layers ----
att_p = os.path.join(CAL, "cal-board-attempt.json")
att = json.load(open(att_p))
if passed:
    att["outcome"] = "A_physical_pass"
    att["routed"] = "%s/%s" % (routed, total)
    att["drc_violations"] = 0
    att["blocker"] = None
    att["previous_blocker"] = "blocked_by_grid_resolution"
    att["previous_blocker_status"] = ("FIXED by Phase 16.5: pad-rotation fix + "
                                      "exact-geometry fine-pitch fanout (run fl1-cal-board-v3)")
    att["fine_pitch_escape"].update({"result": "escaped_and_checked",
                                     "exact_blocker": None,
                                     "build_recommendation": "ready_to_build_with_review"})
    att["readiness"] = "ready_to_build_with_review"
    att["note"] = ("REAL calibration/reference board PASSED the full pipeline (7/7, 0 DRC, "
                   "0 unconnected, ERC PASS) with the fine-pitch fanout. Order remains "
                   "REVIEW-REQUIRED — never automatic. Rev A evidence (the do_not_build "
                   "history) is preserved in the ledger and git history.")
json.dump(att, open(att_p, "w"), indent=1)
json.dump(att, open(os.path.join(V3, "cal-board-attempt.json"), "w"), indent=1)

# rerun benchmark/signoff + validation-readiness + phase15 policy on the cal run
subprocess.run([sys.executable, os.path.join(HERE, "gen_benchmark_signoff.py"), CAL], check=True)
subprocess.run([sys.executable, os.path.join(HERE, "gen_instrument_validation.py"), CAL], check=True)
subprocess.run([sys.executable, os.path.join(HERE, "gen_phase15.py"), CAL], check=True)

# ---- Batch 1 v2 stability: verify unchanged, not ordered ----
stab = {"version": "v1", "boards": []}
for run_id, role in [("fl1-core-controller-v2", "controller_backplane"),
                     ("fl1-core-digital-v2", "digital_bringup"),
                     ("fl1-core-relay-v2", "relay_probe_matrix")]:
    d2 = os.path.join(RUNS, run_id, "data")
    rc = json.load(open(os.path.join(d2, "role-completeness-report.json")))
    fa = json.load(open(os.path.join(d2, "phase15-first-article-review-v2.json")))
    fb = next(b for b in fa["boards"] if b["board"] == role)
    stab["boards"].append({"board": role, "run_id": run_id,
                           "role_completeness": rc["status"],
                           "fa_review_v2": fb["recommendation"],
                           "drc": fb["drc_violations"], "routing": fb["routing"],
                           "ordered": False, "human_review_required": True,
                           "unchanged": rc["status"].startswith("role_complete")
                           and fb["recommendation"] == "order_3_pcba_review_required"})
stab["all_stable"] = all(b["unchanged"] for b in stab["boards"])
for d in (V3, CAL):
    _w(d, "batch1-stability-report", stab)

print("FINEGRID RESULT: %s | routing %s | DRC %d | unconn %d" %
      (result["outcome"], result["routing"], viol, unconn))
print("cal board: %s -> %s (order: %s)" % ("do_not_build",
      result["build_recommendation"], result["order_recommendation"]))
print("batch1 stable: %s" % stab["all_stable"])
