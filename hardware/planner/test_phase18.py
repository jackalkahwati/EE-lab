"""Phase 18 regression: architecture search + trade-space explorer.

Rails: hard blockers dominate, no fake precision/scope/funcgen/LA/RF claims,
mock-only visible, nothing ordered, Batch 1 untouched.

  python3 test_phase18.py
"""
import json
import os
import sys

import arch_search as a

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


# 1-9: artifacts
for n, name in [(1, "architecture-candidate-model"),
                (2, "architecture-tradespace-scoring-model"),
                (3, "architecture-search-engine"),
                (4, "fl1-held-board-architecture-search"),
                (5, "board-partitioning-search-report"),
                (6, "component-strategy-search-report"),
                (7, "validation-path-architecture-report"),
                (8, "calibration-path-architecture-report"),
                (9, "fl1-recommended-next-board-roadmap")]:
    check("%d %s generated" % (n, name), art(name) is not None)

# 11-15: demos
demos = art("phase18-demo-architecture-searches")["demos"]
check("11 power/current monitor demo runs",
      demos["demo1_power_current_monitor"]["recommended"] is not None)
check("12 DMM-lite demo: proven chain + held on cal-board dependency",
      demos["demo2_dmm_lite"]["recommended"] == "DMM-1"
      and "HOLD until Calibration/Reference" in demos["demo2_dmm_lite"]["recommended_next_action"])
check("13 scope-lite demo: internal REJECTED, COTS recommended",
      "SCP-2" in demos["demo3_scope_lite"]["rejected"]
      and demos["demo3_scope_lite"]["recommended"] == "SCP-1")
check("14 external instrument interface demo: EII-1 high readiness",
      demos["demo4_external_instrument_interface"]["recommended"] == "EII-1")
check("15 logic capture demo: COTS for timing; event-capture distinguished",
      demos["demo5_logic_capture"]["recommended"] == "LC-3")

# 16: hard blockers dominate
scp2 = next(c for c in demos["demo3_scope_lite"]["candidates"]
            if c["candidate_id"] == "SCP-2")
check("16 hard blockers dominate the aggregate score",
      scp2["aggregate"]["verdict"] == "BLOCKED" and "dominated_by" in scp2["aggregate"])

# 17-20: honesty rails in the candidates themselves
check("17 scope-lite internal forbids oscilloscope-class claims",
      any("oscilloscope-class" in f for f in scp2["unsupported_claims"]))
dmm1 = next(c for c in demos["demo2_dmm_lite"]["candidates"] if c["candidate_id"] == "DMM-1")
check("18 DMM-lite forbids precision claims without calibration",
      any("precision" in f for f in dmm1["unsupported_claims"])
      and dmm1["calibration_path"] == "internally_calibratable")
stm = a.search("stimulus_funcgen")
stm1 = next(c for c in stm["candidates"] if c["candidate_id"] == "STM-1")
check("19 stimulus forbids function-generator-class claims",
      any("function-generator-class" in f for f in stm1["unsupported_claims"]))
rf = a.search("rf_50ohm")
check("20 RF: internal rejected, no RF performance claims",
      "RF-2" in rf["rejected"]
      and all(any("RF" in f or "impedance" in f for f in c["unsupported_claims"])
              for c in rf["candidates"] if c["candidate_id"] in ("RF-1", "RF-2")))

# 21: mock-only visible
rf3 = next(c for c in rf["candidates"] if c["candidate_id"] == "RF-3")
check("21 mock-only candidates visibly mock-only",
      rf3["validation_path"] == "validation_ready_mock_only")

# 22-23: nothing ordered, Batch 1 unchanged
orders = art("first-article-order-record-model")
check("22 no board ordered (order stubs still human_review_required)",
      all(o["order_status"] == "human_review_required" for o in orders["records"]))
fa3 = art("fl1-final-first-article-review-v3")
check("23 Batch 1 manufacturing readiness unchanged (all four order_3_pcba)",
      all(b["recommendation"] == "order_3_pcba" for b in fa3["boards"]))

# roadmap honesty
rm = art("fl1-recommended-next-board-roadmap")
check("roadmap: scope/funcgen/LA/RF stay external COTS",
      len(rm["stay_external_cots"]) == 4)
check("roadmap: DMM-lite gated on physical cal board",
      any("cal board" in x["when"] for x in rm["after_batch1"] if "DMM" in x["board"]))

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 18 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
