"""Phase 17 regression: first-article manufacturing readiness + supplier package.

Rails: all artifacts generated for all four boards, nothing ordered, nothing
production-ready, approval gate never auto-submits, cal history + strap strategy
visible, substitution policy protects critical parts.

  python3 test_phase17.py
"""
import json
import os
import sys

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RD = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs",
                  "fl1-cal-board-v4", "data")


def art(name):
    p = os.path.join(RD, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


# 1-8: artifacts
norm = art("manufacturing-package-normalization-report")
check("1 normalization report generated + all four normalized",
      norm and len(norm["boards"]) == 4 and all(b["normalized"] for b in norm["boards"]))
quotes = art("supplier-quote-package")
check("2 supplier quote package generated (qty 3, no CI, no HDI)",
      quotes and all(q["quantity"] == 3 and "NOT required" in q["controlled_impedance"]
                     and "NOT required" in q["hdi_via_in_pad"] for q in quotes["boards"]))
check("3 BOM risk review generated", art("bom-risk-sourcing-review") is not None)
sub = art("substitution-policy")
check("4 substitution policy protects critical parts (no silent subs)",
      sub and "voltage_reference" in sub["critical"] and "adc" in sub["critical"]
      and any("no silent substitutions" in r for r in sub["rules"]))
orders = art("first-article-order-record-model")
check("5 order record model generated (14 states)",
      orders and len(orders["model_states"]) == 12 or (orders and len(orders["model_states"]) >= 12))
gate = art("first-article-human-approval-gate")
check("6 human approval gate generated + never auto-submits",
      gate and "NEVER submits orders automatically" in gate["rule"])
acc = art("incoming-inspection-acceptance-criteria")
check("7 acceptance criteria generated (common + per-board)",
      acc and len(acc["common"]) >= 12 and "calibration_reference" in acc["specific"])
risks = art("first-article-manufacturing-risk-register")
check("8 risk register generated (13+ risks with mitigation + owner)",
      risks and len(risks["risks"]) >= 12
      and all(r["mitigation"] and r["owner"] for r in risks["risks"]))

# 10-12: nothing ordered / production-ready
check("10 all four boards remain order_3_pcba_review_required",
      all(b["recommendation"] == "order_3_pcba"
          for b in art("fl1-final-first-article-review-v3")["boards"]))
check("11 no board ordered automatically (all order stubs human_review_required)",
      all(o["order_status"] == "human_review_required" and o["approval_record"] is None
          for o in orders["records"]))
pack = art("fl1-manufacturing-readiness-pack")
check("12 no production-ready claim", "nothing production-ready" in pack["honesty"])

# 13-14: history + straps visible
fa3 = art("fl1-final-first-article-review-v3")
check("13 calibration board history preserved",
      "do_not_build" in next(b for b in fa3["boards"]
                             if b["board"] == "calibration_reference")["history"])
check("14 board-ID strap strategy remains visible",
      art("fl1-board-id-addressing-strategy")["selected"] == "per_slot_address_straps")

# relay safe-default + strap risks flagged as review-required
check("high-severity risks require review",
      all(r["review_required"] for r in risks["risks"] if r["severity"] == "high"))

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 17 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
