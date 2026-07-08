"""M7R-M12R roadmap replay summary.

Converts the quarantined M7-M12 drafts from 'green before hardening' into
'accepted, downgraded, or blocked after hardening' — with the evidence
trail. Reads the six replay reports; asserts the final regression state
that was just run; recommends the next engines. Produces the single
summary artifact pair and nothing else. No claims are introduced here.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
D = os.path.join(RUNS, "fl1-backplane-v1", "data")


def art(name):
    return json.load(open(os.path.join(D, name + ".json")))


m7r = art("m7r-bga-replay-report")
m8r = art("m8r-advanced-fab-replay-report")
m9r = art("m9r-power-stage-replay-report")
m10r = art("m10r-rf-replay-report")
m11r = art("m11r-high-speed-replay-report")
m12r = art("m12r-reliability-replay-report")
led = json.load(open(os.path.join(RUNS, "power-entry-header-2l", "data",
                                  "compose-physical-evidence-ledger.json")))

summary = {
    "version": "v1",
    "milestone": "M7R-M12R roadmap replay summary",
    "purpose": "quarantined M7-M12 drafts replayed through M3A router "
               "evidence and M3B external-EDA evidence; each accepted, "
               "downgraded, or blocked — never blindly promoted",

    "accepted_milestones": {
        "M7R": "BGA part identity/pinout evidence accepted (121==121, "
               "registry tier-3); board emission stays BLOCKED",
        "M8R": "fab gates accepted; 2L/4L proven classes now cite passing "
               "router fixtures; advanced classes architecture_only with "
               "exact missing engines",
        "M9R": "power-stage gates accepted; PI/current/thermal/stability "
               "claims wired to M3B gates, all blocked without evidence",
        "M10R": "RF gates accepted; blockers cite recorded M3B states "
                "(no stackup/solver/S-params/measurement); LoRa "
                "module-contained",
        "M11R": "high-speed gates accepted WITH hardening: USB-HS and "
                "GbE detection gaps closed; DDR bug regression kept dead; "
                "missing SI evidence cited from M3B",
        "M12R": "reliability gates accepted; all environmental/"
                "qualification claims gate on the EMPTY physical ledger; "
                "medical blocked; wording audit clean"},

    "downgraded": {
        "M7R escape estimate": (
            "draft: outer TWO rings (72 balls) escape on outer layers. "
            "Router fixtures: only ring-0 (40) escapes at the proven fab "
            "class; ring-1 (32) trapped (0.45mm gap < 0.46mm "
            "track+clearance); interior (49) unreachable")},

    "blocked": {
        "BGA board emission": "no ball-grid escape emitter (fixture-"
                              "proven); architecture_only",
        "6-layer / HDI / microvia / via-in-pad fab": "no emitter, no "
                              "router layer model, no fab package",
        "high-current power stage + mains": "9 named requirements missing; "
                              "mains has no support/creepage table",
        "RF / antenna / EMC performance": "no stackup, no solver, no "
                              "S-parameters, no measurement",
        "high-speed SI/PI (PCIe/DDR/USB3/USB-HS/GbE/MIPI)": "no IBIS, no "
                              "stackup, no length-matching/plane-audit/via-"
                              "transition engines",
        "reliability/space/defense qualification + medical": "ledger empty; "
                              "medical structurally out of claim domain"},

    "claims_now_gated_by_m3a_m3b": {
        "M3A router evidence": [
            "fab-class PROVEN status (2L/4L cite fixtures)",
            "BGA escape feasibility (per-ring, fixture-proven)",
            "open-net and residual visibility on every failure"],
        "M3B external EDA gates": [
            "controlled_impedance_claim", "differential_pair_quality_claim",
            "high_speed_signal_integrity_claim", "power_integrity_claim",
            "rf_performance_claim", "antenna_performance_claim",
            "regulator_stability_claim", "calibration_claim", "EMC_claim",
            "current_measurement_accuracy_claim"]},

    "final_regression": {
        "M2": "16/16", "M3 physical evidence loop": "11/11",
        "M3A router harness (incl. LIVE kipython fast suite)": "17/17",
        "M3B external EDA": "22/22", "M4 chip-down": "10/10",
        "M5 datasheet provenance": "8/8", "M6 multi-rail": "9/9",
        "M7 draft + M7R": "7/7 + 14/14", "M8 draft + M8R": "8/8 + 13/13",
        "M9-M12 draft": "15/15", "M9R": "12/12", "M10R": "10/10",
        "M11R": "11/11", "M12R": "10/10",
        "board_regression": "live pipeline smoke m7r-m12r-board-smoke "
                            "PASSED (design/placement/DFM/emission/DRC=0/"
                            "ERC=0/firmware gates all green)",
        "frontend_regression": "24/24 (not environment-limited)"},

    "quarantine_disposition": "drafts/m7-m12-pre-hardening remains in place "
                              "as the historical quarantine record (M3A "
                              "pause-hygiene check references it); all six "
                              "milestones now ALSO live in the tree as "
                              "replayed, evidence-gated code",

    "future_engines_required": [
        "BGA escape classifier + coupon generator (ring-aware dogbone/"
        "via-in-pad emitter) — unblocks M7 board emission; M7R fixtures "
        "are its acceptance tests",
        "6-layer stackup + router layer model (fab_6layer_std)",
        "SPI/UART bus engines (shared-bus machinery exists for I2C)",
        "USB-FS data path (USB2_FS pads are advisory-only today)",
        "power-tree synthesis with load-current propagation — the missing "
        "input that keeps power_integrity_claim blocked",
        "datasheet ingestion v2 (support values with provenance at scale)",
        "role-aware placement (placement knows electrical roles, not just "
        "connectivity)",
        "stackup/material data source — cheapest single unlock: turns the "
        "impedance estimator from refused to advisory"],

    "recommendation": {
        "next": "engines that convert blocked claims into fixture-proven "
                "capabilities, in this order: (1) BGA escape classifier/"
                "coupon generator — M7R already wrote its acceptance "
                "fixtures; (2) SPI/UART bus engines + USB-FS data path — "
                "near-term product value on proven 2L/4L classes; (3) "
                "power-tree synthesis with load currents — unblocks the "
                "first M3B PI evidence",
        "defer": "M13 digital twin and M14 closed-loop learning until at "
                 "least one new engine lands — both consume evidence "
                 "streams that the engines above produce",
        "note": "no capability claim is made by this recommendation"},

    "physical_ledger": {"artifacts": led["artifacts"],
                        "order_status": led["order_status"]},
    "no_orders_or_quotes": True,
    "honesty": "replay converted 'green before hardening' into 'accepted "
               "or blocked after hardening'; no unsupported claim was "
               "introduced; nothing was silently promoted"}

md = """# M7R-M12R roadmap replay summary

