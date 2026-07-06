"""FL-1 Instrument Core v1 regression (Phase 15).

The core contains ONLY genuinely buildable boards (route clean, 0 DRC, PASSED). No
board is faked in; the do_not_build cal board is excluded; adapters stay
future_internal_board (not physically available); mock validation is simulated only.

  python3 test_fl1_core.py
"""
import os
import sys

import fl1_core as fc

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


core = fc.core_v1()

check("core assembles 3 buildable boards", core["board_count"] == 3)
check("core status ready_to_build", core["core_status"] == "ready_to_build", core["core_status"])

# every core board actually routed clean (real build result, not faked)
for b in core["boards"]:
    r = b["build_result"]
    check("%s routes clean (real build)" % b["id"],
          r["routes_clean"] and r["drc_violations"] == 0 and r["unconnected"] == 0
          and r["status"] == "PASSED", "%s %s DRC=%s" % (r["routed"], r["status"], r["drc_violations"]))

# adapters are future_internal_board (designed, NOT fabricated) — never physical yet
check("core adapters are future_internal_board, not physically available",
      all(b["adapter_availability"] == "future_internal_board" and not b["physically_available"]
          for b in core["boards"]))

# the do_not_build cal board is EXCLUDED from the core (honesty rail)
check("calibration_reference is EXCLUDED (do_not_build)",
      any(x["board"] == "calibration_reference" and "blocked_by_grid_resolution" in x["reason"]
          for x in core["excluded_from_core"]))
check("no do_not_build board is in the core",
      "calibration_reference" not in [b["id"] for b in core["boards"]])

# capabilities: the core provides real instrument capabilities, and is HONEST about
# the measurement/calibration gap (needs the do_not_build cal board / COTS)
cap = core["capabilities"]
check("core provides routing + digital + power capabilities",
      {"route_channel", "read_digital", "set_power"} <= set(cap["provided"].keys()))
check("core is honest about the measurement/calibration gap",
      any("measure" in c for c in cap["not_provided_by_core"]) and "COTS" in cap["gap_note"])

# interconnect models the shared instrument bus
ic = core["interconnect"]
check("interconnect: controller is bus master, shared I2C control bus",
      ic["master"] == "controller_backplane" and "I2C" in ic["shared_lines"]["control_bus"])

# core validation runs (mock) are simulated only — never physical
RD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "software",
                  "prompt-to-pcb-ui", "public", "runs", "fl1-core-relay", "data")
import json
crv = os.path.join(RD, "fl1-core-validation-runs.json")
if os.path.exists(crv):
    runs = json.load(open(crv))["runs"]
    check("core mock validation runs are simulated only",
          all(r["evidence_status"] == "simulated_evidence" and "sim" in r["final_verdict"]
              for r in runs))
else:
    check("core mock validation runs present", False)

npass = sum(1 for ok in checks if ok)
print("%d/%d FL-1 core checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
