"""C3: bus engine benchmarks — 12 cases across SPI/UART/CAN/RS485."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import bus_engines as be  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")

B = {}
B["spi_flash_qspi"] = be.spi_bus("b1", {"part": "RP2040"},
    [{"name": "flash", "part": "W25Q16"}], "3V3", "3V3", qspi=True)
B["spi_74hc595"] = be.spi_bus("b2", {"part": "RP2040"},
    [{"name": "sr0", "part": "74HC595"}], "3V3", "3V3")
B["spi_two_devices"] = be.spi_bus("b3", {"part": "RP2040"},
    [{"name": "adc", "part": "MCP3008"}, {"name": "sr", "part": "74HC595"}],
    "3V3", "3V3")
B["uart_debug_header"] = be.uart_bus("b4", {"part": "RP2040"},
    {"part": "header"}, "3V3", "3V3", debug_header=True)
B["uart_level_shift"] = be.uart_bus("b5", {"part": "RP2040"},
    {"part": "5V peripheral"}, "3V3", "5V")
B["can_endpoint_policy"] = be.can_bus("b6", {"part": "RP2040"}, "3V3",
    endpoint=True, termination_policy="lab-bench endpoint policy v1")
B["can_mid_bus"] = be.can_bus("b7", {"part": "RP2040"}, "3V3",
    endpoint=False)
B["rs485_half_duplex"] = be.rs485_bus("b8", {"part": "RP2040"}, "3V3",
    duplex="half")
B["mixed_i2c_spi"] = {"i2c": "shared_bus.py contract (unchanged)",
    "spi": be.spi_bus("b9", {"part": "RP2040"},
                      [{"name": "sr", "part": "74HC595"}], "3V3", "3V3"),
    "note": "mixed-bus boards compose contracts; each bus keeps its gates"}
B["mixed_uart_i2c"] = {"i2c": "shared_bus.py contract (unchanged)",
    "uart": be.uart_bus("b10", {"part": "RP2040"}, {"part": "header"},
                        "3V3", "3V3")}
B["wrong_voltage_domain"] = be.uart_bus("b11", {"part": "RP2040"},
    {"part": "mystery"}, "3V3", None)
B["missing_termination_evidence"] = be.rs485_bus("b12", {"part": "RP2040"},
    "3V3", duplex="half")

summary = {}
for k, v in B.items():
    if "bus_type" in v:
        summary[k] = {"state": v["state"],
                      "domain": v["voltage_domain"]["state"],
                      "termination": (v.get("termination") or {}).get("state")}
    else:
        summary[k] = {"state": "composed", "parts": list(v.keys())}

report = {
    "version": "v1", "milestone": "C3 SPI/UART/CAN/RS485 Bus Engines",
    "contract_fields": list(be.BUS_CONTRACT_FIELDS),
    "engines": ["spi (CS allocation, QSPI awareness)",
                "uart (crossover at contract level, flow control, debug "
                "header)",
                "can (transceiver-between rule, endpoint-policy "
                "termination, common ground)",
                "rs485 (DE/RE, A/B, half/full duplex, termination+bias "
                "evidence-gated)"],
    "rules": [
        "voltage domains: match ok; mismatch -> level shifter REQUIRED; "
        "unknown -> blocked, never guessed",
        "termination/bias values require datasheet evidence (C2) or an "
        "explicit named policy — absent evidence is recorded "
        "review-required, not defaulted",
        "CAN termination only when role is endpoint AND policy allows — "
        "never automatic",
        "no protocol/compliance/timing/SI/EMC claim from any engine",
        "i2c behavior unchanged (shared_bus.py untouched)",
    ],
    "benchmarks": summary,
}

md = "# C3 — SPI/UART/CAN/RS485 Bus Engines v1\n\n" + \
     "\n".join("- " + r for r in report["rules"]) + \
     "\n\n## Benchmarks (12)\n" + \
     "\n".join("- %s: %s" % (k, json.dumps(v)) for k, v in summary.items()) \
     + "\n"

for r in ["fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1"]:
    d = os.path.join(RUNS, r, "data")
    json.dump(report, open(os.path.join(
        d, "spi-uart-can-rs485-bus-engines-v1.json"), "w"), indent=1)
    open(os.path.join(d, "spi-uart-can-rs485-bus-engines-v1.md"),
         "w").write(md)
    json.dump({"benchmarks": B}, open(os.path.join(
        d, "bus-engine-benchmark-report.json"), "w"), indent=1)
    open(os.path.join(d, "bus-engine-benchmark-report.md"), "w").write(md)

print("C3:", json.dumps(summary)[:400])