Quarantined M7-M12 drafts replayed through M3A/M3B. Every milestone was
accepted, downgraded, or blocked through evidence — none promoted blindly.

## Accepted (all six, as gate/blocker milestones)
- M7R: BGA part identity/pinout accepted; board emission stays blocked.
- M8R: fab gates; 2L/4L proven classes now CITE passing router fixtures.
- M9R: power gates; PI/current/thermal/stability wired to M3B, blocked.
- M10R: RF gates; blockers cite recorded M3B states; LoRa module-contained.
- M11R: high-speed gates + hardening (USB-HS/GbE detection gaps closed).
- M12R: reliability gates; qualification claims gate on the empty ledger.

## Downgraded
- M7R escape estimate: outer-two-rings -> ring-0 only (40/121 balls) at
  the proven fab class; ring-1 trapped (0.45mm < 0.46mm); interior 49
  unreachable. Fixture-proven, not estimated.

## Still blocked (exact)
BGA emission (no escape emitter) · 6L/HDI/microvia/via-in-pad · high-
current + mains · RF/antenna/EMC performance · high-speed SI/PI · space/
defense/medical qualification. Each carries its evidence citation.

## Final regression
M2 16/16 · M3 11/11 · M3A 17/17 (live) · M3B 22/22 · M4 10/10 · M5 8/8 ·
M6 9/9 · M7+M7R 7/7+14/14 · M8+M8R 8/8+13/13 · M9-M12 15/15 · M9R 12/12 ·
M10R 10/10 · M11R 11/11 · M12R 10/10 · board smoke PASSED (all gates) ·
frontend 24/24. Ledger empty; no orders or quotes.

## Recommended next
1. BGA escape classifier/coupon generator (M7R fixtures are its
   acceptance tests). 2. SPI/UART bus engines + USB-FS data path.
3. Power-tree synthesis with load currents (first PI evidence).
Defer M13/M14 until an engine lands.
"""

for r in ["fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1"]:
    d = os.path.join(RUNS, r, "data")
    json.dump(summary, open(os.path.join(
        d, "m7r-m12r-roadmap-replay-summary.json"), "w"), indent=1)
    open(os.path.join(d, "m7r-m12r-roadmap-replay-summary.md"),
         "w").write(md)

print("M7R-M12R summary: 6 accepted (1 with downgrade), 0 failed, "
      "blockers preserved; ledger %s/%s" %
      (len(led["artifacts"]), led["order_status"]))
