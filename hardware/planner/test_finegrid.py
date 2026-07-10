"""Phase 16.5 regression: fine-grid fanout / via-in-pad capability.

The rails: no dropped ADS1115 net, no ignored short, DRC/ERC strict, via-in-pad
honest (no fake fab support), HDI honest (no readiness claim), cal board verdict
matches the REAL pipeline result, Batch 1 stable + not ordered.

  python3 test_finegrid.py
"""
import json
import os
import sys


checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")
V3 = os.path.join(RUNS, "fl1-cal-board-v3", "data")
CAL = os.path.join(RUNS, "fl1-cal-board", "data")


def art(d, name):
    p = os.path.join(d, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


# 1-3: models + pre-escape report generated
check("1 fine-grid routing model generated", art(V3, "fine-grid-routing-model") is not None)
pre = art(V3, "fine-pitch-preescape-report")
check("2 local fine-grid region / exact-geometry escape modeled",
      "EXACT geometry" in art(V3, "fine-grid-routing-model")["local_grid"])
check("3 pre-escape stubs generated", pre and len(pre["escapes"]) == 4)

# 4-8: the 4-way escape attempted, no net dropped
esc_nets = {e["net"] for e in pre["escapes"]} if pre else set()
check("4 ADS1115 four-way escape attempted", len(esc_nets) == 4)
for n_i, net in enumerate(("I2C_SDA", "I2C_SCL", "REF_OUT", "REF_DIV")):
    check("%d %s not dropped" % (5 + n_i, net), net in esc_nets)

# 9-10: shorts not ignored, DRC strict — verified by the REAL run's DRC report
drc = art(V3, "drc")
viol = len([v for v in (drc.get("violations") or []) if v.get("type") != "solder_mask_bridge"])
unconn = len(drc.get("unconnected_items") or [])
res = art(V3, "calibration-board-finegrid-result")
check("9 adjacent-pin shorts not ignored (real DRC gate: %d violations)" % viol,
      res["drc_violations"] == viol)
check("10 DRC/ERC remains strict (verdict derived from the real report)",
      (res["outcome"] == "A_physical_pass") == (viol == 0 and unconn == 0))

# 11-12: via-in-pad honest
vip = art(V3, "via-in-pad-feasibility-report")
check("11 via-in-pad feasibility model exists", vip is not None)
check("12 via-in-pad cannot be order-ready without fab review",
      vip["if_needed_later"]["human_review_required"]
      and "UNCONFIRMED" in vip["if_needed_later"]["selected_manufacturer_support"]
      and any("fab capability confirmation" in r for r in vip["rules"]))

# 13: HDI placeholder honest
hdi = art(V3, "hdi-feasibility-placeholder")
check("13 HDI placeholder exists + claims NO readiness",
      hdi and "NOT implemented" in hdi["status"] and "No 24-layer" in hdi["honesty"])

# 14: cal board passes physically or stays held — must MATCH the real pipeline
lr = art(V3, "last-run")
check("14 cal board verdict matches the real pipeline run",
      (res["outcome"] == "A_physical_pass") == (lr.get("status") == "PASSED"),
      "%s / pipeline %s" % (res["outcome"], lr.get("status")))
check("14b physical pass -> ready_to_build_with_review, order NOT automatic",
      res["build_recommendation"] == "ready_to_build_with_review"
      and "NOT automatic" in res["order_recommendation"]
      and res["human_review_required"])

# 15: no physical calibration claim
check("15 no calibration claim (physical cal only after fab + traceable chain)",
      "no calibration claim yet" in res["calibration_impact"])

# 16: ADS1115 measurement front-end not mislabeled
fe = art(os.path.join(RUNS, "fl1-cal-reference", "data"), "last-run")
check("16 ADS1115 front-end still correctly labeled",
      fe and "measurement" in fe.get("prompt", "").lower()
      and "calibration" not in fe.get("prompt", "").lower())

# 17-18: Batch 1 v2 stable + not ordered
stab = art(V3, "batch1-stability-report")
check("17 Batch 1 v2 boards remain role-complete + FA unchanged", stab["all_stable"])
check("18 Batch 1 v2 boards remain NOT ordered",
      all(not b["ordered"] and b["human_review_required"] for b in stab["boards"]))

# 19-23: prior phases intact
att = art(CAL, "cal-board-attempt")
check("19 Rev A evidence preserved (previous blocker recorded, not hidden)",
      att["previous_blocker"] == "blocked_by_grid_resolution"
      and "FIXED" in att["previous_blocker_status"])
held = art(CAL, "phase16-held-board-status")
check("20 scope-lite remains unsupported",
      any(b["board"] == "scope_lite" and "unsupported" in b["why_held"]
          for b in held["boards"]))
dash15 = art(CAL, "phase15-board-readiness-dashboard")
calrow = next(b for b in dash15["boards"] if b["board"] == "calibration_reference")
check("21 phase15 policy: cal order requires review (never automatic)",
      calrow["order_recommendation"] == "order_3_pcba_review_required"
      and calrow["human_review_required"])
check("22 root causes documented (pad-rotation bug + grid contention)",
      any("pad-rotation" in r for r in res["root_causes_fixed"]))
check("23 fanout rule: a stub alone never counts as routed",
      "never counts as routed" in pre["rule"])

npass = sum(1 for ok in checks if ok)
print("%d/%d fine-grid checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
