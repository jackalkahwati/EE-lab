"""M7 regression: BGA verified part, honest emitter gap."""
import json
import os
import sys

import chipdown_synthesis as cd

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
rep = json.load(open(os.path.join(
    HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs",
    "bare-mcu-qfn56-core-sandbox-v1", "data",
    "compose-m7-bga-verified-part-report.json")))
vp = rep["verified_part"]
check("1 real BGA part verified (121 pins == 121 balls)",
      vp["symbol_pins"] == 121 and vp["footprint_balls"] == 121
      and vp["symbol_ball_match"] is True)
check("2 ball-name pin sort works (parser upgraded)",
      len(cd.parse_symbol("FPGA_Lattice", "ICE40HX4K-BG121")[0]) == 121)
check("3 escape feasibility estimated (11x11: outer2=72, interior=49)",
      rep["escape_feasibility"]["outer_two_rings"] == 72
      and rep["escape_feasibility"]["interior_balls"] == 49)
check("4 sandbox NOT attempted (emitter gap exact)",
      rep["sandbox_attempt_allowed"] is False
      and "BALL-GRID ESCAPE EMITTER" in rep["exact_gap"])
check("5 verdict stays architecture_only (upgraded, not overclaimed)",
      "architecture_only" in rep["verdict"])
check("6 DDR/PCIe/FPGA-functionality claims blocked",
      "DDR" in rep["blocked_claims"]
      and "FPGA functionality" in rep["blocked_claims"])
check("7 nothing faked", "no primitive was faked" in rep["no_fake"])

npass = sum(1 for ok in checks if ok)
print("%d/%d M7 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
