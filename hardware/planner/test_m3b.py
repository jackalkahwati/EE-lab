"""M3B regression: external EDA evidence layer."""
import json
import os
import sys

import external_eda as ee

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public",
                 "runs", "fl1-backplane-v1", "data")


def art(name):
    p = os.path.join(D, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


inv = art("compose-external-eda-toolchain-inventory")
check("1 toolchain inventory exists (versions where possible)",
      inv is not None and inv["tools"]["ngspice"]["found"] is True
      and inv["tools"]["ngspice"]["version"] is not None)
check("2 missing tools recorded without failing generation",
      inv["tools"]["openEMS"]["found"] is False
      and any("NOT a board failure" in r for r in inv["rules"]))
sch = art("compose-external-analysis-evidence-schema")
check("3 evidence schema (statuses + types + required fields)",
      len(sch["result_statuses"]) == 9 and len(sch["analysis_types"]) == 22)
# schema enforcement
a, prob = ee.make_artifact(analysis_id="x", board_id="b", run_id="r",
                           tool_name="t", tool_availability=True,
                           analysis_type="voltage_divider_check",
                           input_artifacts=[], output_artifacts=[],
                           result_status="completed", assumptions=[],
                           blocked_claims=[],
                           computed_results=[{"name": "V", "value": 2.5}])
check("4 numeric result without units REFUSED",
      a is None and any("without units" in p for p in prob))
a2, prob2 = ee.make_artifact(analysis_id="x", board_id="b", run_id="r",
                             tool_name="t", tool_availability=True,
                             analysis_type="voltage_divider_check",
                             input_artifacts=[], output_artifacts=[],
                             result_status="passed_gate", assumptions=[],
                             blocked_claims=[], thresholds={"v": 2.5})
check("5 gate result without threshold provenance REFUSED",
      a2 is None and any("provenance" in p for p in prob2))
gates = art("compose-external-analysis-claim-gates")["gates"]
check("6 controlled impedance blocked without stackup",
      gates["controlled_impedance_claim"]["state"] == "blocked")
check("7 RF blocked without model/sim/measurement",
      gates["rf_performance_claim"]["state"] == "blocked")
check("8 high-speed SI blocked without models",
      gates["high_speed_signal_integrity_claim"]["state"] == "blocked")
check("9 PI blocked without load currents",
      gates["power_integrity_claim"]["state"] == "blocked")
check("10 calibration blocked (structurally physical)",
      gates["calibration_claim"]["state"] == "blocked")
check("11 regulator stability blocked without model",
      gates["regulator_stability_claim"]["state"] == "blocked")
spice = art("compose-spice-benchmark-report")
dv = spice["benchmarks"]["voltage_divider_10k_10k_5V"]
check("12 REAL ngspice divider run agrees with analytic (2.5V)",
      dv["ngspice"]["status"] == "completed"
      and dv["ngspice"]["Vout"]["value"] == 2.5 and dv["agreement"])
check("13 regulator missing-model report honest",
      spice["benchmarks"]["regulator_stability"]["status"] ==
      "skipped_missing_input")
imp = art("compose-impedance-stackup-hooks-v1")
check("14 impedance estimator refuses without stackup",
      imp["no_stackup_behavior"]["result_status"] == "skipped_missing_input")
check("15 fixture stackup demo labeled as fixture",
      "TEST FIXTURE" in str(imp["fixture_demo"]))
impb = art("compose-impedance-benchmark-report")["benchmarks"]
check("16 USB-C power-only board: no USB data/impedance claim",
      "NO USB data nets" in impb["usbc_power_only_board"]["finding"])
rf = art("compose-rf-benchmark-report")["benchmarks"]
check("17 RF adapter architecture_only + openEMS unavailable",
      rf["rf_adapter_request"]["verdict"] == "architecture_only"
      and rf["openems_run"]["status"] == "unavailable")
si = art("compose-si-benchmark-report")["benchmarks"]
check("18 PCIe + USB3 architecture_only; missing IBIS reported",
      si["pcie_request"]["verdict"] == "architecture_only"
      and si["usb3_request"]["verdict"] == "architecture_only"
      and si["missing_ibis_report"]["status"] == "skipped_missing_input")
pdn = art("compose-pdn-power-integrity-hooks-v1")
check("19 PDN inventories on 4 REAL boards; PI blocked",
      len(pdn["boards"]) == 4
      and all("power_integrity_claim" in b["blocked_claims"]
              for b in pdn["boards"].values()))
run = art("external-analysis-run-report")
check("20 runner report: unavailable/skipped recorded, no physical marks",
      run is not None and "power_integrity_claim" in
      run["claim_gates_blocked"])
pipe = art("compose-external-analysis-pipeline-integration-report")
check("21 pipeline modes incl. inventory_only; optional tool never fails "
      "generation", "inventory_only" in pipe["modes"]
      and "NEVER fails" in pipe["guarantees"][0])
led = art("compose-physical-evidence-ledger") or json.load(open(os.path.join(
    HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs",
    "power-entry-header-2l", "data", "compose-physical-evidence-ledger.json")))
check("22 physical ledger untouched by the sprint",
      led["artifacts"] == [] and led["order_status"] == "not_ordered")

npass = sum(1 for ok in checks if ok)
print("%d/%d M3B checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
