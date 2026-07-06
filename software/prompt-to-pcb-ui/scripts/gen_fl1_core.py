"""Generate the FL-1 Instrument Core v1 artifacts (Phase 15) into each core board's
run, plus per-board validation workflows so the core boards plug into the Phase 14
validation layer.

  gen_fl1_core.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import fl1_core as fc     # noqa: E402
import validation as va   # noqa: E402
import instruments as ins  # noqa: E402

RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "runs")
core = fc.core_v1()

# a build-readiness view for the core boards (all ready_to_build) so the validation
# bridge treats them as fabricatable-but-not-yet-fabricated (future_internal_board)
core_br = {"boards": [{"board": b["id"], "board_class": b["name"],
                       "recommendation": b["build_result"]["build_recommendation"]}
                      for b in core["boards"]]}

# run each core board's bring-up workflow through the mock adapter (simulated only)
mock = ins.MockAdapter()
WF = {"controller_backplane": "controller_backplane_bringup",
      "digital_bringup": "digital_bringup_bringup",
      "relay_probe_matrix": "relay_probe_matrix_bringup"}
wt = va.fl1_workflow_templates(core_br)
wfs = {w["target_board"]: w for w in wt["workflows"]}
core_runs = []
for b in core["boards"]:
    wf = wfs.get(b["id"])
    if wf:
        core_runs.append(va.run_workflow(wf, mock, "core-" + b["id"]))

for b in core["boards"]:
    d = os.path.join(RUNS, b["run_id"], "data")
    os.makedirs(d, exist_ok=True)
    json.dump(core, open(os.path.join(d, "fl1-instrument-core-v1.json"), "w"), indent=1)
    open(os.path.join(d, "fl1-instrument-core-v1.md"), "w").write(fc.to_markdown(core))
    json.dump({"version": "v1", "runs": core_runs},
              open(os.path.join(d, "fl1-core-validation-runs.json"), "w"), indent=1)
    # give the core board its own validation workflow + package
    wf = wfs.get(b["id"])
    if wf:
        json.dump(wf, open(os.path.join(d, "fl1-core-board-workflow.json"), "w"), indent=1)

print("FL-1 Instrument Core v1: %s (%d boards) | mock demos: %d" %
      (core["core_status"], core["board_count"], len(core_runs)))
for r in core_runs:
    print("  %-24s %s (%s)" % (r["board_id"], r["final_verdict"], r["evidence_status"]))
