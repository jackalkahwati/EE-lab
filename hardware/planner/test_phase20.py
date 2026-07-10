"""Phase 20 regression: production line + supply chain optimization."""
import json
import os
import sys

import production_line as pl

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


for n, a in enumerate(["fl1-system-bom-rollup", "fl1-approved-vendor-list",
                       "fl1-sourcing-risk-model", "fl1-cost-model",
                       "fl1-build-variants", "fl1-manufacturing-package-audit",
                       "fl1-first-article-order-batch-plan",
                       "fl1-incoming-inspection-optimization",
                       "fl1-assembly-test-flow", "fl1-yield-failure-tracking-model",
                       "fl1-reva-revb-manufacturing-feedback-loop",
                       "fl1-production-readiness-dashboard"], 1):
    check("%d %s generated" % (n, a), art(a) is not None)

bom = art("fl1-system-bom-rollup")
check("14 I2C DNP/population notes represented in the BOM rollup",
      any(line.get("dnp_note") for line in bom["lines"]))
check("15 keyed-connector Rev B alternates represented",
      any("KEYED SHROUDED" in str(line.get("ref", "")) + str(line.get("part", ""))
          for line in bom["lines"] if line["board"] == "SYSTEM"))
check("16 no silent substitutions for protected components",
      all("not_allowed_silent" in line["substitution_policy"]
          or "exact_part" in line["substitution_policy"]
          for line in bom["lines"]
          if any(k in str(line.get("part", "")).lower()
                 for k in ("ref30", "ads1115", "relay", "24lc"))))
bv = art("fl1-build-variants")
check("17 variants distinguish standalone vs backplane system builds",
      "POPULATED" in bv["variants"][0]["population"]
      and "DNP" in bv["variants"][1]["population"])
dash = art("fl1-production-readiness-dashboard")
check("18 current readiness capped at first_article_ready_for_human_approval",
      dash["current_state"] == "first_article_ready_for_human_approval")
check("19 production_ready unreachable without physical+yield+human evidence",
      pl.readiness_state({}) == "first_article_ready_for_human_approval"
      and pl.readiness_state({"human_approval_recorded": True, "boards_ordered": True,
                              "boards_received": True,
                              "system_validation_passed_physical": True,
                              "yield_data_exists": False}) != "production_ready"
      and pl.readiness_state({"human_approval_recorded": True, "boards_ordered": True,
                              "boards_received": True,
                              "system_validation_passed_physical": True,
                              "yield_data_exists": True, "pilot_approved": True,
                              "production_human_approval": True}) == "production_ready")
fa3 = art("fl1-final-first-article-review-v3", os.path.join(RUNS, "fl1-cal-board-v4", "data"))
bp = art("fl1-backplane-v1-compose-report")
check("20 seven boards remain review-required and not ordered",
      all(b["recommendation"] == "order_3_pcba" for b in fa3["boards"])
      and "NEVER" in bp["order"]
      and art("fl1-first-article-order-batch-plan")["order_submitted"] is False)
check("19.1 findings remain visible on the dashboard",
      len(dash["open_findings"]) == 2 and "671" in dash["open_findings"][0])
check("cost model honesty: placeholders labeled, BOM grounded",
      "PLACEHOLDER" in art("fl1-cost-model")["honesty"]
      and len(art("fl1-cost-model")["per_board_bom_usd"]) == 7)
check("package audit: all seven complete_with_review",
      art("fl1-manufacturing-package-audit")["all_complete_with_review"])
check("assembly/test flow: 20 steps with evidence + inspection flags",
      len(art("fl1-assembly-test-flow")["steps"]) == 20)
check("yield model is MODEL ONLY (no fake yield data)",
      "MODEL ONLY" in art("fl1-yield-failure-tracking-model")["state"])
check("feedback loop: no auto redesign/substitution/release",
      len(art("fl1-reva-revb-manufacturing-feedback-loop")["rules"]) == 5)
check("blocked claims listed on the dashboard",
      "production-ready" in dash["blocked_claims"])

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 20 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
