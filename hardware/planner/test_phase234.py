"""Phase 23.4 regression: automated 2-layer flow + cost optimization."""
import json
import os
import sys

import fab_2layer as f2

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


check("1 decision model v2 (12 states)",
      len(art("compose-layer-count-decision-model-v2")["states"]) == 12)
prof = art("compose-2layer-fabrication-profile")
check("2 2-layer profile (F/B, through vias, no impedance/RF claims)",
      prof["layers"] == ["F.Cu", "B.Cu"]
      and "controlled_impedance" in prof["blocked_claims"])
em = art("compose-2layer-board-emitter-report")
check("3 emitter support verified on copper",
      em["verified_on_copper"]["inner_layers_absent"]
      and em["verified_on_copper"]["board_json_layers"] == 2)
t2 = open(os.path.join(RUNS, "power-entry-header-2l", "variant.kicad_pcb")).read()
check("4 2-layer board has NO internal layers",
      "In1.Cu" not in t2 and "In2.Cu" not in t2)
t4 = open(os.path.join(RUNS, "power-entry-header-v1", "variant.kicad_pcb")).read()
check("5 existing 4-layer board still has expected layers",
      "In1.Cu" in t4 and "In2.Cu" in t4)
check("6 routing strategy exists", art("compose-2layer-routing-strategy") is not None)
elig = art("compose-2layer-eligibility-checker")["results"]
check("7 eligibility checker exists (18 boards evaluated)", len(elig) == 18)
check("8 power-entry eligible",
      elig["Simple Power Entry Header"]["state"].startswith("eligible"))
check("9 connector breakout eligible",
      elig["Connector Breakout"]["state"].startswith("eligible"))
check("10 high-current not eligible",
      elig["Motor Controller"]["state"] == "not_eligible")
check("11 RF not eligible", elig["RF Adapter"]["state"] == "not_eligible")
check("12 PCIe not eligible", elig["PCIe Capture"]["state"] == "not_eligible")
check("13 medical not eligible",
      elig["Medical/Implantable"]["state"] == "not_eligible")
check("13b measurement boards stay 4-layer",
      elig["Current/Voltage Monitor"]["state"] == "not_eligible"
      and elig["FL-1 Calibration/Reference"]["state"] == "not_eligible")
check("14 benchmark selection report exists",
      art("compose-2layer-benchmark-selection") is not None)
rr = art("compose-2layer-benchmark-rerun-report")
check("15-16 rerun report: 7 attempted, 7 routed clean",
      rr["attempted"] == 7 and rr["routed_clean"] == 7)
check("17 actual emitted layer count recorded (all 2)",
      all(r["layers_emitted"] == 2 for r in rr["reruns"]))
check("18 DRC results recorded (all 0)",
      all(r["drc"] == 0 for r in rr["reruns"]))
check("19 failure evidence policy present", "failures" in rr["honesty"].lower())
check("20 4-layer fallback retained per rerun",
      all("known good, retained" in r["fallback_4layer"] for r in rr["reruns"]))
cmpx = art("compose-2layer-vs-4layer-comparison")
check("21 comparison exists (7 pairs, all prefer_2_layer_with_review)",
      len(cmpx["pairs"]) == 7
      and all(p["recommended"] == "prefer_2_layer_with_review"
              for p in cmpx["pairs"]))
opt = art("compose-low-cost-fabrication-optimizer")
check("22 optimizer exists", opt is not None)
check("23 cost labeled placeholder",
      all("PLACEHOLDER" in p["cost_delta"] for p in cmpx["pairs"])
      and "placeholders" in opt["rules"][0])
pk = art("compose-capability-pack-2layer-update")
check("24 pack 2-layer update exists (15 packs)", len(pk["updates"]) == 15)
check("25 2-layer support evidence-scoped",
      all("evidence" in v for v in pk["updates"].values())
      and pk["updates"]["ADC_data_logger_pack"]["2layer"] == "requires_4_layer")
flu = art("compose-2layer-fleet-learning-update")
check("26 fleet update: gap closed for simple class, next = QFN-56",
      "CLOSED" in flu["gap_status"]
      and "QFN-56" in flu["next_recommendation"]["recommendation"])
check("28 2-layer clean is not physical validation",
      "NOT physical validation" in rr["honesty"])
import production_line as pl
check("29 production_ready unreachable",
      pl.readiness_state({}) == "first_article_ready_for_human_approval")
st, why = f2.eligibility({"fine_pitch": True, "net_count": 5,
                          "component_count": 22})
check("fine-pitch on 2L = eligible_WITH_REVIEW", st == "eligible_with_review")

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 23.4 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
