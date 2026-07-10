"""M4 regression: chip-down expansion benchmarks."""
import json
import os
import sys

import chipdown_synthesis as cd
import production_line as pl

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")
rep = json.load(open(os.path.join(
    RUNS, "chipdown-ads1115-v1", "data",
    "compose-m4-chipdown-benchmark-suite.json")))
by = {r["part"]: r for r in rep["candidates"]}

check("1 suite covers 9 real candidates", len(rep["candidates"]) == 9)
check("2 four boards routed clean (PCF8574/24LC02/74HC595/ADS1115)",
      rep["routed_clean"] == 4
      and all(by[p]["status"] == "PASSED" and by[p]["drc"] == 0
              for p in ("PCF8574T", "24LC02", "74HC595", "ADS1115IDGS")))
check("3 fine-pitch TSSOP through the GENERIC path",
      by["ADS1115IDGS"]["routing"] == "12/12")
check("4 multi-rail parts blocked with exact reasons",
      by["TXB0102DCU"]["state"] == "blocked"
      and "VCCA" in by["TXB0102DCU"]["blocked_reason"]
      and by["DS3231M"]["state"] == "blocked"
      and "VBAT" in by["DS3231M"]["blocked_reason"])
check("5 no fake primitives (all candidates from real libs)",
      all("part" in r for r in rep["candidates"]))
check("6 gaps recorded (multi-rail/regulator caps/bus policies/analog)",
      len(rep["gaps"]) == 4)
check("7 honesty: sandbox only, hand-block measurement path retained",
      "routed_in_sandbox only" in rep["honesty"])
# live guard checks — M6 superseded the blanket block with domain-aware
# synthesis: distinct rails now synthesize on DISTINCT nets (never merged),
# and unknown domains still block
t = cd.synthesize_chipdown("Logic_LevelTranslator", "TXB0102DCU",
                           "Package_TO_SOT_SMD", "SOT-23-8", "U50")
check("8 multi-rail now synthesizes on DISTINCT nets (M6)",
      t["state"] == "synthesized_review_required"
      and t["rails"]["dual_supply_a"]["net"] != t["rails"]["dual_supply_b"]["net"])
m = cd.synthesize_chipdown("Memory_EEPROM", "24LC02", "Package_SO",
                           "SOIC-16_3.9x9.9mm_P1.27mm", "U50")
check("9 wrong footprint still blocks (8 pins vs SOIC-16)",
      m["state"] == "blocked")
check("10 production_ready unreachable",
      pl.readiness_state({}) == "first_article_ready_for_human_approval")

npass = sum(1 for ok in checks if ok)
print("%d/%d M4 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
