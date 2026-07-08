"""M9-M12 regression: power/RF/high-speed/reliability gates."""
import json
import os
import sys

import power_stage as ps
import rf_rules as rf
import highspeed_rules as hs
import reliability_classes as rc

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


check("1 M9 trace estimate labeled ESTIMATE, review-required",
      "ESTIMATE" in ps.trace_width_estimate(2.0)["basis"])
check("2 M9 motor board blocked (all 9 requirements missing)",
      ps.power_stage_gate({})["verdict"] == "blocked"
      and len(ps.power_stage_gate({})["missing"]) == 9)
check("3 M9 full evidence still review-required, thermal still blocked",
      "thermal_performance" in ps.power_stage_gate(
          {k: True for k in ps.REQUIRED_FOR_POWER_STAGE})["blocked_claims"])
check("4 M9 mains blocked", ps.mains_gate(230)["verdict"] == "blocked")
check("5 M9 beyond-range current blocked",
      ps.trace_width_estimate(30)["min_width_mm"] is None)
check("6 M10 RF detection -> architecture_only + impedance blocked",
      rf.rf_gate("SMA input")["verdict"] == "architecture_only"
      and "impedance_correctness" in rf.rf_gate("SMA input")["blocked_claims"])
check("7 M10 non-RF board passes through",
      rf.rf_gate("i2c sensor breakout")["verdict"] == "no_rf_content")
check("8 M11 PCIe/DDR/USB3 architecture_only",
      all(hs.hs_gate(x)["verdict"] == "architecture_only"
          for x in ("PCIe card", "DDR4 dimm", "USB3 hub")))
check("9 M11 blocked claims include eye/timing/readiness",
      "eye_diagram" in hs.BLOCKED and "PCIe_readiness" in hs.BLOCKED)
check("10 M12 space/defense architecture_only, medical blocked",
      rc.classify_request("satellite bus")[1] == "architecture_only"
      and rc.classify_request("implantable pump")[1] == "blocked")
check("11 M12 commercial standard flow unaffected",
      rc.classify_request("bench power monitor")[0] == "commercial")
HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui",
                 "public", "runs", "fl1-backplane-v1", "data")
for i, name in enumerate(["compose-m9-power-stage-rules",
                          "compose-m10-rf-rules",
                          "compose-m11-highspeed-rules",
                          "compose-m12-reliability-classes"]):
    check("%d artifact %s exists" % (12 + i, name),
          os.path.exists(os.path.join(D, name + ".json")))

npass = sum(1 for ok in checks if ok)
print("%d/%d M9-M12 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
