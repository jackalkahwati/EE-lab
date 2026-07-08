"""M9R regression: power-stage gates replay through M3B evidence."""
import json
import os
import sys

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public",
                 "runs", "fl1-backplane-v1", "data")


def art(name):
    p = os.path.join(D, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


rep = art("m9r-power-stage-replay-report")
check("1 replay report exists, sourced from the quarantine",
      rep is not None and "m7-m12-pre-hardening" in rep["replayed_from"])
check("2 trace widths stay ESTIMATE, review-required; >20A blocked",
      rep["estimate_language_preserved"] is True
      and rep["beyond_range_blocked"] is True)
g = rep["power_stage_gate"]
check("3 motor board blocked today (all 9 requirements missing)",
      g["motor_board_today"]["verdict"] == "blocked"
      and len(g["motor_board_today"]["missing"]) == 9)
check("4 full evidence still review-required; thermal still blocked",
      g["with_full_evidence_still_review_required"]["verdict"]
      == "architecture_ready_for_review"
      and "thermal_performance" in
      g["with_full_evidence_still_review_required"]["blocked_claims"])
check("5 mains 230V blocked", rep["mains"]["230V_request"]["verdict"]
      == "blocked")
m3b = rep["m3b_connection"]
check("6 PI claim blocked via M3B gate (load currents unknown)",
      m3b["power_integrity_claim"]["state"] == "blocked")
check("7 current-capacity routed through accuracy+calibration gates, blocked",
      m3b["current_measurement_accuracy_claim"]["state"] == "blocked"
      and m3b["calibration_claim"]["state"] == "blocked")
check("8 regulator stability blocked; SPICE benchmark honestly skipped",
      m3b["regulator_stability_claim"]["state"] == "blocked"
      and m3b["regulator_spice_benchmark"] == "skipped_missing_input")
check("9 real PDN inventories attached (2 boards), PI blocked on each",
      len(m3b["pdn_inventories_real_boards"]) == 2
      and all("power_integrity_claim" in b["blocked_claims"]
              for b in m3b["pdn_inventories_real_boards"].values()))
check("10 thermal requires evidence that does not exist (structural)",
      "ABSENT" in str(rep["evidence_requirements"]["thermal_claim"]))
bc = art("m9r-power-blocked-claims")
check("11 blocked claims include thermal/safety/mains/motor/current-rating",
      all(c in bc["blocked_claims"] for c in
          ("thermal_performance", "safety_certification", "mains_voltage",
           "motor_drive_readiness", "current_rating_guarantee")))
check("12 physical ledger untouched; no ordering action",
      rep["physical_ledger"]["artifacts"] == []
      and rep["physical_ledger"]["order_status"] == "not_ordered"
      and rep["no_ordering_action"] is True)

npass = sum(1 for ok in checks if ok)
print("%d/%d M9R checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
