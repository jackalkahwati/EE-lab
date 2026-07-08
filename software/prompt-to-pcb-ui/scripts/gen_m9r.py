"""M9R: replay the quarantined M9 power-stage gates through M3B evidence.

The draft blocked motor/power-stage boards behind nine named requirements
and blocked mains outright. The replay wires each electrical claim through
the M3B gates and REAL board evidence:
- PI claims -> power_integrity_claim gate (blocked: load currents unknown)
  + real PDN inventories showing decoupling PRESENT != PI PROVEN;
- current-capacity claims -> current_measurement_accuracy_claim +
  calibration gates (blocked: physical references required);
- regulator stability -> regulator_stability_claim gate + the M3B SPICE
  benchmark's honest skipped_missing_input (no regulator model);
- thermal/safety -> structurally physical, no analysis path exists.
Nothing is upgraded; high-current and mains stay blocked.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import power_stage as ps  # noqa: E402
import external_eda as ee  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
D = os.path.join(RUNS, "fl1-backplane-v1", "data")

# ---- draft gates re-run -----------------------------------------------------
motor_today = ps.power_stage_gate({})
motor_full_evidence = ps.power_stage_gate(
    {k: True for k in ps.REQUIRED_FOR_POWER_STAGE})
mains = ps.mains_gate(230)
estimates = [ps.trace_width_estimate(a) for a in (0.5, 1, 2, 5, 10, 20, 30)]

# ---- M3B connections --------------------------------------------------------
pdn_boards = {}
for run in ("usbc-power-entry-v1", "fl1-core6-bare-rp2040-combination-v1"):
    bp = os.path.join(RUNS, run, "variant.kicad_pcb")
    if os.path.exists(bp):
        pdn_boards[run] = ee.pdn_inventory(bp)

spice = json.load(open(os.path.join(D, "compose-spice-benchmark-report.json")))

m3b = {
    "power_integrity_claim": ee.gate("power_integrity_claim"),
    "current_measurement_accuracy_claim":
        ee.gate("current_measurement_accuracy_claim"),
    "calibration_claim": ee.gate("calibration_claim"),
    "regulator_stability_claim": ee.gate("regulator_stability_claim"),
    "regulator_spice_benchmark":
        spice["benchmarks"]["regulator_stability"]["status"],
    "pdn_inventories_real_boards": pdn_boards,
    "note": "PDN inventories parse REAL .kicad_pcb rails/decoupling; "
            "presence is inventory, not power integrity"}

evidence_requirements = {
    "current_capacity_claim": ["current-path evidence (trace/via/copper "
                               "cross-section analysis) — ABSENT",
                               "physical current measurement — ABSENT"],
    "thermal_claim": ["thermal model or measurement — ABSENT (structurally "
                      "physical; no analysis engine exists)"],
    "regulator_stability_claim": ["regulator SPICE/loop model — ABSENT "
                                  "(M3B benchmark: skipped_missing_input)",
                                  "or bench evidence — ABSENT"],
    "strong_PI_claim": ["physical measurement — ABSENT (ledger empty)"],
}

blocked = {
    "blocked_claims": sorted(set(ps.BLOCKED) | {
        "power_integrity_claim", "current_measurement_accuracy_claim",
        "calibration_claim", "regulator_stability_claim"}),
    "m3b_gate_states": {k: v["state"] for k, v in m3b.items()
                        if isinstance(v, dict) and "state" in v},
    "note": "every electrical power claim now routes through an M3B gate; "
            "thermal/safety/mains have no gate to pass — structurally "
            "blocked"}

led = json.load(open(os.path.join(RUNS, "power-entry-header-2l", "data",
                                  "compose-physical-evidence-ledger.json")))

report = {
    "version": "v1", "milestone": "M9R power-stage gates replay",
    "replayed_from": "drafts/m7-m12-pre-hardening (M9)",
    "trace_width_estimates": estimates,
    "estimate_language_preserved": all(
        "ESTIMATE" in e["basis"] for e in estimates if e["min_width_mm"]),
    "beyond_range_blocked": estimates[-1]["min_width_mm"] is None,
    "power_stage_gate": {
        "required": list(ps.REQUIRED_FOR_POWER_STAGE),
        "motor_board_today": motor_today,
        "with_full_evidence_still_review_required": motor_full_evidence},
    "mains": {"230V_request": mains, "envelope": "<=48V review-required"},
    "m3b_connection": m3b,
    "evidence_requirements": evidence_requirements,
    "verdict": "ACCEPTED as gates: low/moderate power-tree metadata exists "
               "(rails/decoupling inventories on real boards); high-current "
               "power stage BLOCKED (9 requirements missing); mains BLOCKED; "
               "PI/current/thermal/stability claims blocked without evidence",
    "physical_ledger": {"artifacts": led["artifacts"],
                        "order_status": led["order_status"]},
    "no_ordering_action": True,
    "honesty": "widths are IPC-2221 ESTIMATES, review-required; no thermal, "
               "safety, current-rating, or PI claim; simulation would not "
               "be physical evidence either"}

md = """# M9R — power-stage gates replay through EDA evidence

## Accepted (gate/blocker milestone)
- Trace-width table stays an IPC-2221 ESTIMATE, review-required; beyond
  20 A returns None (human power engineer required).
- Power-stage gate: motor board blocked today (all 9 requirements
  missing); even with every requirement evidenced it stays
  review-required with thermal/safety claims still blocked.
- Mains (230 V) blocked — no support, no creepage table.

## M3B connections (new under replay)
- power_integrity_claim: blocked — load currents unknown. Real PDN
  inventories on usbc-power-entry-v1 and the FL-1 Core-6 board show
  rails + decoupling counts; presence is inventory, not PI.
- current-capacity claims: routed through current_measurement_accuracy +
  calibration gates — blocked, physical references required.
- regulator stability: gate blocked; M3B SPICE benchmark records
  skipped_missing_input (no regulator model) rather than a fake sim.
- thermal: structurally physical; no engine, no claim.

Physical ledger untouched; no ordering or quote action.
"""

for r in ["fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1"]:
    d = os.path.join(RUNS, r, "data")
    json.dump(report, open(os.path.join(
        d, "m9r-power-stage-replay-report.json"), "w"), indent=1)
    open(os.path.join(d, "m9r-power-stage-replay-report.md"), "w").write(md)
    json.dump(m3b, open(os.path.join(
        d, "m9r-power-external-analysis.json"), "w"), indent=1)
    json.dump(blocked, open(os.path.join(
        d, "m9r-power-blocked-claims.json"), "w"), indent=1)

print("M9R: motor=%s mains=%s | PI gate=%s | pdn boards=%d" %
      (motor_today["verdict"], mains["verdict"],
       m3b["power_integrity_claim"]["state"], len(pdn_boards)))
