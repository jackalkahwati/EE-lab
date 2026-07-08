"""C6: module library benchmarks — 10 module boards."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import module_library as ml  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")

BOARDS = {
    "mcu_lora_sensor_telemetry": ["lora", "imu", "board_id_eeprom"],
    "mcu_gnss_eeprom": ["gnss", "board_id_eeprom"],
    "mcu_cellular_power_monitor": ["cellular", "adc_module"],
    "mcu_imu_lora_tracker": ["imu", "lora", "gnss"],
    "mcu_isolated_can": ["isolated_can", "debug_module"],
    "mcu_rs485": ["rs485_block", "debug_module"],
    "relay_control": ["relay_module", "board_id_eeprom"],
    "adc_module_board": ["adc_module", "debug_module"],
    "power_module_board": ["power_module"],
    "motor_driver_low_risk": ["motor_driver_low", "debug_module"],
}
B = {k: ml.compose_module_board(v) for k, v in BOARDS.items()}
B["unknown_module_blocked"] = ml.compose_module_board(["quantum_flux"])

summary = {k: {"state": v["state"],
               "blocked": len(v.get("blocked_claims", []))}
           for k, v in B.items()}

report = {
    "version": "v1", "milestone": "C6 Enterprise Module Library",
    "modules": {k: {"state": m["footprint_source_state"],
                    "blocked_claims": m["blocked_claims"]}
                for k, m in ml.MODULES.items()},
    "proven": [k for k, m in ml.MODULES.items()
               if "PROVEN" in m["footprint_source_state"]],
    "candidates": [k for k, m in ml.MODULES.items()
                   if "candidate" in m["footprint_source_state"]],
    "rules": [
        "RF stays module-contained: connectors + keepouts, no board-level "
        "RF performance/regulatory claim",
        "GNSS fix is a SKY test; cellular registration is a NETWORK test — "
        "never bench claims",
        "motor driver modules are LOW-RISK class only; high-current stages "
        "stay blocked (M9R)",
        "candidate footprints make the whole board review-required",
        "unknown modules block — nothing substituted silently",
    ],
    "benchmarks": summary,
}

md = "# C6 — Enterprise Module Library v1\n\n%d modules (%d proven on real " \
     "boards, %d candidates).\n\n%s\n\n## Benchmarks\n%s\n" % (
         len(ml.MODULES), len(report["proven"]), len(report["candidates"]),
         "\n".join("- " + r for r in report["rules"]),
         "\n".join("- %s: %s" % (k, json.dumps(v))
                   for k, v in summary.items()))

for r in ["fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1"]:
    d = os.path.join(RUNS, r, "data")
    json.dump(report, open(os.path.join(
        d, "enterprise-module-library-v1.json"), "w"), indent=1)
    open(os.path.join(d, "enterprise-module-library-v1.md"), "w").write(md)
    json.dump({"benchmarks": B}, open(os.path.join(
        d, "module-library-benchmark-report.json"), "w"), indent=1)
    open(os.path.join(d, "module-library-benchmark-report.md"),
         "w").write(md)

print("C6: %d modules | %s" % (len(ml.MODULES), json.dumps(summary)[:300]))
