"""Phase 13 D/D.5/E/F report and policy contracts, not historical board evidence.

Both blocked and fixed predicates are explicit synthetic INPUT scenarios. Real
benchmark/signoff producers generate the assertions' report outputs. No router
pass report is seeded, and neither scenario certifies the historical cal board.

Run through regression_support's disposable source snapshot.
"""
import json
import os
import sys

import benchmark_model as bm
import benchmark_score as bscore
import reference_library as rl
from report_regression_fixtures import (
    finegrid_policy_input, historical_calibration_artifacts, policy_artifacts,
)

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s: %s%s" % ("PASS" if ok else "FAIL", case, name,
                              "  -> " + detail if detail else ""))


for fixed_policy in (False, True):
    case = "synthetic-fixed-policy" if fixed_policy else "synthetic-blocked-policy"
    RD = policy_artifacts(fixed=fixed_policy)

    def art(name):
        p = os.path.join(RD, name + ".json")
        return json.load(open(p)) if os.path.exists(p) else None

    # ---- D: benchmark model + suite ----
    check("11 reference PCBA benchmark model generated", art("reference-pcba-benchmark-model") is not None)
    suite = art("fl1-reference-benchmark-suite")
    check("12 FL-1 benchmark suite (10 boards) generated", suite and suite["benchmark_count"] == 10)

    # ---- E: scoring engine, explicitly synthetic failure policy input ----
    cal_ev = {"parts_present": {"voltage_reference": True, "adc": True, "memory.eeprom": True},
              "ingested": {"voltage_reference": True, "adc": True, "memory.eeprom": True},
              "shared_bus": "connected",
              "fine_pitch": {"result": "escaped_but_drc_failed", "exact_blocker": "blocked_by_grid_resolution"},
              "drc": {"violations": 13, "shorts": 13}, "test_points": ["REF_OUT", "REF_DIV"],
              "calibration_ok": True, "reference_coverage": rl.coverage_for("calibration_reference")}
    cal_score = bscore.score(bm.get("calibration_reference"), cal_ev)
    check("13 scoring engine: cal board = do_not_build / blocked_by_grid_resolution",
          cal_score["status"] == "do_not_build" and cal_score["exact_blocker"] == "blocked_by_grid_resolution",
          cal_score["status"])

    # ---- F: signoff reports generated ----
    for dom in ["power", "analog", "digital", "high-speed", "rf-50ohm", "manufacturing", "combined"]:
        check("%s signoff report generated" % dom, art("%s-signoff-report" % dom) is not None)
    rf = art("rf-50ohm-signoff-report")
    check("18 RF signoff has NO RF guarantee",
          rf and any("NO RF performance" in c["detail"] for c in rf["checks"]))
    comb = art("combined-signoff-report")
    # Exercise both legacy conditional branches with an in-memory policy INPUT.
    # This is not art("calibration-board-finegrid-result") or router evidence.
    _fg = finegrid_policy_input(fixed=fixed_policy)
    _fixed = bool(_fg and _fg.get("outcome") == "A_physical_pass")
    check("cal combined signoff honest (do_not_build unless truly fixed)",
          comb and (comb["recommendation"] != "do_not_build" if _fixed
                    else comb["recommendation"] == "do_not_build"))

    # ---- honesty rails: scope/stimulus/logic/FPGA ----
    check("22 scope-lite forbids oscilloscope-class claims",
          "oscilloscope-class bandwidth" in bm.get("scope_lite")["unsupported_claims_forbidden"])
    check("22b scope-lite claiming oscilloscope perf -> fail",
          bscore.score(bm.get("scope_lite"), {"claimed": ["oscilloscope-class bandwidth"]})["status"]
          in ("benchmark_fail", "do_not_build"))
    check("23 stimulus forbids function-generator claims",
          "function-generator-class performance" in bm.get("stimulus_funcgen_lite")["unsupported_claims_forbidden"])
    check("24 logic forbids logic-analyzer timing claims",
          "logic-analyzer-class timing" in bm.get("logic_capture")["unsupported_claims_forbidden"])

    # ---- D.5: reference library ----
    lib = art("fl1-curated-reference-library")
    check("D.5.1 reference manifest schema generated", art("reference-library-manifest-schema") is not None)
    check("D.5.2 internal FirstLight refs = internal_firstlight",
          all(r["trust_classification"] == "internal_firstlight" for r in rl.INTERNAL))
    check("D.5.3 manufacturer refs default direct_reuse=false",
          all(not r["direct_reuse"] for r in rl.EXTERNAL if r["trust_classification"] == "manufacturer_reference_only"))
    check("D.5.4 open-source refs default direct_reuse=false until license review",
          all(not r["direct_reuse"] and r["status"] == "needs_source_file"
              for r in rl.EXTERNAL if r["trust_classification"] == "open_source_needs_license_review"))
    check("D.5 external source files marked needs_source_file",
          all(r["status"] == "needs_source_file" for r in rl.EXTERNAL))
    fe = next(r for r in rl.INTERNAL if r["name"] == "ads1115_measurement_front_end")
    check("D.5 ADS1115 front-end NOT mislabeled as calibration board",
          fe["board_class"] == "ADS1115 measurement front-end" and "SUB-PATTERN" in fe["known_limitations"][0])
    check("D.5 real cal board attempt is its own reference item",
          any(r["name"] == "fl1_calibration_reference_attempt" for r in rl.INTERNAL))
    check("D.5.6 benchmark scoring includes reference coverage",
          "reference_coverage" in cal_score and cal_score["reference_coverage"]["internal"] is not None)

    # external references alone cannot make a board ready_to_build (no internal ref)
    ext_only = bscore.score(bm.get("rf_50ohm_interface"),
                            {"parts_present": {}, "rf": {"estimate": True},
                             "reference_coverage": {"internal_reference_coverage": 0, "reference_count": 2,
                                                    "open_source_reference_coverage": 1,
                                                    "reusable_reference_count": 0}})
    check("D.5.10 external references alone cannot -> benchmark_pass",
          ext_only["status"] != "benchmark_pass", ext_only["status"])

    # unknown trust -> not reusable
    check("D.5.5 unknown/idea refs default direct_reuse=false",
          all(not r["direct_reuse"] for r in rl.EXTERNAL if r["trust_classification"] in ("idea_only", "unknown_untrusted")))

    # ---- dashboard + fine-pitch policy checkpoint ----
    dash = art("fl1-build-readiness-dashboard")
    cal_d = next(b for b in dash["boards"] if b["board"] == "calibration_reference") if dash else None
    check("21 dashboard: cal board honest (review-required if fixed, else do_not_build)",
          cal_d and (cal_d["recommendation"] == "ready_to_build_with_review" if _fixed
                     else cal_d["recommendation"] == "do_not_build"))
    check("scope-lite stays unsupported in the dashboard",
          next(b for b in dash["boards"] if b["board"] == "scope_lite")["recommendation"] == "unsupported")
    check("12(checkpoint) cal fine-pitch state matches reality",
          cal_d and (cal_d["fine_pitch_escape"] == "escaped_and_checked" if _fixed
                     else cal_d["fine_pitch_escape"] == "escaped_but_drc_failed"))

