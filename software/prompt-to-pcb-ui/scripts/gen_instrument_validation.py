"""Generate the Phase 14 instrument-adapter / validation-readiness artifacts for a
run, and run the demo mock workflows.

  gen_instrument_validation.py <run_data_dir>
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import instruments as ins    # noqa: E402
import validation as va      # noqa: E402

data_dir = sys.argv[1]
os.makedirs(data_dir, exist_ok=True)


def _w(name, obj):
    json.dump(obj, open(os.path.join(data_dir, name + ".json"), "w"), indent=1)


brp = os.path.join(data_dir, "fl1-build-readiness-dashboard.json")
build_readiness = json.load(open(brp)) if os.path.exists(brp) else {"boards": []}

# P1-5
_w("instrument-capability-model", ins.capability_model())
_w("instrument-adapter-interface", ins.adapter_interface())
_w("mock-instrument-adapter", ins.mock_adapter_descriptor())
_w("cots-instrument-adapter-spec", ins.cots_spec())
_w("fl1-internal-board-adapter-spec", ins.internal_board_spec(build_readiness))

# P6-11
wt = va.fl1_workflow_templates(build_readiness)
_w("validation-workflow-model", {"version": "v1", "primitives": va.PRIMITIVES})
_w("fl1-validation-workflow-templates", wt)
_w("validation-evidence-model", va.evidence_model())
vr = va.validation_readiness(build_readiness, wt)
_w("fl1-validation-readiness-dashboard", vr)
_w("instrument-command-dsl", va.command_dsl())
_w("fl1-validation-package-v2", {"version": "v2",
   "packages": [va.validation_package_v2(b["board"], build_readiness, wt)
                for b in build_readiness.get("boards", [])]})

# P13: demo mock runs
mock = ins.MockAdapter()
wfs = {w["target_board"]: w for w in wt["workflows"]}
demos = []
for board, rid in [("digital_bringup", "demo-digital"), ("relay_probe_matrix", "demo-relay"),
                   ("power_current_monitor", "demo-power"), ("calibration_reference", "demo-cal")]:
    if board in wfs:
        demos.append(va.run_workflow(wfs[board], mock, rid))
ads_wf = va.workflow("ads1115_front_end_mock", "ads1115_measurement_front_end", [
    va._step("set_power", command="set_power", rail="DUT_3V3", voltage=3.3, current_limit=0.1),
    va._step("measure_voltage", command="measure_voltage", target_node="+3V3", expected_range=[3.2, 3.4]),
    va._step("read_bus", command="read_bus", bus="I2C", address="0x48"),
    va._step("record_evidence"), va._step("safe_shutdown", command="disable_power")])
demos.insert(0, va.run_workflow(ads_wf, mock, "demo-ads1115-frontend"))
_w("demo-validation-runs", {"version": "v1", "run_count": len(demos), "runs": demos})

cal_run = next(d for d in demos if d["board_id"] == "calibration_reference")
print("demos: %d | cal verdict: %s | cal physical: %s" %
      (len(demos), cal_run["final_verdict"], cal_run["physical_validation"]))
