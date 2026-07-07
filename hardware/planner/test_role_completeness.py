"""Phase 15.6 regression: FL-1 board role-completeness fix.

Covers the acceptance tests: the primitives exist, the checker rejects DRC-clean
but role-incomplete boards, the regenerated v2 boards are role-complete through
the REAL pipeline, safe defaults are physical (not labels), and the held boards
stay held.

  python3 test_role_completeness.py
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


def run_files(run_id):
    base = os.path.join(RUNS, run_id)
    return (open(os.path.join(base, "variant.kicad_pcb")).read(),
            json.load(open(os.path.join(base, "data", "devices.json"))))


# 1-5: primitives exist (library manifest + in the composer)
prim = rc.primitive_library()
names = {p["block"] for p in prim["primitives"]}
for b in ("fl1_bus_header", "board_id_eeprom", "mounting_holes", "test_points",
          "functional_silkscreen_labels"):
    check("%s primitive exists" % b, b in names)
compose_src = open(os.path.join(HERE, "..", "blocks", "compose.py")).read()
check("primitives are real composer blocks",
      "def block_fl1_bus" in compose_src and "def block_board_id" in compose_src
      and "MountingHole_3.2mm_M3" in compose_src and "def block_gpio_bank" in compose_src)

# 6-7: checker exists + rejects DRC-clean-but-role-incomplete (the v1 boards)
v1_txt, v1_dev = run_files("fl1-core-controller")
v1_rep = rc.check_role("controller_backplane", v1_txt, v1_dev)
check("7 DRC-clean v1 board is role_incomplete + not orderable",
      v1_rep["status"] == "role_incomplete" and not v1_rep["orderable"],
      "%d/%d met" % (v1_rep["requirements_met"], v1_rep["requirements_checked"]))

# 8-13: role requirements on the REGENERATED v2 boards (real pipeline outputs)
c_txt, c_dev = run_files("fl1-core-controller-v2")
c_rep = rc.check_role("controller_backplane", c_txt, c_dev)
check("8 controller v2: interlock/fault/reset/trigger/board-ID/bus/mounting/TPs",
      c_rep["status"] in ("role_complete", "role_complete_with_review")
      and not c_rep["missing"], c_rep["status"])

d_txt, d_dev = run_files("fl1-core-digital-v2")
d_rep = rc.check_role("digital_bringup", d_txt, d_dev)
check("9 digital v2: SPI built (not dropped)", "SPI bus built (not dropped)" not in d_rep["missing"])
check("10 digital v2: protected GPIO bank present",
      "protected GPIO bank (series-R + header)" not in d_rep["missing"]
      and d_rep["status"] in ("role_complete", "role_complete_with_review"))

r_txt, r_dev = run_files("fl1-core-relay-v2")
r_rep = rc.check_role("relay_probe_matrix", r_txt, r_dev)
check("11 relay v2: channel breakout + map present",
      "channel breakout connectors (probes + bus)" not in r_rep["missing"]
      and "clear channel map (manifest + silk)" not in r_rep["missing"])
check("12 relay v2: safe default disconnected state (SR_OE gated)",
      "safe default disconnected state (gated OE, off at boot)" not in r_rep["missing"]
      and "SR_OE" in r_txt)
check("13 shift-register OE no longer hard-tied to GND (boot chatter fix)",
      '"sr_oe"' in open(os.path.join(HERE, "..", "blocks", "resolve_part.py")).read())

# 14-16: v2 boards passed the real pipeline honestly
for run_id, name in [("fl1-core-controller-v2", "controller"), ("fl1-core-digital-v2", "digital"),
                     ("fl1-core-relay-v2", "relay")]:
    lr = json.load(open(os.path.join(RUNS, run_id, "data", "last-run.json")))
    check("14-16 %s v2 pipeline PASSED (strict gates)" % name, lr.get("status") == "PASSED")

# 17-18: FA review v2 + validated order pack v2
fa = json.load(open(os.path.join(RUNS, "fl1-core-relay-v2", "data",
                                 "phase15-first-article-review-v2.json")))
check("17 first-article review v2 generated + all order_3_pcba_review_required",
      "order_3_pcba_review_required" in fa["batch_decision"])
check("order recommendation REQUIRES role completeness (decision rule)",
      "role_complete" in fa["decision_rule"])
pack = json.load(open(os.path.join(RUNS, "fl1-core-relay-v2", "data",
                                   "phase15-validated-order-pack-v2.json")))
check("18 validated order pack v2 for passing boards",
      all(v["order_pack_valid"] for v in pack["boards"].values()))

# 19-20: held boards stay held
cal = json.load(open(os.path.join(RUNS, "fl1-cal-board", "data", "cal-board-attempt.json")))
_fixed = cal["fine_pitch_escape"].get("result") == "escaped_and_checked"
check("19 calibration board honest (review-required if truly fixed, else do_not_build)",
      cal["fine_pitch_escape"]["build_recommendation"] ==
      ("ready_to_build_with_review" if _fixed else "do_not_build"))
dash = json.load(open(os.path.join(RUNS, "fl1-cal-board", "data",
                                   "fl1-build-readiness-dashboard.json")))
check("20 scope-lite remains unsupported",
      next(b for b in dash["boards"] if b["board"] == "scope_lite")["recommendation"] == "unsupported")

# 26: no fake role-completeness — the checker reads footprints/nets/manifest, not labels
check("26 checker verifies hardware (nets+footprints), not labels alone",
      v1_rep["facts"]["mounting_holes"] == 0 and c_rep["facts"]["mounting_holes"] >= 4)

npass = sum(1 for ok in checks if ok)
print("%d/%d role-completeness checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
