"""Phase 15 first-board-batch regression: build policy, package policy, order
decisions, manufacturing order-pack validation, adapter mapping, demos.

Discipline held: only evidence-safe boards get an order package; do_not_build /
unsupported boards are held; simulated validation is never physical.

  python3 test_phase15.py
"""
import json
import os
import sys

import build_policy as bp

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RD = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs",
                  "fl1-cal-board", "data")


def art(name):
    p = os.path.join(RD, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


pol = art("phase15-build-policy-report")
dash = art("phase15-board-readiness-dashboard")
bybrd = {b["board"]: b for b in dash["boards"]} if dash else {}
bypol = {b["board"]: b for b in pol["boards"]} if pol else {}

# 1 build policy report
check("1 Phase 15 build policy report generated", pol is not None and len(pol["boards"]) >= 10)

# 2-3 do_not_build / unsupported cannot generate order packages
check("2 do_not_build (cal) cannot generate order-ready package",
      not bypol["calibration_reference"]["allowed_to_generate_order_package"]
      and bypol["calibration_reference"]["package_type"] != "order_ready_pcba_package")
check("3 unsupported (scope-lite) cannot generate order-ready package",
      not bypol["scope_lite"]["allowed_to_generate_order_package"])

# 4 order-ready core boards require human review (first article)
check("4 order-ready boards mark human_review_required",
      all(bypol[b]["required_human_review"] for b in ("controller_backplane", "digital_bringup", "relay_probe_matrix")))

# 5-7 the 3 core boards attempted + order-ready
for b in ("controller_backplane", "digital_bringup", "relay_probe_matrix"):
    check("%s attempted + order-ready package" % b,
          bybrd[b]["attempted"] and bybrd[b]["package_type"] == "order_ready_pcba_package"
          and bybrd[b]["order_recommendation"] == "order_3_pcba_review_required")

# 11 adapter mapping for attempted boards
am = art("phase15-adapter-mapping")
check("11 adapter mapping for attempted boards",
      am and {m["board"] for m in am["mappings"]} >= {"controller_backplane", "digital_bringup", "relay_probe_matrix"})

# 12 manufacturing order-pack validation for order-ready boards
op = art("manufacturing-order-pack-validation")
check("12 order-pack validation runs + valid for the 3 core boards",
      op and all(op["boards"].get(b, {}).get("order_pack_valid") for b in
                 ("controller_backplane", "digital_bringup", "relay_probe_matrix")))

# 13-16 mock demos run + simulated
demos = art("phase15-demo-validation-runs")
byrun = {r["board_id"]: r for r in demos["runs"]} if demos else {}
for b in ("controller_backplane", "digital_bringup", "relay_probe_matrix"):
    check("mock validation runs for %s" % b, b in byrun)
check("16 mock evidence marked simulated (never physical)",
      all(r["evidence_status"] == "simulated_evidence" and "sim" in r["final_verdict"]
          for r in demos["runs"]))

# 18 cal board held do_not_build (Phase 13 unchanged)
check("18 calibration board held / do_not_order",
      bybrd["calibration_reference"]["order_recommendation"] == "do_not_order"
      and bybrd["calibration_reference"]["physical_validation_blocked"])

# 19 ADS1115 front-end not mislabeled (reference library)
lib = art("fl1-curated-reference-library")
fe = next((r for r in lib["references"] if r["name"] == "ads1115_measurement_front_end"), None) if lib else None
check("19 ADS1115 front-end not mislabeled as calibration board",
      fe and fe["board_class"] == "ADS1115 measurement front-end")

# 20 scope-lite unsupported
check("20 scope-lite remains unsupported / architecture-only",
      bybrd["scope_lite"]["order_recommendation"] == "unsupported")

# 21-24 honesty rails via the benchmark suite forbidden claims
suite = art("fl1-reference-benchmark-suite")
byb = {b["name"]: b for b in suite["benchmarks"]} if suite else {}
check("21 stimulus forbids function-generator-class",
      "function-generator-class performance" in byb["stimulus_funcgen_lite"]["unsupported_claims_forbidden"])
check("22 logic forbids logic-analyzer timing",
      "logic-analyzer-class timing" in byb["logic_capture"]["unsupported_claims_forbidden"])
check("23 DMM-lite forbids precision claim",
      "6-digit" in str(byb["dmm_lite"]["unsupported_claims_forbidden"]) or
      "6.5-digit precision" in byb["dmm_lite"]["unsupported_claims_forbidden"])
check("24 RF forbids RF guarantee",
      "RF performance guarantee" in byb["rf_50ohm_interface"]["unsupported_claims_forbidden"])

# policy unit: a do_not_build board never yields an order package regardless of routing
p_dnb = bp.build_policy("x", {"build_recommendation": "do_not_build", "routes_clean": True,
                              "drc_violations": 0, "assembly_ready": True, "attempted": True})
check("policy: do_not_build never order-ready even if routed",
      not p_dnb["allowed_to_generate_order_package"] and p_dnb["order_recommendation"] == "do_not_order")

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 15 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
