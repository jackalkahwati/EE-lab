"""Fine-pitch escape regression (Phase 13 gate A/B/C).

The escape is the first gate: the model must exist, the ADS1115 4-way escape must
be ATTEMPTED, and the result must be an exact pass or an exact blocker (never a
fake pass, never a dropped net).

  python3 test_fine_pitch.py
"""
import json
import os
import sys

import fine_pitch_escape as fpe
import ingest_library as il

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")

ads = il.get("ADS1115IDGS")
nm4 = {"9": "I2C_SDA", "10": "I2C_SCL", "4": "REF_OUT", "5": "REF_DIV", "8": "+3V3", "3": "GND"}
e = fpe.model_component(ads, nm4)

# gate A: the model exists and detects the fine-pitch part
check("10 fine-pitch escape model detects ADS1115", e is not None and e["package"] == "TSSOP")

# 11: the ADS1115 4-way escape is ATTEMPTED (all 4 signal escapes identified, none dropped)
esc = {x["name"] for x in e["required_escape_pins"]}
check("11 ADS1115 4-way escape attempted (SDA/SCL/AIN0/AIN1)",
      {"SDA", "SCL", "AIN0", "AIN1"} <= esc, str(sorted(esc)))

# 12/13: dense_escape with an EXACT grid blocker, and NO net silently dropped
check("12 dense_escape with exact blocker (not vague)",
      e["expected_difficulty"] == "dense_escape" and "grid" in (e["blocker"] or ""),
      e["expected_difficulty"])
check("13 no ADS1115 analog/I2C net dropped from the model",
      {x["net"] for x in e["required_escape_pins"]} >= {"REF_OUT", "REF_DIV", "I2C_SDA", "I2C_SCL"})

# classification honesty: coarse parts are NOT fine-pitch; a single escape is moderate
check("coarse SOIC/SOT parts are not flagged fine-pitch",
      fpe.model_component(il.get("24LC02"), {"5": "I2C_SDA"}) is None
      and fpe.model_component(il.get("REF3025"), {"2": "REF_OUT"}) is None)
check("single fine-pitch escape is moderate, not dense",
      fpe.model_component(ads, {"9": "I2C_SDA"})["expected_difficulty"] == "moderate_escape")

# a synthetic BGA is unsupported_escape
bga = {"mpn": "X", "kicad_footprint": "Package_BGA:BGA-64", "pins": ads["pins"]}
check("BGA -> unsupported_escape", fpe.model_component(bga, nm4)["expected_difficulty"] == "unsupported_escape")

# gate C on the real cal board: exact result recorded, do_not_build, no fake pass
cal = os.path.join(RUNS, "fl1-cal-board", "data", "cal-board-attempt.json")
if os.path.exists(cal):
    a = json.load(open(cal))
    fp = a.get("fine_pitch_escape", {})
    check("cal board records EXACT escape result + do_not_build",
          fp.get("exact_blocker") == "blocked_by_grid_resolution"
          and fp.get("build_recommendation") == "do_not_build"
          and a["outcome"] != "A_pass",
          "%s / %s" % (fp.get("result"), fp.get("build_recommendation")))
    check("cal board escape did NOT fake a pass or drop a net",
          "7/7" in fp.get("logical_routing", "") and fp.get("result") == "escaped_but_drc_failed")
else:
    check("cal board escape result present", False)
    check("cal board no fake pass", False)

# escape-model artifact is generated for the run
check("15 fine-pitch-escape-model.json artifact generated",
      os.path.exists(os.path.join(RUNS, "fl1-cal-board", "data", "fine-pitch-escape-model.json")))

npass = sum(1 for ok in checks if ok)
print("%d/%d fine-pitch checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
