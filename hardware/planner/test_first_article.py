"""Phase 16.6 regression: final first-article review pack.

Rails: all four boards included, review actually reviews (cal board's role gaps
caught, integration conflicts flagged), no board production-ready, no order
submitted, calibration history preserved.

  python3 test_first_article.py
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
                  "fl1-cal-board-v3", "data")


def art(name):
    p = os.path.join(RD, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


pack = art("fl1-first-article-review-pack")
idx = art("fl1-final-first-article-review-index")

# 1-2: index + all four packets
check("1 final review index generated", idx is not None and len(idx["boards"]) == 4)
for bid in ("controller-backplane", "digital-bringup", "relay-probe-matrix",
            "calibration-reference"):
    check("2 %s review packet generated" % bid,
          art("%s-first-article-review" % bid) is not None)

# 3: cross-board integration review with the REAL findings
integ = art("fl1-batch1-cross-board-integration-review")
check("3 integration review generated + flags the bus-header mismatch",
      integ and any("bus header" in f["item"] and "FLAG" in f["status"]
                    for f in integ["findings"]))
check("3b integration review flags the shared 0x50 board-ID conflict",
      any("board-ID" in f["item"] and "CONFLICT" in f["status"] for f in integ["findings"]))

# 4-5: checklist + quantity recommendation
check("4 fabrication checklist generated",
      art("fl1-batch1-fabrication-checklist") is not None)
qty = art("fl1-batch1-order-quantity-recommendation")
check("5 order quantity recommendation generated", qty is not None)
byq = {r["board"]: r for r in qty["boards"]}
check("5b core boards order_3_pcba; cal board revise_before_order (role gaps)",
      all(byq[b]["recommendation"] == "order_3_pcba"
          for b in ("controller_backplane", "digital_bringup", "relay_probe_matrix"))
      and byq["calibration_reference"]["recommendation"] == "revise_before_order")

# 6: human approval form with the warning
form = os.path.join(RD, "fl1-batch1-human-approval-form.md")
check("6 human approval form generated + human-decision warning",
      os.path.exists(form) and "does not spend money" in open(form).read())

# 7: calibration board do_not_build history preserved
cal_att = json.load(open(os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui",
                                      "public", "runs", "fl1-cal-board", "data",
                                      "cal-board-attempt.json")))
check("7 cal board previous do_not_build history preserved",
      cal_att["previous_blocker"] == "blocked_by_grid_resolution")

# 8-9: nothing production-ready, nothing ordered
check("8 no board marked production-ready",
      all(b["approval_status"] == "PENDING_HUMAN_REVIEW" for b in idx["boards"])
      and "production-ready" in idx["note"])
check("9 no order submitted (recommendations only, qty 0 unless approved)",
      all(r["quantity"] == 0 for r in qty["boards"]
          if r["recommendation"] != "order_3_pcba"))

npass = sum(1 for ok in checks if ok)
print("%d/%d first-article checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
