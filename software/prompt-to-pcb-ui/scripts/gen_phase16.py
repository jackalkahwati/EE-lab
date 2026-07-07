"""Generate the Phase 16 calibration/traceability/redesign artifacts and run the
5 mock demo runs. All demo evidence is SIMULATED and marked so; the cal board is
do_not_calibrate_physical; held boards stay held.

  gen_phase16.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import traceability as tr      # noqa: E402
import calibration as cal      # noqa: E402
import redesign_engine as rde  # noqa: E402
import validation as va        # noqa: E402
import instruments as ins      # noqa: E402

RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "runs")
TARGETS = ["fl1-core-controller-v2", "fl1-core-digital-v2", "fl1-core-relay-v2", "fl1-cal-board"]


def _w(name, obj):
    for r in TARGETS:
        d = os.path.join(RUNS, r, "data")
        os.makedirs(d, exist_ok=True)
        json.dump(obj, open(os.path.join(d, name + ".json"), "w"), indent=1)


# ---- P1-2, 5, 9, 11: models + serial plan ----
plan = tr.serial_plan()
_w("fl1-board-identity-model", tr.identity_model())
_w("fl1-batch1-serial-plan", plan)
_w("calibration-state-model", cal.calibration_state_model())
_w("measurement-uncertainty-policy", cal.uncertainty_policy())
_w("validation-evidence-ledger-model", tr.ledger_model())
_w("fl1-incoming-inspection-workflows", tr.inspection_workflows())
_w("fl1-batch1-calibration-verification-workflows", cal.batch1_cal_workflows())
_w("fl1-failure-taxonomy", tr.failure_taxonomy())
_w("closed-loop-redesign-engine", rde.engine_model())
_w("revb-redesign-package-model", tr.revb_package_model())

# ---- P7: bring-up workflows via the Phase 14 command layer ----
core_br = {"boards": [{"board": b["board_type"], "recommendation": "ready_to_build"}
                      for b in tr.BATCH1]}
wt = va.fl1_workflow_templates(core_br)
wfs = {w["target_board"]: w for w in wt["workflows"]}
bringup = {"version": "v1", "workflows": [
    {**wfs[b["board_type"]],
     "identity_steps": ["confirm board identity (serial + QR + board-ID EEPROM @0x50)"],
     "power_policy": "safe current-limited power-on (set_current_limit before set_power)"}
    for b in tr.BATCH1 if b["board_type"] in wfs]}
_w("fl1-batch1-bringup-workflows", bringup)

# ---- P12: batch1 traceability package + held-board status ----
batch1_pkg = {"version": "v1", "boards": []}
for b in tr.BATCH1:
    serials = [s for s in plan["serials"] if s["board_type"] == b["board_type"]]
    batch1_pkg["boards"].append({
        "board_type": b["board_type"], "board_name": b["board_name"],
        "identity_records": serials,
        "incoming_inspection": "fl1-incoming-inspection-workflows",
        "bringup_workflow": "fl1-batch1-bringup-workflows",
        "calibration_workflow": "fl1-batch1-calibration-verification-workflows",
        "evidence_ledger": "append-only per serial",
        "failure_mapping": "fl1-failure-taxonomy",
        "revb_package_stub": {"original_board_name": b["board_name"],
                              "original_board_revision": "V2/revA",
                              "status": "no failures yet — stub only",
                              "human_approval_required": True},
    })
_w("phase16-batch1-traceability-package", batch1_pkg)

HELD = [
    ("calibration_reference", "do_not_build: blocked_by_grid_resolution (ADS1115 4-way "
     "fine-pitch escape)", "finer-grid fanout or via-in-pad", True, True, True),
    ("dmm_lite", "needs_ingestion; NO calibrated-precision claim", "part ingestion + "
     "calibration path", True, True, False),
    ("power_current_monitor", "needs_ingestion (monitor part + shunt pattern)",
     "ingestion + protected-rail pattern", True, True, False),
    ("external_instrument_interface", "needs_ingestion (connector/level-shift set)",
     "ingestion + protection pattern", True, True, False),
    ("stimulus_funcgen_lite", "needs_reference; NO function-generator-class claim",
     "DAC/output-stage reference + signoff", True, True, False),
    ("logic_capture", "needs_simulation; NO logic-analyzer-class timing claim",
     "timing/capture capability", True, True, False),
    ("scope_lite", "unsupported: no fast ADC/AFE/clocking/capture", "real scope-class "
     "hardware capability", False, True, False),
]
_w("phase16-held-board-status", {"version": "v1", "boards": [
    {"board": n, "why_held": why, "missing_capability": cap_needed,
     "can_mock": mock, "architecture_only": arch, "revb_planning_applicable": revb,
     "physical_calibration": "do_not_calibrate_physical"}
    for n, why, cap_needed, mock, arch, revb in HELD]})

# ---- P14: demo runs (ALL simulated) ----
mock = ins.MockAdapter()
demos, ledger = [], []
for b in tr.BATCH1:
    wf = wfs.get(b["board_type"])
    sn = "FL1-%s-V2-0001" % b["code"]
    run = va.run_workflow(wf, mock, "p16-%s" % b["board_type"])
    entry = tr.ledger_entry(run, sn, wf["workflow_name"], "simulated")
    demos.append({"demo": "%s mock bring-up" % b["board_type"], "run": run,
                  "ledger_entry": entry, "final_verdict": run["final_verdict"]})
    ledger.append(entry)

# demo 4: relay failure -> taxonomy -> redesign recommendation, evidence preserved
fail = tr.failure_record("relay_stuck", "FL1-RM-V2-0001", "relay_probe_matrix",
                         "route_channel", "K2 (contact welded, SIMULATED)",
                         cause="simulated stuck relay for demo", severity="major",
                         redesign_candidate=True, evidence_links=["EV-FL1-RM-V2-0001-p16-relay-fail"])
rec = rde.recommend({**fail, "failure_class": "relay_stuck"})
fail_run = {"run_id": "p16-relay-fail", "board_id": "relay_probe_matrix",
            "command_log": [{"command": "route_channel", "status": "ok"},
                            {"command": "measure_continuity", "status": "ok",
                             "pass_fail": "fail", "note": "SIMULATED stuck contact"}],
            "measurement_records": [{"node": "K2", "value": True,
                                     "evidence_status": "simulated_evidence"}],
            "warnings": ["SIMULATED — not physical evidence"], "errors": [],
            "final_verdict": "simulated_fail", "adapter_list": ["mock-0"]}
fail_entry = tr.ledger_entry(fail_run, "FL1-RM-V2-0001", "relay_probe_matrix_bringup",
                             "simulated", redesign_id=rec["recommendation_id"])
ledger.append(fail_entry)   # failed evidence PRESERVED in the ledger
demos.append({"demo": "relay failure demo (SIMULATED)", "run": fail_run,
              "ledger_entry": fail_entry, "failure_record": fail,
              "redesign_recommendation": rec, "final_verdict": "simulated_fail"})

# demo 5: cal board physical calibration BLOCKED
demos.append({"demo": "calibration_reference physical calibration",
              "final_verdict": "do_not_calibrate_physical",
              "reason": "do_not_build / blocked_by_grid_resolution — no physical board "
                        "can exist; mock workflow allowed for WORKFLOW TESTING only",
              "mock_workflow_allowed": True, "physical_blocked": True})

_w("phase16-demo-runs", {"version": "v1", "demo_count": len(demos), "demos": demos,
                         "evidence_ledger": ledger,
                         "note": "ALL demo evidence is simulated; none satisfies "
                                 "physical validation"})

print("Phase 16: %d serials, %d demos, %d ledger entries" %
      (len(plan["serials"]), len(demos), len(ledger)))
for d in demos:
    print("  %-46s -> %s" % (d["demo"], d["final_verdict"]))
print("relay redesign rec: %s (%s, human_review=%s, auto=%s)" %
      (rec["recommendation_id"], rec["recommendation_type"],
       rec["required_human_review"], rec["automatic_redesign_allowed"]))
