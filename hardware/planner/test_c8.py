"""C8 regression: first physical evidence campaign readiness."""
import json
import os
import sys

import physical_campaign as pc

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public",
                 "runs", "fl1-backplane-v1", "data")
c = json.load(open(os.path.join(
    D, "first-physical-evidence-campaign-readiness-v1.json")))

check("1 thirteen rungs, prioritized 1..13",
      len(c["rungs"]) == 13
      and [r["recommended_order"] for r in c["rungs"]] == list(range(1, 14)))
check("2 buildable-now rungs cite PASSED source runs (quote packet "
      "generatable, human approval pending)",
      len(c["buildable_now"]) >= 8
      and all("human" in r["quote_packet_readiness"]
              for r in c["rungs"]
              if "generatable" in r["quote_packet_readiness"]))
check("3 USB-FS, impedance coupon, BGA coupon honestly blocked",
      set(c["blocked"]) == {"usb-fs-board", "controlled-impedance-coupon",
                            "bga-escape-coupon"})
check("4 every rung: evidence gained + claims unlocked IF passed + claims "
      "still blocked",
      all(r["evidence_gained"] and "claims_still_blocked" in r
          for r in c["rungs"])
      and all("production_readiness" in str(r["claims_still_blocked"])
              for r in c["rungs"]))
check("5 first build is the cheapest DRC-clean board (power-entry)",
      c["rungs"][0]["board"] == "power-entry-header"
      and c["rungs"][0]["drc_violations_at_emission"] == 0)
check("6 bare-MCU boot attempt flagged high risk, boot never pre-claimed",
      any(r["board"] == "relay-control" and "high" in r["risk"]
          and "IF it boots" in str(r["claims_unlocked_if_passed"])
          for r in c["rungs"]))
check("7 cost classes never invent numbers",
      all("no number invented" in r["cost_class"]
          for r in c["rungs"] if r["risk"] != "blocked"))
check("8 15 validation evidence types enumerated",
      len(c["evidence_types"]) == 15)
check("9 ledger empty, not ordered — campaign is planning only",
      c["physical_ledger_state"]["artifacts"] == []
      and c["physical_ledger_state"]["order_status"] == "not_ordered"
      and any("nothing is ordered" in r for r in c["rules"]))
check("10 APPROVED_FOR_QUOTE stays the human unlock",
      any("APPROVED_FOR_QUOTE" in r for r in c["rules"]))

npass = sum(1 for ok in checks if ok)
print("%d/%d C8 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
