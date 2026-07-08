"""M10R regression: RF gates replay through M3B evidence."""
import json
import os
import sys

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


rep = art("m10r-rf-replay-report")
check("1 replay report exists, sourced from the quarantine",
      rep is not None and "m7-m12-pre-hardening" in rep["replayed_from"])
check("2 every RF request -> architecture_only; non-RF passes through",
      rep["rf_requests_never_pass"] is True
      and rep["non_rf_passthrough"] is True)
m3b = rep["m3b_connection"]
check("3 openEMS missing state RECORDED (not faked)",
      m3b["openEMS"]["found"] is False
      and "never faked" in m3b["openEMS"]["consequence"])
check("4 zero local S-parameter/Touchstone files recorded",
      m3b["touchstone_files_local"]["found"] is False)
check("5 rf/antenna/EMC claim gates all blocked",
      m3b["rf_performance_claim"]["state"] == "blocked"
      and m3b["antenna_performance_claim"]["state"] == "blocked"
      and m3b["EMC_claim"]["state"] == "blocked")
check("6 M3B RF benchmark replay: adapter architecture_only, openEMS "
      "unavailable",
      m3b["rf_benchmark_replay"]["rf_adapter_request"] == "architecture_only"
      and m3b["rf_benchmark_replay"]["openems_run"] == "unavailable")
lora = rep["lora_module_policy"]
check("7 LoRa module-contained; board-level RF claim: none",
      lora["policy"] == "module-contained"
      and lora["gate_on_lora"] == "architecture_only"
      and "blocked" in lora["board_level_rf_performance_claim"])
bc = art("m10r-rf-blocked-claims")
check("8 blockers cite recorded states: stackup/solver/S-params/measurement/"
      "launch",
      all(k in bc["blocker_citations"] for k in
          ("missing_stackup", "missing_solver", "missing_s_parameters",
           "missing_measurement", "rf_connector_launch")))
check("9 blocked claims: impedance/antenna/EMC/link budget/radiated power",
      all(c in bc["blocked_claims"] for c in
          ("impedance_correctness", "antenna_performance", "EMC",
           "link_budget", "radiated_power")))
check("10 physical ledger untouched; no ordering action",
      rep["physical_ledger"]["artifacts"] == []
      and rep["physical_ledger"]["order_status"] == "not_ordered"
      and rep["no_ordering_action"] is True)

npass = sum(1 for ok in checks if ok)
print("%d/%d M10R checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
