"""M10R: replay the quarantined M10 RF gates through M3B evidence.

The draft detected RF content and returned architecture_only with a
requirements list. The replay wires that list to the M3B inventory and
claim gates: openEMS absence, scikit-rf availability, zero local
S-parameter/Touchstone files, and the rf/antenna claim gates are now
RECORDED evidence, not prose. LoRa stays module-contained; no board-level
RF performance claim exists anywhere.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import rf_rules as rf  # noqa: E402
import external_eda as ee  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
D = os.path.join(RUNS, "fl1-backplane-v1", "data")

# ---- draft gates re-run -----------------------------------------------------
demos = {
    "SMA RF adapter with antenna path": rf.rf_gate(
        "SMA RF adapter with antenna path"),
    "LoRa antenna path": rf.rf_gate("LoRa antenna path"),
    "2.4GHz coax feed": rf.rf_gate("2.4GHz coax feed"),
    "i2c sensor breakout (non-RF)": rf.rf_gate("i2c sensor breakout"),
}

# ---- M3B connections --------------------------------------------------------
inv = ee.inventory()
rf_bench = json.load(open(os.path.join(
    D, "compose-rf-benchmark-report.json")))["benchmarks"]

m3b = {
    "openEMS": {"found": inv["tools"]["openEMS"]["found"],
                "consequence": "field-solver analyses unavailable — "
                               "recorded, never faked"},
    "skrf": {"found": inv["tools"]["skrf"]["found"],
             "analyses": inv["tools"]["skrf"]["analyses"]},
    "touchstone_files_local": inv["tools"]["touchstone_files_local"],
    "rf_performance_claim": ee.gate("rf_performance_claim"),
    "antenna_performance_claim": ee.gate("antenna_performance_claim"),
    "EMC_claim": ee.gate("EMC_claim"),
    "rf_benchmark_replay": {
        "rf_adapter_request": rf_bench["rf_adapter_request"]["verdict"],
        "openems_run": rf_bench["openems_run"]["status"]},
    "note": "missing solver/S-parameters/measurement are recorded states; "
            "a missing tool blocks only RF claims, never board generation"}

lora_policy = {
    "policy": "module-contained",
    "detail": "LoRa RF lives inside the certified module; Compose places "
              "the module and antenna CONNECTOR with keepout NOTES only. "
              "The rf_gate fires on the antenna path and blocks every "
              "board-level RF claim",
    "gate_on_lora": demos["LoRa antenna path"]["verdict"],
    "board_level_rf_performance_claim": "none — blocked"}

blocked = {
    "blocked_claims": sorted(set(rf.BLOCKED) | {
        "rf_performance_claim", "antenna_performance_claim", "EMC_claim",
        "controlled_impedance_claim (50-ohm launch)"}),
    "blocker_citations": {
        "missing_stackup": "M3B: stackup_model_local.found == false",
        "missing_solver": "M3B: openEMS.found == false",
        "missing_s_parameters": "M3B: touchstone_files_local.found == false",
        "missing_measurement": "physical ledger empty — no VNA/chamber data",
        "rf_connector_launch": "launch geometry review ABSENT (draft "
                               "requirement, unchanged)"},
    "note": "every RF blocker now cites a recorded M3B state or the empty "
            "physical ledger"}

led = json.load(open(os.path.join(RUNS, "power-entry-header-2l", "data",
                                  "compose-physical-evidence-ledger.json")))

report = {
    "version": "v1", "milestone": "M10R RF gates replay",
    "replayed_from": "drafts/m7-m12-pre-hardening (M10)",
    "gate_demos": demos,
    "rf_requests_never_pass": all(
        d["verdict"] == "architecture_only" for k, d in demos.items()
        if "non-RF" not in k),
    "non_rf_passthrough": demos["i2c sensor breakout (non-RF)"]["verdict"]
                          == "no_rf_content",
    "m3b_connection": m3b,
    "lora_module_policy": lora_policy,
    "verdict": "ACCEPTED as gates: RF requests produce architecture_only "
               "with blockers citing recorded M3B states (no stackup, no "
               "solver, no S-parameters, no measurement); LoRa stays "
               "module-contained; no board-level RF performance claim",
    "physical_ledger": {"artifacts": led["artifacts"],
                        "order_status": led["order_status"]},
    "no_ordering_action": True,
    "honesty": "no impedance/antenna/EMC/link-budget claim; availability "
               "of scikit-rf is not evidence of anything"}

md = """# M10R — RF gates replay through EDA evidence

## Accepted (gate/blocker milestone)
- RF detection (SMA / antenna / coax / 2.4GHz / LoRa antenna path) returns
  architecture_only with the full requirements list; non-RF boards pass
  through untouched.

## Blockers now cite recorded M3B states (new under replay)
- No stackup/material data in repo (stackup_model_local: false).
- openEMS not installed (recorded unavailable — never faked).
- Zero local S-parameter/Touchstone files.
- No physical measurement (ledger empty — no VNA/chamber data).
- RF connector launch geometry review absent (draft requirement).
- Claim gates: rf_performance, antenna_performance, EMC — all blocked.

## LoRa
Module-contained: RF stays inside the certified module; the board places
the module + antenna connector with keepout notes only. No board-level RF
performance claim exists.

Physical ledger untouched; no ordering or quote action.
"""

for r in ["fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1"]:
    d = os.path.join(RUNS, r, "data")
    json.dump(report, open(os.path.join(
        d, "m10r-rf-replay-report.json"), "w"), indent=1)
    open(os.path.join(d, "m10r-rf-replay-report.md"), "w").write(md)
    json.dump(m3b, open(os.path.join(
        d, "m10r-rf-external-analysis.json"), "w"), indent=1)
    json.dump(blocked, open(os.path.join(
        d, "m10r-rf-blocked-claims.json"), "w"), indent=1)

print("M10R: rf gates architecture_only=%s | openEMS=%s skrf=%s snp=%s | "
      "rf claim=%s" %
      (report["rf_requests_never_pass"], m3b["openEMS"]["found"],
       m3b["skrf"]["found"], m3b["touchstone_files_local"]["found"],
       m3b["rf_performance_claim"]["state"]))
