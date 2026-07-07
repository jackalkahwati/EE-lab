"""Phase 16.7 regression: calibration role completion + board-ID addressing.

Rails: strategy exists + bounds collisions, all four boards role-complete with
straps + v2 header, cal history preserved, nothing ordered, no production claim.

  python3 test_phase167.py
"""
import json
import os
import sys

import role_completeness as rc

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")
V4 = os.path.join(RUNS, "fl1-cal-board-v4", "data")


def art(name, d=V4):
    p = os.path.join(d, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


# 1-3: strategy + primitives v2
strat = art("fl1-board-id-addressing-strategy")
check("1 addressing strategy generated + per-slot straps selected",
      strat and strat["selected"] == "per_slot_address_straps")
check("2 FL-1 bus header v2 generated (2x07 + ID_A0-A2)",
      art("fl1-bus-header-v2")["pins"]["9"] == "ID_A0")
check("3 board-ID EEPROM v2 generated (straps + pull-downs)",
      "straps" in art("board-id-eeprom-v2")["addressing"])

# 4-5: collision detected (v1 review) + resolved/bounded (v2)
v1 = art("fl1-batch1-cross-board-integration-review",
         os.path.join(RUNS, "fl1-cal-board-v3", "data"))
check("4 EEPROM address collision was detected (v1 review)",
      v1 and any("CONFLICT" in f["status"] for f in v1["findings"]))
v2 = art("fl1-batch1-cross-board-integration-review-v2")
check("5 strategy resolves + explicitly bounds collisions",
      any(f["item"] == "board-ID EEPROM address plan" and f["status"] == "RESOLVED"
          and "8-slot limit" in f["detail"] for f in v2["findings"])
      and "8 boards per I2C segment" in strat["limitation"])

# 6-12: cal board role-complete on the REAL v4 board
base = os.path.join(RUNS, "fl1-cal-board-v4")
txt = open(os.path.join(base, "variant.kicad_pcb")).read()
dev = json.load(open(os.path.join(base, "data", "devices.json")))
rep = rc.check_role("calibration_reference", txt, dev)
check("6 cal board uses role-complete primitives",
      rep["status"] == "role_complete_with_review", rep["status"])
check("7 cal board has mounting holes", txt.count('footprint "MountingHole:') >= 4)
check("8 cal board has functional silkscreen", txt.count("(gr_text ") >= 5)
check("9 cal board uses the v2 bus header", "PinHeader_2x07" in txt)
check("10 cal board has labeled test points", txt.count('footprint "TestPoint:') >= 4)
lr = json.load(open(os.path.join(base, "data", "last-run.json")))
drc = json.load(open(os.path.join(base, "data", "drc.json")))
viol = len([v for v in (drc.get("violations") or []) if v.get("type") != "solder_mask_bridge"])
check("11 cal board physically passes (real pipeline)",
      lr.get("status") == "PASSED" and viol == 0)
check("12 role-completeness checked for calibration role",
      "calibration_reference" in rc.ROLE_CHECKS)

# 13-16: impact report + integration v2 + FA v3 + form v3
check("13 core-board addressing impact report generated",
      art("fl1-core-board-addressing-impact-report") is not None)
check("14 cross-board integration review v2 generated", v2 is not None)
fa3 = art("fl1-final-first-article-review-v3")
check("15 FA review v3 generated + all four order_3_pcba",
      fa3 and "ALL FOUR" in fa3["batch_decision"])
check("16 human approval form v3 generated + human-decision rule",
      os.path.exists(os.path.join(V4, "fl1-batch1-human-approval-form-v3.md"))
      and "does not submit orders" in open(os.path.join(V4, "fl1-batch1-human-approval-form-v3.md")).read())

# 17-19: history preserved, nothing ordered/production
cal_row = next(b for b in fa3["boards"] if b["board"] == "calibration_reference")
check("17 cal board failure history preserved in the review",
      "do_not_build" in cal_row["history"])
check("18 no board ordered automatically",
      all(b["approval_status"] == "PENDING_HUMAN_REVIEW" for b in fa3["boards"]))
check("19 no production-ready claim", "production-ready" in fa3["note"])

# 20: core v2.1 boards role-complete with straps
for role, run in [("controller_backplane", "fl1-core-controller-v21"),
                  ("digital_bringup", "fl1-core-digital-v21"),
                  ("relay_probe_matrix", "fl1-core-relay-v21")]:
    b2 = os.path.join(RUNS, run)
    t2 = open(os.path.join(b2, "variant.kicad_pcb")).read()
    d2 = json.load(open(os.path.join(b2, "data", "devices.json")))
    r2 = rc.check_role(role, t2, d2)
    check("20 %s v2.1 role-complete + straps" % role,
          r2["status"].startswith("role_complete") and '"ID_A0"' in t2, r2["status"])

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 16.7 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
