"""Phase 16 regression: calibration, traceability, closed-loop redesign.

The rails: no fake calibration/traceability, simulated evidence never physical,
failed evidence preserved + feeds redesign, Rev B never automatic, held boards
stay held, no precision claims without evidence.

  python3 test_phase16.py
"""
import json
import os
import sys

import redesign_engine as rde

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RD = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs",
                  "fl1-core-relay-v2", "data")


def art(name):
    p = os.path.join(RD, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


# 1-13: artifacts generated
for n, name in [(1, "fl1-board-identity-model"), (2, "fl1-batch1-serial-plan"),
                (3, "calibration-state-model"), (4, "measurement-uncertainty-policy"),
                (5, "validation-evidence-ledger-model"),
                (6, "fl1-incoming-inspection-workflows"),
                (7, "fl1-batch1-bringup-workflows"),
                (8, "fl1-batch1-calibration-verification-workflows"),
                (9, "fl1-failure-taxonomy"), (10, "closed-loop-redesign-engine"),
                (11, "revb-redesign-package-model"),
                (12, "phase16-batch1-traceability-package"),
                (13, "phase16-held-board-status")]:
    check("%d %s generated" % (n, name), art(name) is not None)

# 14-16: identity + serial stubs per board
plan = art("fl1-batch1-serial-plan")
sers = {s["board_type"] for s in plan["serials"]}
check("14-16 all three boards receive identity + serial stubs",
      sers == {"controller_backplane", "digital_bringup", "relay_probe_matrix"}
      and len(plan["serials"]) == 9)
check("serials carry REAL artifact hashes",
      all(s["bom_hash"] and s["bom_hash"].startswith("sha256:") for s in plan["serials"]))
check("lifecycle starts honest (first_article_review_required, not ordered/received)",
      all(s["current_lifecycle_state"] == "first_article_review_required"
          and s["physical_received_date"] is None for s in plan["serials"]))

# 17-21: held boards stay held + no forbidden claims
held = {b["board"]: b for b in art("phase16-held-board-status")["boards"]}
check("17 calibration/reference remains physically blocked",
      "blocked_by_grid_resolution" in held["calibration_reference"]["why_held"]
      and held["calibration_reference"]["physical_calibration"] == "do_not_calibrate_physical")
check("18 scope-lite remains unsupported", "unsupported" in held["scope_lite"]["why_held"])
check("19 DMM-lite: no calibrated-precision claim",
      "NO calibrated-precision" in held["dmm_lite"]["why_held"])
check("20 stimulus: no funcgen-class claim",
      "NO function-generator-class" in held["stimulus_funcgen_lite"]["why_held"])
check("21 logic capture: no LA-timing claim",
      "NO logic-analyzer-class" in held["logic_capture"]["why_held"])

# 22-23: simulated evidence rails
demos = art("phase16-demo-runs")
check("22 simulated evidence cannot satisfy physical validation",
      all(not e["satisfies_physical_validation"] for e in demos["evidence_ledger"]))
check("23 mock calibration marked simulated (mock_calibrated, never physical)",
      all(e["calibration_state_after"] == "mock_calibrated" for e in demos["evidence_ledger"]))

# 24: no precision claim without calibration evidence
pol = art("measurement-uncertainty-policy")
mv = next(c for c in pol["capabilities"] if c["capability"] == "measure_voltage")
check("24 no precision claim without calibration evidence",
      "precision" in mv["forbidden_claims"]
      and any("no 'precision' claim" in r for r in pol["claim_rules"]))
check("24b scope/funcgen/LA/RF claims forbidden in policy",
      any("oscilloscope-class" in r for r in pol["claim_rules"])
      and any("function-generator-class" in r for r in pol["claim_rules"])
      and any("logic-analyzer-class" in r for r in pol["claim_rules"])
      and any("RF accuracy" in r for r in pol["claim_rules"]))

# 25-27: failure demo -> ledger preserved -> redesign cites evidence
fdemo = next(d for d in demos["demos"] if "failure demo" in d["demo"])
check("25 evidence ledger preserves FAILED evidence",
      fdemo["ledger_entry"]["pass_fail_status"] == "simulated_fail"
      and any(e["pass_fail_status"] == "simulated_fail" for e in demos["evidence_ledger"]))
rec = fdemo["redesign_recommendation"]
check("26 redesign recommendation cites evidence",
      len(rec["evidence"]) > 0 and rec["rev_a_evidence_preserved"])
revb = art("revb-redesign-package-model")
check("27 Rev B package preserves Rev A evidence",
      any("Rev A evidence" in r for r in revb["rules"]))

# 28: no automatic silent redesign
check("28 no automatic redesign (human review required, auto=False)",
      rec["required_human_review"] and not rec["automatic_redesign_allowed"]
      and any("never created automatically" in r for r in rde.engine_model()["rules"]))

# demo 5: cal board physical calibration blocked
cal_demo = next(d for d in demos["demos"] if "physical calibration" in d["demo"])
check("16(acc) do_not_build board is not physically calibrated",
      cal_demo["final_verdict"] == "do_not_calibrate_physical" and cal_demo["physical_blocked"])

# 30-33: prior-phase verdicts unchanged
role = art("role-completeness-report")
check("30 Phase 15.6 role-completeness unchanged",
      role and role["status"] in ("role_complete", "role_complete_with_review"))
fa = art("phase15-first-article-review-v2")
check("31 Phase 15 FA review v2 unchanged", "order_3_pcba_review_required" in fa["batch_decision"])
cal_b = json.load(open(os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui",
                                    "public", "runs", "fl1-cal-board", "data",
                                    "cal-board-attempt.json")))
_cal_fixed = cal_b["fine_pitch_escape"].get("result") == "escaped_and_checked"
check("32-33 cal board build state honest (fixed -> review, else do_not_build)",
      cal_b["fine_pitch_escape"]["build_recommendation"] ==
      ("ready_to_build_with_review" if _cal_fixed else "do_not_build"))

# calibration state model rules
csm = art("calibration-state-model")
check("36-38 calibration rules: mock never physical, cots needs identity, internal needs real board",
      any("NEVER physical" in r for r in csm["rules"])
      and any("instrument's identity" in r for r in csm["rules"])
      and any("EXISTS" in r for r in csm["rules"]))

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 16 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
