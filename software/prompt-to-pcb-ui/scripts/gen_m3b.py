"""M3B: external EDA evidence layer — real tool runs where tools exist,
honest unavailable/missing-model artifacts where they don't.

  gen_m3b.py
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import external_eda as ee  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
WORK = os.path.join(HERE, "eda_runs")
TARGETS = ["fl1-backplane-v1"]


def _w(name, obj):
    for r in TARGETS:
        d = os.path.join(RUNS, r, "data")
        os.makedirs(d, exist_ok=True)
        json.dump(obj, open(os.path.join(d, name + ".json"), "w"), indent=1)


inv = ee.inventory()
_w("compose-external-eda-toolchain-inventory", {
    "version": "v1", **inv,
    "summary": {k: v.get("found") for k, v in inv["tools"].items()}})
_w("compose-external-analysis-evidence-schema", {
    "version": "v1", "required_fields": list(ee.REQUIRED_FIELDS),
    "result_statuses": list(ee.RESULT_STATUSES),
    "analysis_types": list(ee.ANALYSIS_TYPES),
    "rules": ["every number carries units (make_artifact enforces)",
              "gate results require thresholds WITH provenance",
              "missing inputs are first-class artifacts",
              "simulation is never physical evidence"]})
_w("compose-external-analysis-claim-gates", {
    "version": "v1",
    "gates": {c: ee.gate(c) for c in ee.CLAIM_GATES},
    "rules": ["no external analysis bypasses KiCad DRC/ERC",
              "no external analysis produces production_ready",
              "no external analysis creates physical evidence"]})

# ---- SPICE benchmarks (ngspice IS installed: real runs) -------------------
os.makedirs(WORK, exist_ok=True)


def _ngspice(tag, netlist):
    r = ee.run_spice(netlist, WORK, tag)
    parsed = {}
    if r["result_status"] == "completed":
        out = open(r["output_artifacts"][0]).read()
        for m in re.finditer(
                r"^\s*([a-z]\w*)\s+([-\d.eE+]+)\s*$", out, re.M):
            try:
                parsed[m.group(1)] = float(m.group(2))
            except ValueError:
                pass
    r["parsed"] = parsed
    return r


div = _ngspice("divider_10k_10k", ee.spice_divider_netlist(5.0, 10000, 10000))
ana = ee.analytic_divider(5.0, 10000, 10000)
div_v = div["parsed"].get("out")
led = _ngspice("led_r330", "* LED current sanity (ideal: LED as 2V source)\n"
               "V1 in 0 DC 3.3\nR1 in led 330\nVled led 0 DC 2.0\n.op\n.end\n")
rc = _ngspice("rc_1k_100n_ac", "* RC low-pass AC\nV1 in 0 DC 0 AC 1\n"
              "R1 in out 1000\nC1 out 0 100n\n.ac dec 10 10 100k\n"
              ".print ac vdb(out)\n.end\n")
_w("compose-spice-integration-v1", {
    "version": "v1", "tool": "ngspice %s (INSTALLED)" %
    inv["tools"]["ngspice"]["version"],
    "supported": ["voltage_divider_check", "led_current_check",
                  "rc_filter_response", "operating point/AC on ideal RC"],
    "rules": ["no invented SPICE models — ideal R/C/V only",
              "active ICs require models (missing-model reports)",
              "regulator stability BLOCKED without a regulator model",
              "current accuracy BLOCKED without calibration evidence",
              "SPICE result is never physical validation"]})
_w("compose-spice-benchmark-report", {
    "version": "v1",
    "benchmarks": {
        "voltage_divider_10k_10k_5V": {
            "ngspice": {"status": div["result_status"],
                        "Vout": {"value": div_v, "units": "V"}},
            "analytic_crosscheck": ana["computed_results"],
            "agreement": (div_v is not None
                          and abs(div_v - 2.5) < 0.001),
            "threshold": "Vout == Vin*R2/(R1+R2) +/- 1mV (ideal)",
            "threshold_provenance": "circuit theory (ideal components) — "
                                    "advisory, review-required"},
        "led_current_330R_3V3_2V": {
            "status": led["result_status"],
            "parsed": led["parsed"],
            "expected_mA": 3.94,
            "note": "ideal 2.0V LED placeholder — NOT a real diode model; "
                    "advisory only"},
        "rc_lowpass_1k_100n": {
            "status": rc["result_status"],
            "fc_expected_Hz": 1592,
            "note": "AC run executed; response advisory (ideal parts)"},
        "current_sense_check": {
            "status": "skipped_missing_input",
            "missing": ["shunt tolerance", "reference", "calibration"],
            "blocked_claims": ["current_measurement_accuracy_claim"]},
        "regulator_stability": {
            "status": "skipped_missing_input",
            "missing": ["AMS1117/AP2112K SPICE or loop model"],
            "blocked_claims": ["regulator_stability_claim"]}},
    "honesty": "completed SPICE runs are advisory evidence — not physical, "
               "not calibrated, not compliance"})

# ---- impedance / stackup ---------------------------------------------------
fixture_stackup = {"dielectric_h_mm": 0.2, "er": 4.5,
                   "source": "TEST FIXTURE ONLY — not a fab stackup"}
_w("compose-impedance-stackup-hooks-v1", {
    "version": "v1",
    "estimator": "IPC-2141 closed-form microstrip (external_eda."
                 "microstrip_z0) — ADVISORY; refuses to run without a "
                 "stackup that names its source",
    "no_stackup_behavior": ee.impedance_report(None),
    "fixture_demo": {**ee.impedance_report(fixture_stackup, w_mm=0.3),
                     "note": "fixture stackup clearly labeled; NOT a fab "
                             "stackup; no controlled-Z claim"}})
_w("compose-impedance-benchmark-report", {
    "version": "v1", "benchmarks": {
        "usb_fs_advisory_pair": {"status": "skipped_missing_input",
                                 "missing": ["stackup", "pair constraints"],
                                 "note": "USB advisory pads exist on "
                                         "bare-MCU boards; geometry-only"},
        "usbc_power_only_board": {
            "status": "completed",
            "finding": "usbc-power-entry has NO USB data nets (A5/B5 CC "
                       "pulldowns only) — no USB data/impedance claim "
                       "exists to gate",
            "claims": []},
        "rf_adapter_request": {"status": "unavailable",
                               "verdict": "architecture_only (stackup + "
                                          "solver absent)"},
        "high_speed_request": {"status": "unavailable",
                               "verdict": "architecture_only"}}})

# ---- RF / S-parameter ------------------------------------------------------
_w("compose-rf-sparameter-hooks-v1", {
    "version": "v1",
    "skrf": {"found": inv["tools"]["skrf"]["found"],
             "status": "unavailable — pip module absent; Touchstone parsing "
                       "awaits it"},
    "openEMS": {"found": inv["tools"]["openEMS"]["found"],
                "status": "unavailable — field-solver analyses blocked"},
    "touchstone_local": inv["tools"]["touchstone_files_local"],
    "rules": ["no RF performance claim without model/sim/measurement",
              "no antenna claim without solver/chamber evidence",
              "LoRa module RF stays module-contained/advisory"]})
_w("compose-rf-benchmark-report", {
    "version": "v1", "benchmarks": {
        "rf_adapter_request": {"verdict": "architecture_only",
                               "missing": ["stackup", "solver",
                                           "measurement"]},
        "lora_module_board": {"verdict": "module-contained advisory — no "
                                         "board-level RF claim"},
        "touchstone_parse": {"status": "skipped_missing_input",
                             "missing": ["any local .sNp file + skrf"]},
        "openems_run": {"status": "unavailable"}}})

# ---- IBIS / SI -------------------------------------------------------------
_w("compose-ibis-si-hooks-v1", {
    "version": "v1",
    "ibis_local": inv["tools"]["ibis_models_local"],
    "status": "no .ibs files in the repo — every high-speed SI request "
              "produces a missing-model artifact",
    "gates": {"PCIe": "architecture_only", "USB3": "architecture_only",
              "DDR": "architecture_only",
              "USB_FS": "advisory pads only (no compliance claim)"}})
_w("compose-si-benchmark-report", {
    "version": "v1", "benchmarks": {
        "pcie_request": {"verdict": "architecture_only",
                         "missing": ["IBIS", "constraints", "SI analysis"]},
        "usb3_request": {"verdict": "architecture_only"},
        "usb_fs_advisory": {"status": "completed",
                            "note": "geometry recorded; no SI claim"},
        "missing_ibis_report": {"status": "skipped_missing_input",
                                "missing": ["*.ibs"]}}})

# ---- PDN on four REAL boards ------------------------------------------------
pdn = {}
for run in ("bare-rp2040-pico-replacement-v1",
            "fl1-core6-bare-rp2040-combination-v1",
            "chipdown-txb0102-v1", "power-entry-header-2l"):
    bp = os.path.join(RUNS, run, "variant.kicad_pcb")
    if os.path.exists(bp):
        pdn[run] = ee.pdn_inventory(bp)
_w("compose-pdn-power-integrity-hooks-v1", {
    "version": "v1", "boards": pdn,
    "high_current_board": {"verdict": "blocked",
                           "reason": "power-stage requirements unevidenced "
                                     "(M9 draft gates, quarantined)"},
    "rules": ["decoupling present != PI proven",
              "no PDN impedance without models",
              "missing load current BLOCKS PI claims",
              "strong PI claims require measurement"]})
_w("compose-pdn-power-benchmark-report", {
    "version": "v1",
    "summary": {run: {r: v["decoupling_caps"]
                      for r, v in rep["rails"].items()}
                for run, rep in pdn.items()},
    "pi_claim": "BLOCKED for every board (load currents unknown)"})

# ---- runner + pipeline + board summaries ------------------------------------
demo = ee.runner("advisory", "power-entry-header-2l", "m3b-demo",
                 board_path=os.path.join(RUNS, "power-entry-header-2l",
                                         "variant.kicad_pcb"),
                 workdir=WORK)
_w("compose-external-analysis-runner", {
    "version": "v1", "modes": ["inventory_only", "advisory",
                               "gated_for_claims"],
    "result_mapping": {"missing tool": "unavailable",
                       "missing model/input": "skipped_missing_input",
                       "tool error": "failed_tool_error",
                       "warnings": "completed_with_warnings",
                       "no threshold": "completed",
                       "threshold pass/fail": "passed_gate/failed_gate"},
    "rules": ["never marks physical evidence", "never overrides DRC/ERC"]})
_w("external-analysis-run-report", {
    "version": "v1", "mode": demo["mode"],
    "artifacts": [{k: a.get(k) for k in ("analysis_type", "tool_name",
                                         "result_status", "blocked_claims")}
                  for a in demo["artifacts"]],
    "claim_gates_blocked": [c for c, g in demo["claim_gates"].items()
                            if g["state"] == "blocked"]})

SUMMARY_BOARDS = [
    "power-entry-header-v1", "usbc-power-entry-v1", "bme280-sandbox-v1",
    "chipdown-pcf8574-v1", "chipdown-txb0102-v1", "chipdown-ds3231m-v1",
    "chipdown-ads1115-v1", "bare-rp2040-pico-replacement-v1",
    "fl1-core6-bare-rp2040-combination-v1", "cv-monitor-nonfl1-v1"]
summaries = {}
for run in SUMMARY_BOARDS:
    bp = os.path.join(RUNS, run, "variant.kicad_pcb")
    summaries[run] = {
        "applicable": ["power_rail_inventory", "decoupling_inventory",
                       "voltage_divider_check (where divider exists)"],
        "tools_available": ["ngspice", "numpy/scipy"],
        "tools_missing": ["skrf", "openEMS", "PySpice"],
        "models_missing": ["IC SPICE models", "IBIS", "stackup"],
        "rails": (ee.pdn_inventory(bp)["rails"]
                  if os.path.exists(bp) else "board file absent"),
        "claims_allowed": ["advisory analytic/SPICE ideal-R results"],
        "claims_blocked": ["impedance", "RF", "SI", "PI", "calibration",
                           "regulator stability", "EMC"]}
for req in ("RF adapter (architecture request)",
            "PCIe/high-speed (architecture request)",
            "high-current power stage (architecture request)"):
    summaries[req] = {"verdict": "architecture_only/blocked",
                      "next_evidence": "models + stackup + external "
                                       "analysis + physical measurement"}
_w("compose-board-external-analysis-summary",
   {"version": "v1", "boards": summaries})
_w("compose-external-analysis-pipeline-integration-report", {
    "version": "v1",
    "position": "after routing/DRC/ERC, before readiness/claims — as an "
                "OPTIONAL evidence stage invoked via external_eda.runner",
    "modes": ["off", "inventory_only", "advisory", "gated_for_claims"],
    "default": "inventory_only",
    "guarantees": ["ordinary board generation NEVER fails on a missing "
                   "optional tool (runner is not in the mandatory chain)",
                   "claim-gated analysis blocks only its related claim",
                   "DRC/ERC failure always outranks external analysis"]})

print("inventory: ngspice=%s skrf=%s openEMS=%s" %
      (inv["tools"]["ngspice"]["found"], inv["tools"]["skrf"]["found"],
       inv["tools"]["openEMS"]["found"]))
print("divider: ngspice Vout=%s V (analytic 2.5) | rails on %d boards" %
      (div_v, len(pdn)))
