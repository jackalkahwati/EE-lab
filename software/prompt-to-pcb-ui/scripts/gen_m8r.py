"""M8R: replay the quarantined M8 advanced-fab gates through M3A/M3B.

The draft modeled five fab profiles and gated everything beyond proven
2L/4L as architecture_only. The replay connects each profile to EVIDENCE:
- proven classes cite the actual M3A router fixtures + realboard replays
  that exercised them (not just a "PROVEN" string);
- unproven classes cite the router fixtures that prove the TRIGGER case
  fails (M7R bga suite), plus the missing engines;
- controlled-impedance/stackup language routes through the M3B claim gates
  and toolchain inventory (no stackup data in repo -> blocked).
No fab class is upgraded; the M7R ring-1 finding is folded into the BGA
trigger notes.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import advanced_fab as af  # noqa: E402
import external_eda as ee  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
D = os.path.join(RUNS, "fl1-backplane-v1", "data")

m3a = json.load(open(os.path.join(D, "flroute-regression-report.json")))
m7r = json.load(open(os.path.join(D, "m7r-bga-router-evidence.json")))
inv = ee.inventory()

full = {r["fixture_id"]: r for r in m3a["full_suite"]["results"]}
# realboard replays live in their own section of the saved M3A artifact
full.update({r["fixture_id"]: r
             for r in m3a.get("realboard_suite", {}).get("results", [])})
bga = {r["fixture_id"]: r for r in m7r["results"]}


def _cite(ids, pool):
    return [{"fixture_id": i, "pass": pool[i]["pass"],
             "actual_result": pool[i]["actual_result"],
             "drc_violations": (pool[i].get("drc") or {}).get("violations")}
            for i in ids if i in pool]


# ---- router evidence per fab profile ---------------------------------------
router_evidence = {
    "fab_2layer_std": {
        "state": "PROVEN",
        "fixtures": _cite(["two_layer_no_internal_layers",
                           "rb_power_entry_header_2l"], full),
        "note": "2-layer profile emits no inner copper (fixture-asserted) "
                "and replays a real synthesized 2L board DRC-clean"},
    "fab_4layer_std": {
        "state": "PROVEN",
        "fixtures": _cite(["four_layer_internal_allowed",
                           "qfn_corner_escape_simple",
                           "qfn_side_escape_dense",
                           "rp2040_like_qfn56_reduced",
                           "rb_power_entry_header_v1"], full),
        "note": "4-layer profile carries the QFN-56 fine-pitch escape "
                "fixtures and a real synthesized 4L board replay"},
    "fab_6layer_std": {
        "state": "architecture_only",
        "fixtures": [],
        "missing": ["LAYERS6 stackup in the emitter", "router layer model",
                    "6-layer DSN/SES profile"],
        "trigger_case_evidence": _cite(["bga121_interior_ball_no_emitter"],
                                       bga),
        "note": "the case that DEMANDS 6 layers (full-array BGA interior "
                "escape) is fixture-proven to fail today — the gate is load-"
                "bearing, not decorative"},
    "fab_hdi_1_2_1": {
        "state": "architecture_only",
        "fixtures": [],
        "missing": ["microvia emitter", "via-in-pad fill/cap fab package",
                    "HDI router layer model", "stackup data (M3B: none in "
                    "repo)"],
        "trigger_case_evidence": _cite(["bga121_ring1_trapped"], bga),
        "note": "M7R replay finding folded in: even ring-1 of a COARSE "
                "0.8mm BGA is trapped at the proven fab class (0.45mm gap "
                "< 0.46mm track+clearance) — via-in-pad/dogbone or a finer "
                "class is required earlier than the draft estimated"},
    "fab_hdi_2_2_2": {
        "state": "architecture_only", "fixtures": [],
        "missing": ["everything fab_hdi_1_2_1 misses, stacked"],
        "note": "no evidence path exists"},
}

# ---- gate matrix re-run (same cases as the draft) ---------------------------
CASES = {
    "simple 2L power board": {},
    "QFN-56 core (4L)": {},
    "coarse full-array BGA-121 (iCE40)": {"bga_pitch_mm": 0.8,
                                          "full_array_bga": True},
    "fine BGA 0.5mm": {"bga_pitch_mm": 0.5},
    "WLCSP": {"wlcsp": True},
    "congested 3-signal-layer board": {"congestion_layers": 3},
}
gates = {k: af.gate(v) for k, v in CASES.items()}
unsupported_never_allowed = all(
    g["verdict"] == "architecture_only" for k, g in gates.items()
    if k not in ("simple 2L power board", "QFN-56 core (4L)"))

# ---- M3B connection: impedance/stackup ---------------------------------------
m3b = {
    "stackup_model_local": inv["tools"]["stackup_model_local"],
    "controlled_impedance_claim": ee.gate("controlled_impedance_claim"),
    "impedance_estimator_behavior": ee.impedance_report(None),
    "note": "advanced fab profiles that would enable controlled impedance "
            "stay gated by M3B: no stackup/material data in the repo, so "
            "the claim is blocked regardless of fab class"}

blocked = {
    "blocked_claims": ["HDI readiness", "microvia support",
                       "via-in-pad support", "6-layer emission",
                       "advanced fab cost/yield",
                       "controlled_impedance_claim (M3B gate)"],
    "m3b_gates": {"controlled_impedance_claim":
                  ee.gate("controlled_impedance_claim")["state"]},
    "note": "unsupported fab classes cannot appear as routable: gate() "
            "returns architecture_only with the exact missing engine list"}

led = json.load(open(os.path.join(RUNS, "power-entry-header-2l", "data",
                                  "compose-physical-evidence-ledger.json")))

report = {
    "version": "v1", "milestone": "M8R advanced fabrication gates replay",
    "replayed_from": "drafts/m7-m12-pre-hardening (M8)",
    "profiles": af.FAB_PROFILES,
    "gate_results": gates,
    "unsupported_never_allowed": unsupported_never_allowed,
    "router_evidence_connection": router_evidence,
    "m3b_connection": m3b,
    "m7r_finding_folded_in": (
        "coarse-BGA trigger notes updated: ring-1 escape needs via-in-pad/"
        "dogbone or finer fab class (fixture bga121_ring1_trapped), so the "
        "'coarse full-array BGA -> 6-layer' trigger UNDERSTATES the need; "
        "the verdict was already architecture_only — unchanged"),
    "verdict": "ACCEPTED as gates: 2L/4L remain proven (now fixture-cited); "
               "6L/HDI/via-in-pad/WLCSP remain architecture_only with exact "
               "missing engines; no class upgraded",
    "physical_ledger": {"artifacts": led["artifacts"],
                        "order_status": led["order_status"]},
    "no_ordering_action": True,
    "honesty": "gates REFUSE to pretend; router evidence cited, not "
               "asserted; nothing here emits HDI/6-layer boards"}

md = """# M8R — advanced fabrication gates replay through hardening gates

