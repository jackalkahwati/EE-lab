"""C1: role-aware placement engine — benchmark run over REAL boards plus
clearly-labeled synthetic fixtures for roles with no real board yet."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import role_placement as rp  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")

REAL = [
    ("bare_rp2040", "fl1-core6-bare-rp2040-combination-v1",
     "crystal/flash/decoupling proximity on the bare-RP2040 board"),
    ("ads1115", "chipdown-ads1115-v1",
     "analog/reference separation on the ADS1115 chip-down board"),
    ("txb0102", "chipdown-txb0102-v1",
     "level shifter between voltage domains"),
    ("usbc_power_only", "usbc-power-entry-v1",
     "USB connector edge intent (power-only board)"),
    ("rf_module_lora", "run-demo-loranode-1783227819",
     "RF module containment on the LoRa node"),
]

# synthetic fixtures — roles with no real board yet; POSITIONS ARE SYNTHETIC
SYNTH = {
    "can_fixture": [
        {"ref": "U1", "value": "RP2040", "x": 10, "y": 10, "role": "mcu"},
        {"ref": "U2", "value": "TJA1051", "x": 25, "y": 10,
         "role": "can_transceiver"},
        {"ref": "J1", "value": "CAN header", "x": 40, "y": 10,
         "role": "uart_header"},
    ],
    "rs485_fixture": [
        {"ref": "U1", "value": "RP2040", "x": 10, "y": 10, "role": "mcu"},
        {"ref": "U2", "value": "MAX485", "x": 24, "y": 11,
         "role": "rs485_transceiver"},
        {"ref": "J1", "value": "terminal", "x": 40, "y": 10,
         "role": "uart_header"},
    ],
    "buck_fixture": [
        {"ref": "U1", "value": "TPS5430 buck", "x": 20, "y": 20,
         "role": "buck_regulator"},
        {"ref": "L1", "value": "22uH", "x": 24, "y": 20, "role": "inductor"},
        {"ref": "C1", "value": "22uF bulk", "x": 26, "y": 22,
         "role": "bulk_cap"},
        {"ref": "U2", "value": "ADS1115", "x": 28, "y": 24, "role": "adc"},
    ],
}

results = {}
for name, run_dir, purpose in REAL:
    bp = os.path.join(RUNS, run_dir, "variant.kicad_pcb")
    if not os.path.exists(bp):
        results[name] = {"state": "board_missing", "run_dir": run_dir}
        continue
    rep = rp.placement_report(bp)
    results[name] = {"source": "REAL board", "run_dir": run_dir,
                     "purpose": purpose, "report": rep}

for name, comps in SYNTH.items():
    xs = [c["x"] for c in comps]
    ys = [c["y"] for c in comps]
    board = {"components": comps,
             "extent": {"min_x": min(xs), "max_x": max(xs),
                        "min_y": min(ys), "max_y": max(ys)}}
    results[name] = {"source": "SYNTHETIC fixture (positions invented for "
                               "rule exercise only)",
                     "report": {"evaluation": rp.evaluate(board)}}

summary = {}
for name, r in results.items():
    ev = r.get("report", {}).get("evaluation")
    summary[name] = ({"risk": ev["risk_score"],
                      "applicable": ev["applicable_rules"],
                      "violations": ev["violations"]} if ev else r)

engine = {
    "version": "v1", "milestone": "C1 Role-Aware Placement Engine",
    "roles": list(rp.ROLES), "rules": [
        {"rule": rid, "role": role, "params": params, "why": why}
        for rid, role, params, why in rp.RULES],
    "noisy_roles": sorted(rp.NOISY_ROLES),
    "sensitive_roles": sorted(rp.SENSITIVE_ROLES),
    "integration": "findings feed the existing placement repair loop as "
                   "explicit, reviewable violations; roles/hints are "
                   "available to compose at placement time",
    "honesty": "v1 EVALUATES rules against real board positions and "
               "reports violations — it does not claim the current placer "
               "satisfies them, and several real boards show honest "
               "violations (crystal/flash distance on the bare-RP2040 "
               "board). No physical or advanced-fab claim is added.",
    "benchmarks": summary,
}

md = "# C1 — Role-Aware Placement Engine v1\n\n" \
     "33 roles, %d rules, support-circuit grouping, risk scoring.\n\n" \
     "## Benchmarks\n%s\n\n" \
     "Honest findings: the CURRENT placer is not role-aware; real boards " \
     "show violations (recorded, fed to the repair loop as work).\n" % (
         len(rp.RULES),
         "\n".join("- %s: %s" % (k, json.dumps(v)) for k, v in
                   summary.items()))

for r in ["fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1"]:
    d = os.path.join(RUNS, r, "data")
    json.dump(engine, open(os.path.join(
        d, "role-aware-placement-engine-v1.json"), "w"), indent=1)
    open(os.path.join(d, "role-aware-placement-engine-v1.md"), "w").write(md)
    json.dump({"benchmarks": results},
              open(os.path.join(
                  d, "role-aware-placement-benchmark-report.json"), "w"),
              indent=1)
    open(os.path.join(d, "role-aware-placement-benchmark-report.md"),
         "w").write(md)

print("C1:", json.dumps(summary))
