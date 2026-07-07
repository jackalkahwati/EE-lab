"""Phase 22 regression: physical build + fleet learning loop."""
import json
import os
import sys

import fleet_learning as fl

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


check("1 evidence object model generated (27 types)",
      len(art("compose-evidence-object-model")["evidence_types"]) == 27)
sim = fl.make_evidence("J", "f", "validation_run", "pass", "simulated", "mock")
phys = fl.make_evidence("J", "f", "board_bringup", "pass", "physical", "bench")
check("2 simulated evidence cannot satisfy physical gates",
      not fl.satisfies_physical(sim) and fl.satisfies_physical(phys))
fail_ev = fl.make_evidence("J", "f", "validation_run", "fail", "simulated", "mock")
state, reason = fl.promote("proven_in_routed_board",
                           "proven_in_manufacturing_package", fail_ev)
check("3 failed evidence is preserved and demotes/holds",
      "preserved" in reason)
check("4 fleet memory model generated (12 categories, yield EMPTY)",
      len(art("compose-fleet-memory-model")["categories"]) == 12
      and "EMPTY" in art("compose-fleet-memory-model")["note"])
check("5 failure taxonomy generated (29 classes)",
      len(art("compose-failure-taxonomy")["classes"]) == 29)
ple = art("compose-pattern-learning-engine")
check("6 pattern learning engine generated (19 patterns)",
      len(ple["patterns"]) == 19)
st, why = fl.promote("proven_in_manufacturing_package",
                     "proven_in_physical_first_article", sim)
check("7 patterns NOT physically promoted without physical evidence",
      st == "proven_in_manufacturing_package" and "REFUSED" in why
      and all("REQUIRES physical" in p["physical_promotion"] for p in ple["patterns"]))
gaps = {g["capability"]: g for g in art("compose-capability-gap-ranking")["ranking"]}
check("8 capability gap ranking generated (10 gaps)", len(gaps) == 10)
check("9 USB-C gap present", any("USB-C" in k for k in gaps))
check("10 gate-driver/power-stage gap present", any("power-stage" in k for k in gaps))
check("11 SMA/impedance gaps present",
      any("SMA" in k for k in gaps) and any("impedance" in k for k in gaps))
check("12 external SI/PI gap present", any("SI/PI" in k for k in gaps))
check("13 HDI + BGA gaps present",
      any("HDI" in k for k in gaps) and any("BGA" in k for k in gaps))
check("14 QFN-56/bare RP2040 gap remains visible",
      any("QFN-56" in k for k in gaps) and any("RP2040" in k for k in gaps))
ledger = art("compose-board-job-outcome-ledger")
check("15 outcome ledger generated (15 jobs: 8 examples + 7 FL-1)",
      len(ledger["jobs"]) == 15)
lr = art("compose-phase21-example-learning-report")
check("16 Phase 21 examples ingested (8 evidence objects)",
      len(lr["evidence_objects"]) == 8)
sel = art("compose-next-board-benchmark-selector")
check("17 environmental sensor is the recommended benchmark",
      "environmental sensor" in sel["recommendation"])
check("18 Pi HAT relay is the runner-up benchmark",
      "Pi HAT" in sel["runner_up"])
check("19 AI accelerator excluded near-term",
      any("AI accelerator" in x for x in sel["excluded_near_term"]))
check("21 simulated vs physical distinct in evidence objects",
      all(e["simulated_or_physical"] in ("generated", "simulated")
          for e in lr["evidence_objects"]))
check("22 no physical validation invented",
      all("physical" not in str(j.get("simulated_or_physical"))
          or "NOT physically" in str(j.get("simulated_or_physical"))
          for j in ledger["jobs"]))
check("23 no yield data invented", "EMPTY" in lr["yield_memory"])
import production_line as pl
check("24 production_ready still unreachable",
      pl.readiness_state({}) == "first_article_ready_for_human_approval")
fa3 = art("fl1-final-first-article-review-v3", os.path.join(RUNS, "fl1-cal-board-v4", "data"))
check("FL-1 fleet unchanged", all(b["recommendation"] == "order_3_pcba"
                                  for b in fa3["boards"]))
check("no ordering (ledger honesty)", "nothing ordered" in ledger["honesty"])

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 22 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
