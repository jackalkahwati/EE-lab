"""Phase 19 regression: multi-board + electromechanical co-design."""
import json
import os
import sys

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


# 1-18: artifacts
ARTS = ["fl1-system-architecture", "fl1-board-envelope-report", "fl1-slot-standard-v1",
        "fl1-backplane-concept-v1", "fl1-unified-connector-map",
        "fl1-pinout-compatibility-report", "fl1-dut-fixture-concept",
        "fl1-grounding-shielding-strategy", "fl1-system-power-architecture",
        "fl1-thermal-airflow-concept", "fl1-enclosure-serviceability-concept",
        "fl1-assembly-workflow", "fl1-service-workflow", "fl1-multiboard-validation-plan",
        "fl1-system-traceability-model", "fl1-monolithic-costdown-roadmap",
        "fl1-system-manufacturing-readiness", "fl1-system-risk-register"]
for i, a in enumerate(ARTS, 1):
    check("%d %s generated" % (i, a), art(a) is not None)

# backplane: REAL routed board
bp = art("fl1-backplane-v1-compose-report")
check("backplane composed for real (9/9, 0 DRC, review-required)",
      bp and bp["pipeline_status"] == "PASSED" and bp["drc_violations"] == 0
      and bp["status"] == "ready_to_build_with_review" and "NEVER" in bp["order"])
txt = open(os.path.join(RUNS, "fl1-backplane-v1", "variant.kicad_pcb")).read()
# NOTE: the backplane has NO ID_An nets by design — straps tie slot pins to
# +3V3 or leave them floating; the ID nets exist on the CARDS (pull-downs).
check("backplane carries six 2x07 slots + strap silk + system pull-ups",
      txt.count('footprint "Connector_PinHeader_2.54mm:PinHeader_2x07') == 6
      and "SLOT 5  ID 0x55" in txt and '"R94"' in txt and '"R95"' in txt
      and txt.count('footprint "TestPoint:') >= 4)

# envelopes from real geometry
env = art("fl1-board-envelope-report")
check("envelopes for all six boards with real dimensions",
      len(env["boards"]) == 6 and all(b["dimensions_mm"][0] > 50 for b in env["boards"]))
ss = art("fl1-slot-standard-v1")
check("slot standard recommends vertical cards on backplane",
      "RECOMMENDED" in ss["styles_compared"][0]["style"] and ss["slot"]["count"] == 6)

# honesty findings recorded, not hidden
pc = art("fl1-pinout-compatibility-report")
check("I2C pull-up stacking finding RECORDED (review_required)",
      any(f["item"] == "I2C pull-up stacking" and f["status"] == "REVIEW_REQUIRED"
          for f in pc["findings"]))
check("connector keying gap RECORDED",
      any("keying" in f["item"] and f["status"] == "REVIEW_REQUIRED" for f in pc["findings"]))

# fixture + enclosure recommendations
check("fixture: swappable DUT adapter card recommended",
      "swappable DUT adapter card" in art("fl1-dut-fixture-concept")["recommendation"])
check("enclosure: open-frame first article recommended",
      "RECOMMENDED" in art("fl1-enclosure-serviceability-concept")["options"][0]["option"])

# no-claims rails
g = art("fl1-grounding-shielding-strategy")
check("no EMC/noise/isolation claims", any("no EMC" in h for h in g["honesty"]))
pw = art("fl1-system-power-architecture")
check("no PSU/high-current/high-voltage/certification claims",
      len(pw["honesty"]) == 4 and "no mains" in pw["input"].lower() or "NO mains" in pw["input"])
check("thermal labeled engineering concept",
      "no thermal compliance" in art("fl1-thermal-airflow-concept")["label"])

# validation plan + traceability
vp = art("fl1-multiboard-validation-plan")
check("validation plan: 9 stages + evidence rules",
      len(vp["stages"]) == 9 and "failed evidence preserved" in vp["evidence"])
tr = art("fl1-system-traceability-model")
check("traceability: 11 lifecycle states, current = architecture_defined",
      len(tr["lifecycle"]) == 11 and tr["current_state"].startswith("architecture_defined"))

# cost-down link honesty
cd = art("fl1-monolithic-costdown-roadmap")
check("monolithic result is FUTURE cost-down only",
      "never the current product architecture" in cd["rule"]
      and "modular" in cd["now"])
check("bare RP2040 not chased (blocker only referenced)",
      any("QFN-56" in x["status"] for x in cd["later"] if "bare" in x["step"]))

# six boards untouched
fa3 = art("fl1-final-first-article-review-v3", os.path.join(RUNS, "fl1-cal-board-v4", "data"))
eii = art("eii1-compose-report", os.path.join(RUNS, "fl1-eii1-v1", "data"))
pcm = art("pcm1-compose-report", os.path.join(RUNS, "fl1-pcm1-v1", "data"))
check("six plugin boards unchanged + review-required + not ordered",
      all(b["recommendation"] == "order_3_pcba" for b in fa3["boards"])
      and eii["verdict"] == "ready_to_build_with_review"
      and pcm["verdict"] == "ready_to_build_with_review")

# risk register + layout
rr = art("fl1-system-risk-register")
check("risk register: 8 risks, high-severity require review",
      len(rr["risks"]) == 8 and all(r["review_required"] for r in rr["risks"]
                                    if r["severity"] == "high"))
check("layout map + SVG generated",
      art("fl1-system-layout-map") is not None
      and os.path.exists(os.path.join(D, "fl1-system-layout.svg")))
mfg = art("fl1-system-manufacturing-readiness")
check("system manufacturing honesty (nothing ordered, not production-ready)",
      "not production-ready" in mfg["honesty"])

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 19 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
