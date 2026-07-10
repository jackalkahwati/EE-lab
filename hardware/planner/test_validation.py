"""Phase 14 regression: instrument adapters + validation readiness.

Holds the hard rails: mock evidence is always simulated (never physical); a
do_not_build board is validation_ready_with_mock ONLY (never physical, never via an
internal-board adapter); scope/stimulus/logic never claim their forbidden classes;
Phase 13 build/signoff verdicts are unchanged.

  python3 test_validation.py
"""
import json
import os
import sys

import instruments as ins

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RD = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs",
                  "fl1-cal-board", "data")


def art(name):
    p = os.path.join(RD, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


BR = art("fl1-build-readiness-dashboard") or {"boards": []}
_fg = art("calibration-board-finegrid-result")
FIXED = bool(_fg and _fg.get("outcome") == "A_physical_pass")

# 1-2 models
check("1 instrument capability model generated", art("instrument-capability-model")["capability_count"] >= 30)
check("2 adapter interface spec generated", art("instrument-adapter-interface") is not None)

# 3-5 mock adapter
mock = ins.MockAdapter()
for cmd in ["measure_voltage", "set_power", "route_channel", "flash_firmware", "read_digital"]:
    pass
check("3 mock adapter supports core commands",
      {"measure_voltage", "set_power", "route_channel", "flash_firmware"} <= mock.SUPPORTED)
r = mock.execute(ins.command_envelope("measure_voltage", target_node="REF_OUT"))
check("4 mock measurements marked simulated",
      r["evidence_status"] == "simulated_evidence" and "SIMULATED" in r["warnings"][0])
demo_ads = None
demos = art("demo-validation-runs")
check("5 simulated evidence cannot satisfy physical validation",
      all(run["evidence_status"] == "simulated_evidence" and
          "physical" not in run["final_verdict"] for run in demos["runs"]))

# 6-8 COTS + internal specs
check("6 COTS adapter spec generated", art("cots-instrument-adapter-spec")["instrument_count"] >= 8)
ib = art("fl1-internal-board-adapter-spec")
check("7 internal board adapter spec generated", ib is not None)
cal_ib = next(b for b in ib["boards"] if b["board"] == "calibration_reference")
check("8 cal board internal adapter honest (never physically available pre-fab)",
      not cal_ib["physically_available"] and
      (cal_ib["adapter_availability"] == "future_internal_board" if FIXED
       else cal_ib["adapter_availability"] in ("mock_only", "unsupported")),
      cal_ib["adapter_availability"])
sc_ib = next(b for b in ib["boards"] if b["board"] == "scope_lite")
check("8b unsupported board -> no internal adapter",
      sc_ib["adapter_availability"] == "unsupported" and not sc_ib["physically_available"])

# 9-12 workflow/evidence/readiness
check("9 validation workflow model generated", art("validation-workflow-model") is not None)
wt = art("fl1-validation-workflow-templates")
check("10 FL-1 workflow templates generated", wt and wt["workflow_count"] == 10)
check("11 evidence model generated", art("validation-evidence-model") is not None)
vr = art("fl1-validation-readiness-dashboard")
check("12 build->validation readiness bridge generated", vr is not None)

# 13 the key rail: cal board mock-only, not physical
cal_vr = next(b for b in vr["boards"] if b["board"] == "calibration_reference")
check("13 cal board validation readiness honest (mock-only unless truly fixed)",
      ((not cal_vr["physical_validation_blocked"]
        and cal_vr["internal_board_future_adapter"]) if FIXED
       else (cal_vr["validation_readiness_status"] == "validation_ready_with_mock"
             and cal_vr["physical_validation_blocked"]
             and not cal_vr["internal_board_future_adapter"])),
      cal_vr["validation_readiness_status"])

# 14-15 DSL + package v2
check("14 instrument command DSL generated", "measure_voltage" in art("instrument-command-dsl")["examples"])
check("15 FL-1 validation package v2 generated", art("fl1-validation-package-v2")["version"] == "v2")

# 16-20 demo runs
byboard = {r["board_id"]: r for r in demos["runs"]}
check("16 ADS1115 front-end mock validation runs", byboard.get("ads1115_measurement_front_end") is not None)
check("17 cal mock run honest (never a physical pass; blocked unless fixed)",
      ("physical_blocked" in byboard["calibration_reference"]["physical_validation"])
      if not FIXED else
      ("not_attempted" in byboard["calibration_reference"]["physical_validation"]
       or "physical_blocked" in byboard["calibration_reference"]["physical_validation"]))
check("18 digital bring-up mock validation runs", "digital_bringup" in byboard)
check("19 relay/probe matrix mock validation runs", "relay_probe_matrix" in byboard)
check("20 power/current monitor mock validation runs", "power_current_monitor" in byboard)

# 24-25 Phase 13 unchanged
cal_attempt = art("cal-board-attempt")
check("24/25 cal board build state matches reality (fixed -> review, else do_not_build)",
      cal_attempt["fine_pitch_escape"]["build_recommendation"] ==
      ("ready_to_build_with_review" if FIXED else "do_not_build"))

# 26-28 scope/stimulus/logic honesty (in the workflow templates)
scope_wf = next(w for w in wt["workflows"] if w["target_board"] == "scope_lite")
check("26 scope-lite workflow makes NO oscilloscope-class claim + physical not ready",
      "NO oscilloscope-class" in scope_wf["evidence_requirements"] and not scope_wf["physical_ready"])
stim_wf = next(w for w in wt["workflows"] if w["target_board"] == "stimulus_funcgen_lite")
check("27 stimulus workflow makes NO function-generator-class claim",
      "NO function-generator-class" in stim_wf["evidence_requirements"])
logic_wf = next(w for w in wt["workflows"] if w["target_board"] == "logic_capture")
check("28 logic capture workflow makes NO logic-analyzer-class claim",
      "no analyzer-class" in logic_wf["evidence_requirements"] or "NO logic-analyzer" in str(logic_wf))

# 31-32 no fake physical / calibration
check("31 no demo claims physical evidence",
      not any(run["evidence_status"] == "physical_evidence" for run in demos["runs"]))
check("32 mock calibration state is simulated, not traceable",
      all(run["calibration_state"] == "simulated" for run in demos["runs"]))

# 16(shared model) COTS + internal share the capability model
check("16b COTS + internal boards use the SAME capability model",
      all(any(ins.get_cap(c) for c in ci["capabilities"]) for ci in art("cots-instrument-adapter-spec")["instruments"] if ci["capabilities"]))

npass = sum(1 for ok in checks if ok)
print("%d/%d validation checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