# Separate unresolved historical linkage, never satisfied by the policy seeds.
case = "historical-calibration-dependency"
RD = historical_calibration_artifacts()
_fg = art("calibration-board-finegrid-result")
_fixed = bool(_fg and _fg.get("outcome") == "A_physical_pass")
comb = art("combined-signoff-report")
dash = art("fl1-build-readiness-dashboard")
cal_d = next((b for b in dash["boards"] if b["board"] == "calibration_reference"), None) if dash else None
check("historical finegrid/signoff/dashboard artifacts reconstructed by real producers",
      _fg is not None and comb is not None and cal_d is not None,
      "UNRESOLVED dependency: genuine calibration routing, finegrid and downstream reports")
check("cal combined signoff honest (do_not_build unless truly fixed)",
      comb and (comb["recommendation"] != "do_not_build" if _fixed
                else comb["recommendation"] == "do_not_build"))
check("21 dashboard: cal board honest (review-required if fixed, else do_not_build)",
      cal_d and (cal_d["recommendation"] == "ready_to_build_with_review" if _fixed
                 else cal_d["recommendation"] == "do_not_build"))
check("12(checkpoint) cal fine-pitch state matches reality",
      cal_d and (cal_d["fine_pitch_escape"] == "escaped_and_checked" if _fixed
                 else cal_d["fine_pitch_escape"] == "escaped_but_drc_failed"))

npass = sum(1 for ok in checks if ok)
print("%d/%d benchmark+signoff checks pass (two synthetic policy scenarios)" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
