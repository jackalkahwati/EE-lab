"""Phase 19.1 regression: backplane integration fixes + Rev B readiness."""
import json
import os
import sys

import i2c_system as ic

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")
D = os.path.join(RUNS, "fl1-backplane-v1", "data")


def art(name, d=D):
    p = os.path.join(d, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


check("1 ownership model generated (7 boards, explicit owner rules)",
      len(art("fl1-i2c-pullup-ownership-model")["boards"]) == 7)
rep = art("fl1-i2c-pullup-checker-report")
check("2 effective pull-up checker report generated", rep is not None)
asb = rep["scenarios"]["system_all_populated_AS_BUILT"]
check("3 six cards + backplane flagged (too_strong_pullup, ~671 ohm, >3mA)",
      asb["classification"] == "too_strong_pullup" and asb["effective_ohm"] < 700
      and asb["estimated_sink_ma_at_VOL"] > 3.0)
check("4 missing pull-ups -> missing_pullup",
      rep["scenarios"]["missing_all_pullups"]["classification"] == "missing_pullup")
check("5 unknown population -> unknown_population",
      rep["scenarios"]["unknown_population"]["classification"] == "unknown_population")
plan = art("fl1-revb-i2c-pullup-population-plan")
check("6 Rev B population plan generated", plan is not None)
check("7 plan: backplane owns system pull-ups",
      "backplane owns system I2C pull-ups" in plan["direction"])
check("8 plan: card-side DNP for system builds",
      all(b["backplane_system_build"] == "DNP" for b in plan["boards"]
          if "Backplane" not in b["board"]))
check("9 connector keying policy generated",
      art("fl1-connector-keying-policy") is not None)
oc = art("fl1-connector-orientation-checker-report")
check("10 orientation checker generated", oc is not None)
check("11 2x07 board-to-backplane flagged unkeyed_review_required",
      all(c["classification"] == "unkeyed_review_required" for c in oc["connectors"]
          if "2x07" in c["type"]))
check("12 missing pin-1 detection exists (classification defined)",
      "missing_pin1_mark" in json.dumps(oc) or all(c["pin1_marked"] for c in oc["connectors"]))
check("13 safety/power connectors carry higher severity",
      all(c["severity"] == "high" for c in oc["connectors"] if c["safety_or_power"]))
recs = art("fl1-system-revb-recommendations")
check("14 Rev B recommendations generated (5, evidence-linked, no auto-redesign)",
      len(recs["recommendations"]) == 5
      and all(not r["auto_redesign"] and r["evidence"] for r in recs["recommendations"]))
vp = art("fl1-multiboard-validation-plan-v2")
check("15 validation plan v2 generated", vp is not None)
check("16 plan BLOCKS invalid pull-up configuration",
      any("BLOCK system validation" in " ".join(s2["checks"])
          for s2 in vp["adds_over_v1"] if s2["stage"] == "i2c_pullup_ownership_check"))
check("17 plan requires connector orientation inspection (blocking)",
      any("BLOCK system validation" in " ".join(s2["checks"])
          for s2 in vp["adds_over_v1"] if "connector" in s2["stage"]))
check("18 manufacturing readiness v2 generated",
      art("fl1-system-manufacturing-readiness-v2") is not None)
check("19 risk register v2 generated (both findings ENFORCED)",
      all("ENFORCED" in c["now"] for c in art("fl1-system-risk-register-v2")["changes"]))
check("20 human approval form v2 generated (acknowledgements + no-spend rule)",
      "does not submit orders" in open(os.path.join(
          D, "fl1-seven-board-human-approval-form-v2.md")).read())

# 22-24: seven boards untouched, cost-down future-only
fa3 = art("fl1-final-first-article-review-v3", os.path.join(RUNS, "fl1-cal-board-v4", "data"))
bp = art("fl1-backplane-v1-compose-report")
check("22 seven boards unchanged + review-required",
      all(b["recommendation"] == "order_3_pcba" for b in fa3["boards"])
      and bp["status"] == "ready_to_build_with_review" and "NEVER" in bp["order"])
check("23 nothing ordered", "NEVER" in bp["order"])
check("24 monolithic cost-down remains future-only",
      "never the current product architecture"
      in art("fl1-monolithic-costdown-roadmap")["rule"])

# 26-27: no unearned claims
check("26 no I2C compliance claim without measurement",
      "measurement_required" in rep["physical_compliance"]
      or "no I2C compliance claim" in rep["physical_compliance"])
check("27 no connector safety claim without mitigation",
      all(c["first_article_mitigation"] for c in oc["connectors"] if not c["keyed"]))

# checker unit behavior (direct)
check("checker: single standalone card is ok",
      ic.effective_pullup([("card", 4700, "populated")], mode="standalone")
      ["classification"] == "ok")
check("checker: two owners in system mode never silently pass",
      ic.effective_pullup([("a", 4700, "populated"), ("b", 4700, "populated")])
      ["classification"] in ("review_required", "too_strong_pullup"))

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 19.1 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
