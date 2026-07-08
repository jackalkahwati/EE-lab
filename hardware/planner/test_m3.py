"""M3 regression: physical execution — no fake evidence, no auto-order."""
import json
import os
import shutil
import sys
import tempfile

import physical_execution as px

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")
LIVE = os.path.join(RUNS, "power-entry-header-2l")

r = px.execute(LIVE)
check("1 no signature -> state stays package_ready_with_review",
      r["state"] == "package_ready_with_review")
check("2 nothing ingested from empty evidence dir", r["artifacts_ingested"] == 0)
check("3 promotion blocked on physical evidence",
      r["promotion"] == "blocked_on_physical_evidence")
check("4 next action is a HUMAN signature", "HUMAN: sign" in r["next_action"])
check("5 prohibitions include no-auto-order and no-spend",
      "no auto-order" in r["prohibitions"] and "no spend" in r["prohibitions"])

# fixture: a TEST-ONLY copy with fake/simulated/unitless evidence — the
# executor must reject all three (never written to the live ledger)
tmp = tempfile.mkdtemp()
d = os.path.join(tmp, "data")
os.makedirs(os.path.join(d, "evidence"))
shutil.copy(os.path.join(LIVE, "data",
                         "power-entry-header-v1-order-approval-checklist.json"),
            os.path.join(d, "power-entry-header-v1-order-approval-checklist.json"))
json.dump({"artifact_type": "voltage_readings", "board_id": "x", "run_id": "y",
           "datetime": "t", "operator": "jack", "measurement_value": 3.3,
           "units": "V", "simulated": True},
          open(os.path.join(d, "evidence", "sim.json"), "w"))
json.dump({"artifact_type": "voltage_readings", "board_id": "x", "run_id": "y",
           "datetime": "t", "operator": "jack", "measurement_value": 3.3},
          open(os.path.join(d, "evidence", "nounits.json"), "w"))
json.dump({"artifact_type": "continuity_readings"},
          open(os.path.join(d, "evidence", "anonymous.json"), "w"))
r2 = px.execute(tmp)
check("6 simulated evidence rejected", any("simulated" in str(x["problems"])
      for x in r2["artifacts_rejected"] if x["file"] == "sim.json"))
check("7 unitless measurement rejected", any("units" in str(x["problems"])
      for x in r2["artifacts_rejected"] if x["file"] == "nounits.json"))
check("8 unattributed evidence rejected", any("attributable" in str(x["problems"])
      for x in r2["artifacts_rejected"] if x["file"] == "anonymous.json"))
check("9 zero ingested from all-bad fixture", r2["artifacts_ingested"] == 0)
shutil.rmtree(tmp)

led = json.load(open(os.path.join(LIVE, "data",
                                  "compose-physical-evidence-ledger.json")))
check("10 live ledger untouched (empty, nothing ordered)",
      led["artifacts"] == [] and led["order_status"] == "not_ordered")
rep = json.load(open(os.path.join(LIVE, "data",
                                  "compose-m3-physical-execution-report.json")))
check("11 M3 report honest (machinery armed, nothing faked)",
      "nothing faked" in rep["honesty"])

npass = sum(1 for ok in checks if ok)
print("%d/%d M3 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
