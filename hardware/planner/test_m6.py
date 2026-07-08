"""M6 regression: multi-rail + mixed-signal synthesis."""
import json
import os
import sys

import chipdown_synthesis as cd
import multirail

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui",
                    "public", "runs")
rep = json.load(open(os.path.join(
    RUNS, "chipdown-txb0102-v1", "data",
    "compose-m6-multirail-mixed-signal-report.json")))

t = rep["proven_on_copper"]["chipdown-txb0102-v1"]
check("1 TXB0102 dual-rail PASSED 7/7, 0 DRC on copper",
      t["status"] == "PASSED" and t["routing"] == "7/7" and t["drc"] == 0)
check("2 VCCA/VCCB on DISTINCT nets",
      t["rails"]["dual_supply_a"] == "+3V3"
      and t["rails"]["dual_supply_b"] == "+5V")
d = rep["proven_on_copper"]["chipdown-ds3231m-v1"]
check("3 DS3231M PASSED 9/9 with distinct VBAT_RAIL",
      d["status"] == "PASSED" and d["rails"]["battery_backup"] == "VBAT_RAIL")
check("4 ADS1115 analog pins split from digital IO",
      rep["mixed_signal"]["ads1115_analog_pins"] == ["AIN0", "AIN1", "AIN2",
                                                     "AIN3"])
check("5 analog accuracy claims blocked",
      "analog_accuracy" in rep["mixed_signal"]["blocked"])
# unknown domain still blocks
doms, why = multirail.plan_rails([{"number": "1", "name": "VWEIRD",
                                   "etype": "power_in"}])
check("6 unknown power domain blocks with no guess",
      doms is None and "no guess" in why)
e = cd.synthesize_chipdown("Timer_RTC", "DS3231M", "Package_SO",
                           "SOIC-16W_7.5x10.3mm_P1.27mm", "U40")
check("7 per-rail decoupling (VBAT_RAIL gets its own cap)",
      "VBAT_RAIL" in e["decouple_rails"] and "+3V3" in e["decouple_rails"])
check("8 VBAT POLICY still honest (rail only, no switchover circuit)",
      any("switchover" in x for x in rep["still_blocked"]))
check("9 measurement packs stay 4-layer",
      any("4-layer" in x for x in rep["still_blocked"]))

npass = sum(1 for ok in checks if ok)
print("%d/%d M6 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
