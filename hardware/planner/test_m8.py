"""M8 regression: advanced fab gates."""
import json
import os
import sys

import advanced_fab as af

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
rep = json.load(open(os.path.join(
    HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs",
    "bare-mcu-qfn56-core-sandbox-v1", "data",
    "compose-m8-advanced-fab-gates.json")))
g = rep["gate_results"]
check("1 five fab profiles modeled", len(rep["profiles"]) == 5)
check("2 proven classes allowed (2L/4L)",
      g["simple 2L power board"]["verdict"] == "allowed"
      and g["QFN-56 core (4L)"]["verdict"] == "allowed")
check("3 coarse full-array BGA -> architecture_only (6L gap exact)",
      g["coarse full-array BGA-121 (iCE40)"]["verdict"] == "architecture_only")
check("4 fine BGA -> HDI required + blocked",
      "HDI microvias" in str(g["fine BGA 0.5mm"]["reasons"])
      and g["fine BGA 0.5mm"]["verdict"] == "architecture_only")
check("5 WLCSP -> HDI architecture_only",
      g["WLCSP"]["verdict"] == "architecture_only")
check("6 blocked claims include HDI readiness + via-in-pad",
      "HDI readiness" in g["WLCSP"]["blocked_claims"])
check("7 6-layer stackup honestly absent",
      "not implemented" in af.FAB_PROFILES["fab_6layer_std"]["state"])
check("8 gates refuse to pretend", "REFUSE" in rep["honesty"])

npass = sum(1 for ok in checks if ok)
print("%d/%d M8 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
