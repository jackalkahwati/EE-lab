"""Milestone M1 regression: chip-down component synthesis v1."""
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
D = os.path.join(RUNS, "chipdown-pcf8574-v1", "data")


def art(name, d=D):
    p = os.path.join(d, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


pins, how = cd.parse_symbol("Interface_Expansion", "PCF8574T")
check("1 extends inheritance resolved (PCF8574T -> TCA9534)",
      len(pins) == 16 and "extends -> TCA9534" in how)
pins2, how2 = cd.parse_symbol("MCU_RaspberryPi", "RP2040")
check("2 direct symbols still parse (RP2040: 57)",
      len(pins2) == 57 and how2 == "direct")
e = cd.synthesize_chipdown("Interface_Expansion", "PCF8574T",
                           "Package_SO", "SOIC-16_3.9x9.9mm_P1.27mm", "U40")
check("3 synthesis produces review-required entry",
      e["state"] == "synthesized_review_required")
check("4 policy: VDD/GND/I2C/straps/INT/IO all assigned",
      e["pmap"]["16"] == "+3V3" and e["pmap"]["8"] == "GND"
      and e["pmap"]["15"] == "I2C_SDA" and e["pmap"]["14"] == "I2C_SCL"
      and e["straps"] == ["1", "2", "3"] and e["pullups"] == ["EXP_INT"]
      and len(e["exposed_io"]) == 8)
bad = cd.synthesize_chipdown("Interface_Expansion", "NO_SUCH_PART",
                             "Package_SO", "SOIC-16_3.9x9.9mm_P1.27mm", "U40")
check("5 unknown symbol blocks", bad["state"] == "blocked")
m = cd.synthesize_chipdown("Interface_Expansion", "PCF8574T",
                           "Package_SO", "SOIC-8_3.9x4.9mm_P1.27mm", "U40")
check("6 pad-count mismatch blocks (16 pins vs SOIC-8)",
      m["state"] == "blocked" and m["gate"] == "footprint verification")
rep = art("compose-chipdown-synthesis-v1-report")
check("7 milestone report exists (never-hand-blocked part)",
      rep["proof_part"]["never_hand_blocked"] is True)
check("8 REAL run passed (15/15, 0 DRC)",
      rep["proof_run"]["status"] == "PASSED"
      and rep["proof_run"]["routing"] == "15/15"
      and rep["proof_run"]["drc"] == 0)
check("9 parser fixes recorded (string-aware scan caught pin theft)",
      any("steal" in f for f in rep["parser_fixes"]))
check("10 no functional claim",
      "not proven to respond" in rep["honesty"])
rm = art("compose-roadmap-to-generic-pcba-generator")
check("11 roadmap updated (9 milestones remaining, physical loop blocked "
      "on signature)", len(rm["milestones_remaining"]) == 9)
flu = art("compose-chipdown-fleet-learning-update")
check("12 fleet update: next = bare-MCU product board",
      "Pico replacement" in flu["next_recommendation"]["recommendation"])
check("13 gaps honest (SPI/UART policy, decoupling values)",
      any("decoupling" in g for g in flu["gaps"]))
pk = art("compose-chipdown-pack-registry-update")
check("14 pack scoped to the proven part",
      "PCF8574/SOIC-16 scope" in
      pk["new_pack"]["chipdown_synthesis_pack"]["state"])
check("15 production_ready unreachable",
      pl.readiness_state({}) == "first_article_ready_for_human_approval")
led = art("compose-physical-evidence-ledger",
          os.path.join(RUNS, "power-entry-header-2l", "data"))
check("16 physical ledger untouched (still empty, nothing ordered)",
      led["artifacts"] == [] and led["order_status"] == "not_ordered")

npass = sum(1 for ok in checks if ok)
print("%d/%d Milestone M1 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
