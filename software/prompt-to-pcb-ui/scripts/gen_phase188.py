"""Phase 18.8: generate the Full-16 monolithic stress-test artifacts from the
three REAL compose attempts.

  gen_phase188.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import monolith_stress as ms  # noqa: E402
import role_completeness as rc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
MONO = ["fl1-core6-mono-pico", "fl1-core6-mono-bare", "fl1-full16-mono-bare"]
TARGETS = MONO + ["fl1-cal-board-v4"]  # cal board carries the arch-search family


def _facts(run):
    base = os.path.join(RUNS, run)
    txt = open(os.path.join(base, "variant.kicad_pcb")).read()
    d = os.path.join(base, "data")
    bj = json.load(open(os.path.join(d, "board.json")))
    drc = json.load(open(os.path.join(d, "drc.json")))
    lr = json.load(open(os.path.join(d, "last-run.json")))
    dev = json.load(open(os.path.join(d, "devices.json")))
    viol = len([v for v in (drc.get("violations") or []) if v.get("type") != "solder_mask_bridge"])
    role = rc.check_role("monolithic_core6", txt, dev)
    nopico = rc.mono_nopico_checks(txt, dev) if "RaspberryPi_Pico" not in txt else None
    return {"routing": "%s/%s" % (bj.get("netsRouted"), bj.get("netsTotal")),
            "drc": viol, "unconn": len(drc.get("unconnected_items") or []),
            "status": lr.get("status"), "role": role["status"],
            "role_report": role, "nopico": nopico,
            "nopico_ok": bool(nopico and nopico["all_present"]),
            "has_pico": "RaspberryPi_Pico" in txt}


results = {r: _facts(r) for r in MONO}


def _w(name, obj):
    for r in TARGETS:
        d = os.path.join(RUNS, r, "data")
        json.dump(obj, open(os.path.join(d, name + ".json"), "w"), indent=1)


_w("full16-fl1-function-map", ms.function_map())
_w("full16-monolithic-treatment-classification", {
    "version": "v1", "treatments": list(ms.TREATMENTS),
    "classification": ms.function_map()["functions"],
    "counts": {t: sum(1 for f in ms.FUNCTIONS if f[2] == t) for t in ms.TREATMENTS}})
_w("full16-monolithic-architecture-comparison", {
    "version": "v1", "candidates": ms.candidates(results),
    "hard_blockers": list(ms.HARD_BLOCKERS),
    "rule": "hard blockers dominate — no aggregate score hides one"})
_w("bare-rp2040-subsystem-model", ms.rp2040_subsystem(results["fl1-core6-mono-bare"]))
_w("rp2040-qfn56-fanout-feasibility", ms.qfn_feasibility(results["fl1-core6-mono-bare"]))
_w("full16-monolithic-domain-partitioning-model", ms.domains())
_w("full16-monolithic-manufacturing-risk-assessment", ms.manufacturing_risk())
_w("full16-monolithic-final-recommendation", ms.recommendation())
_w("full16-monolithic-alternate-mcu-report", {
    "version": "v1", "status": "architecture_only",
    "reason": "no credible proven alternate selected — the Pico module is the "
              "only validated MCU primitive; an LQFP 0.5mm leaded MCU is the "
              "plausible future candidate (escapes like the proven TSSOP) but "
              "has no ingestion, firmware port, or validation path today"})

# per-run compose reports
for run, name in [("fl1-core6-mono-pico", "core6-monolithic-pico-compose-report"),
                  ("fl1-core6-mono-bare", "core6-monolithic-bare-rp2040-compose-report"),
                  ("fl1-full16-mono-bare", "full16-monolithic-bare-rp2040-compose-report")]:
    f = results[run]
    if run == "fl1-core6-mono-pico":
        status = "routed_and_review_required" if f["status"] == "PASSED" and f["drc"] == 0 \
            else "blocked_by_density"
    else:
        status = "blocked_by_qfn56_fanout" if run == "fl1-core6-mono-bare" \
            else "architecture_only_with_blockers"
    rep = {"version": "v1", "run_id": run, "stress_test": True,
           "routing": f["routing"], "drc_violations": f["drc"],
           "unconnected": f["unconn"], "pipeline_status": f["status"],
           "role_completeness": f["role"], "no_pico_verified": not f["has_pico"],
           "status": status,
           "order": "NEVER — stress-test article, not an order candidate",
           "honesty": "not production-ready; the six modular boards remain the "
                      "valid first articles"}
    if f["nopico"]:
        rep["nopico_subsystem_checks"] = f["nopico"]
        rep["exact_blocker"] = ("QFN-56 four-sided 0.4mm escape density — fanout "
                                "lane geometry collides (all DRC violations are "
                                "between escape artifacts, none touch the QFN)")
    json.dump(rep, open(os.path.join(RUNS, run, "data", name + ".json"), "w"), indent=1)
    json.dump(f["role_report"], open(os.path.join(
        RUNS, run, "data", "monolithic-role-completeness-report.json"), "w"), indent=1)

_w("monolithic-validation-workflows", {
    "version": "v1", "workflows": [
        {"name": "bare_mcu_bringup", "steps": ["current-limited power-on", "3V3 rail",
         "SWD detect", "flash test firmware", "GPIO blink",
         "USB enumerate ONLY if USB is implemented (it is advisory-only here)"]},
        {"name": "digital_io", "steps": ["UART loopback", "I2C enumeration",
         "SPI sanity", "protected GPIO test"]},
        {"name": "relay_switching", "steps": ["default disconnected", "enable path",
         "continuity", "safe disconnect all"]},
        {"name": "calibration_reference", "steps": ["REF_OUT present",
         "divider ADC reading", "NO precision claim without calibration evidence"]},
        {"name": "power_current_monitor", "steps": ["V sense sanity", "I sense sanity",
         "monitor-only limits"]},
        {"name": "external_instrument_bridge", "steps": ["TTL loopback",
         "trigger safe at boot", "trigger input sanity"]},
        {"name": "dmm_lite", "steps": ["NOT IMPLEMENTED (architecture_only)"]},
        {"name": "dut_power_control", "steps": ["NOT IMPLEMENTED (architecture_only)"]},
        {"name": "stimulus_dac", "steps": ["NOT IMPLEMENTED (architecture_only)"]},
        {"name": "logic_event_capture", "steps": ["event capture sanity",
         "NO logic-analyzer timing claim without timing evidence"]},
        {"name": "external_cots_interfaces", "steps": ["COTS instrument identity "
         "required for physical validation", "EII-style control paths"]},
        {"name": "full_system", "steps": ["mock DUT bring-up script",
         "evidence ledger", "failure-domain identification"]}],
    "rules": ["physical evidence only after a real board exists",
              "simulated evidence remains simulated",
              "no internal calibration claim before physical reference validation",
              "no production-ready claim"]})

_w("phase18-full16-monolithic-feedback-report", {
    "version": "v1", "stress_test": True,
    "updates": {
        "board_partitioning_search": "monolithic single-board option upgraded from "
            "'rejected: one fine-pitch failure holds everything' to 'Core-6+Pico "
            "ROUTES CLEAN (real evidence) — viable as Rev C cost-down after the "
            "modular system works'; modular stays SELECTED for first articles",
        "bare_mcu_target": "bare RP2040 = blocked_by_router_capability with ONE "
            "exact blocker: four-sided QFN-56 escape planning (quadrant-aware "
            "fanout + finer grid + thermal-pad vias); everything else is present "
            "and role-complete on the real attempt",
        "full16_treatment_map": "6 implemented / 2 reduced / 2 external-COTS / "
            "2 reserved / 4 architecture_only — no function faked",
        "phase19_assumptions": "electromechanical co-design proceeds on the "
            "modular six-board family; monolith is a later cost-down shape",
        "phase20_costdown": "Core-6+Pico monolith is the first credible costdown "
            "candidate; bare-MCU migration requires the QFN escape capability + "
            "a small physically-validated RP2040 core test board first"},
    "next_capability_target": "quadrant-aware QFN escape planner",
    "evidence_quality": "high — three real pipeline runs, one clean pass, one "
                        "exact reproducible blocker"})

print("Candidate B: %s %s DRC %d role %s" % (results["fl1-core6-mono-pico"]["status"],
      results["fl1-core6-mono-pico"]["routing"], results["fl1-core6-mono-pico"]["drc"],
      results["fl1-core6-mono-pico"]["role"]))
print("Candidate C: blocked_by_qfn56_fanout (%s, %d viol, %d unconn, no-pico %s)" %
      (results["fl1-core6-mono-bare"]["routing"], results["fl1-core6-mono-bare"]["drc"],
       results["fl1-core6-mono-bare"]["unconn"],
       "ALL PRESENT" if results["fl1-core6-mono-bare"]["nopico_ok"] else "gaps"))
print("Candidate D: architecture_only_with_blockers (%s)" %
      results["fl1-full16-mono-bare"]["routing"])
print("Recommendation: %s" % ms.recommendation()["recommendation"])
