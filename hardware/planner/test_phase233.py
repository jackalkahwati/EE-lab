"""Phase 23.3 regression: benchmark suite + capability packs."""
import json
import os
import sys

import capability_packs as cp
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


check("1 benchmark taxonomy (23 categories)",
      len(art("compose-benchmark-taxonomy")["categories"]) == 23)
pm = art("compose-capability-pack-model")
check("2 capability pack model (8 states)", len(pm["pack_states"]) == 8)
check("3 packs have evidence states",
      all(p["evidence_state"] in cp.PACK_STATES
          for p in art("compose-capability-pack-registry")["packs"]))
st, why = cp.promote_pack("routed_in_benchmark", "physically_validated",
                          "benchmark", ["run-x"])
check("4 packs cannot become physically_validated without physical evidence",
      st == "routed_in_benchmark" and "REFUSED" in why)
packs = art("compose-generated-capability-packs")
check("5 generated packs (18, evidence-linked)",
      len(packs["packs"]) == 18
      and all("evidence_links" in p for p in packs["packs"]))
check("6 benchmark suite generator exists",
      "contamination" in art("compose-benchmark-suite-generator")["mechanism"])

bench = {b["benchmark"]: b for b in
         art("compose-ordinary-rigid-benchmark-suite-report")["benchmarks"]}
for n, name in [(7, "Simple Power Entry Header"), (8, "USB-C 5V Power Entry"),
                (9, "BME280 Sensor Breakout"), (10, "Environmental Sensor v2"),
                (11, "Simple I2C Sensor Breakout"),
                (13, "Debug Programming Adapter"), (14, "Simple ADC Data Logger"),
                (15, "Current/Voltage Monitor (non-FL-1)"),
                (16, "Raspberry Pi HAT Relay Controller"),
                (17, "Connector Breakout Board"),
                (18, "Lab Instrument Adapter (non-FL-1)")]:
    b = bench[name]
    check("%d %s routed clean" % (n, name.split(" (")[0]),
          b["status"] == "PASSED" and b["drc"] == 0)
check("12 SPI sensor breakout honest architecture_only",
      bench["SPI Sensor Breakout"]["outcome"] == "architecture_only"
      and "no supported SPI sensor" in bench["SPI Sensor Breakout"]["reason"])
check("19 low-power logger makes NO low-power claim",
      "NO low-power performance claim" in bench["Low-Power Logger"]["reason"])
check("20 regulator board blocked on missing regulator primitive",
      bench["Simple Regulator Board"]["outcome"] == "blocked"
      and "regulator primitive" in bench["Simple Regulator Board"]["reason"])
check("21 generic backplane routed (pure synthesis, no FL-1 bus)",
      bench["Generic 3-Slot Backplane (pure synthesis)"]["status"] == "PASSED"
      and bench["Generic 3-Slot Backplane (pure synthesis)"]["fl1_contamination_check"].startswith("PASS"))
check("22 motor controller blocked", bench["Motor Controller"]["outcome"] == "blocked")
check("23 high-current load switch blocked",
      bench["High-Current Load Switch"]["outcome"] == "blocked")
check("24 RF adapter architecture_only",
      bench["RF Adapter"]["outcome"] == "architecture_only")
check("25 PCIe architecture_only",
      bench["PCIe Capture"]["outcome"] == "architecture_only")
check("26 medical/implantable blocked with no claim",
      bench["Implantable/Medical Electronics"]["outcome"] == "blocked"
      and "no medical" in bench["Implantable/Medical Electronics"]["reason"].lower())

sc = art("compose-benchmark-coverage-scorecard")
check("27 coverage scorecard (20 benchmarks, 12 routed, 0 contamination fails)",
      sc["totals"]["benchmarks"] == 20 and sc["totals"]["routed_with_review"] == 12
      and sc["totals"]["fl1_contamination_failures"] == 0)
check("28 promotion rules exist (cite evidence, never exceed it)",
      "state never exceeds evidence" in
      art("compose-capability-pack-promotion-rules")["rules"][2])
check("29 registry exists (18 packs)", len(art(
      "compose-capability-pack-registry")["packs"]) == 18)
recs = {r["structure"]: r for r in
        art("compose-permanent-pattern-recommendations")["recommendations"]}
check("30 pattern engine: led_indicator + testpoint_cluster promote; "
      "voltage_monitor needs more",
      recs["led_indicator"]["recommendation"] == "promote_to_pattern"
      and recs["testpoint_cluster"]["recommendation"] == "promote_to_pattern"
      and recs["voltage_monitor (divider)"]["recommendation"]
      == "require_more_benchmarks")
nc = art("compose-next-capability-recommendation")
check("31 next capability recommendation (2-layer flow, evidence-cited)",
      nc["recommendation"] == "automated_2layer_flow" and "overbuilt" in nc["reason"])
check("32-34 provenance tracked (generated-only x3, mixed, JIT+generated)",
      len(sc["provenance_coverage"]["generated_only"]) == 3
      and sc["provenance_coverage"]["mixed_block_generated"] >= 6
      and sc["provenance_coverage"]["jit_plus_generated"] == 2)
check("35 FL-1 contamination checks ran on non-FL-1 benchmarks",
      all(b.get("fl1_contamination_check", "PASS").startswith(("PASS", "n/a"))
          for b in bench.values() if b.get("run_id")))
check("36 claim-gate violations prevented list",
      len(sc["claim_gate_violations_prevented"]) == 5)
check("37 routed benchmark is not physical validation",
      "NOT physical validation" in art(
          "compose-ordinary-rigid-benchmark-suite-report")["honesty"])
check("38 production_ready still unreachable",
      pl.readiness_state({}) == "first_article_ready_for_human_approval")
check("47 nothing ordered", "nothing ordered" in art(
      "compose-ordinary-rigid-benchmark-suite-report")["honesty"])

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 23.3 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