## Accepted (now evidence-cited, was string-asserted)
- fab_2layer_std: PROVEN — fixtures two_layer_no_internal_layers (no inner
  copper) + rb_power_entry_header_2l (real 2L board replay, DRC clean).
- fab_4layer_std: PROVEN — four_layer_internal_allowed + QFN-56 escape
  fixtures + rb_power_entry_header_v1.

## Still architecture_only (exact missing engines)
- fab_6layer_std: no LAYERS6 stackup/emitter/router model. Trigger case
  (full-array BGA interior) fixture-proven to FAIL today.
- fab_hdi_1_2_1 / 2_2_2: no microvia emitter, no via-in-pad fab package,
  no HDI router model, no stackup data (M3B).
- WLCSP: HDI class, same gaps.

## M7R finding folded in
Ring-1 of a coarse 0.8mm BGA is already trapped at the proven fab class —
via-in-pad/dogbone is needed earlier than the draft estimated. Verdicts
unchanged (already architecture_only); trigger notes corrected.

## M3B connection
Controlled impedance stays blocked: no stackup/material data in the repo;
the estimator refuses without a sourced stackup. Fab class alone never
unlocks an impedance claim.

Physical ledger untouched; no ordering or quote action.
"""

for r in ["fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1"]:
    d = os.path.join(RUNS, r, "data")
    json.dump(report, open(os.path.join(
        d, "m8r-advanced-fab-replay-report.json"), "w"), indent=1)
    open(os.path.join(d, "m8r-advanced-fab-replay-report.md"), "w").write(md)
    json.dump(router_evidence, open(os.path.join(
        d, "m8r-fab-router-evidence.json"), "w"), indent=1)
    json.dump(blocked, open(os.path.join(
        d, "m8r-fab-blocked-claims.json"), "w"), indent=1)

print("M8R: gates %s | unsupported never allowed: %s" %
      ({k: v["verdict"] for k, v in gates.items()},
       unsupported_never_allowed))
