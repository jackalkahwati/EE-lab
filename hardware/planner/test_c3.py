"""C3 regression: SPI/UART/CAN/RS485 bus engines."""
import json
import os
import subprocess
import sys

import bus_engines as be

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public",
                 "runs", "fl1-backplane-v1", "data")
bench = json.load(open(os.path.join(D, "bus-engine-benchmark-report.json")))
B = bench["benchmarks"]

check("1 SPI: CS per device, QSPI nets follow the proven flash pattern",
      B["spi_two_devices"]["chip_selects"]["adc"] == "SPI_CS_adc"
      and "QSPI_SD3" in B["spi_flash_qspi"]["required_nets"])
check("2 SPI: series resistors not added without evidence (recorded)",
      "not_added" in B["spi_74hc595"]["series_resistors"])
check("3 UART: crossover explicit at contract level; debug header role set",
      "crossover" in B["uart_debug_header"]
      and B["uart_debug_header"]["connector_role"] == "debug_header")
check("4 UART domain mismatch -> level shifter REQUIRED (3V3 vs 5V)",
      B["uart_level_shift"]["voltage_domain"]["state"]
      == "level_shifter_required"
      and any("level shifter" in r for r in
              B["uart_level_shift"]["review_required"]))
check("5 unknown voltage domain -> blocked, never guessed",
      B["wrong_voltage_domain"]["voltage_domain"]["state"] == "blocked"
      and B["wrong_voltage_domain"]["state"] == "blocked")
check("6 CAN endpoint termination only via named policy",
      B["can_endpoint_policy"]["termination"]["state"]
      == "policy_set_review_required"
      and "policy:" in B["can_endpoint_policy"]["termination"]["source"])
check("7 CAN mid-bus: NOT terminated automatically",
      B["can_mid_bus"]["termination"]["state"] == "not_terminated"
      and "never automatic" in B["can_mid_bus"]["termination"]["note"])
check("8 CAN: transceiver-between placement + no ISO compliance claim",
      "between MCU side" in B["can_endpoint_policy"]["transceiver"]["placement"]
      and "ISO_11898_compliance" in B["can_endpoint_policy"]["blocked_claims"])
check("9 RS485: DE/RE + A/B nets, half duplex classified",
      "RS485_DE_RE" in B["rs485_half_duplex"]["required_nets"]
      and B["rs485_half_duplex"]["duplex"] == "half")
check("10 missing termination/bias evidence recorded, not faked",
      B["missing_termination_evidence"]["termination"]["state"]
      == "recorded_absent_review_required"
      and "NOT faked" in B["missing_termination_evidence"]["termination"]["note"])
check("11 mixed-bus boards compose contracts; i2c unchanged",
      "spi" in B["mixed_i2c_spi"] and "i2c" in B["mixed_uart_i2c"])
check("12 every engine blocks protocol/timing/SI/EMC/compliance claims",
      all(set(be.COMMON_BLOCKED) <= set(B[k]["blocked_claims"])
          for k in ("spi_flash_qspi", "uart_debug_header",
                    "can_mid_bus", "rs485_half_duplex")))
check("13 unsupported bus type refused (i2c points to shared_bus)",
      "unsupported" in be.make_bus("i2c")["error"])

# existing I2C machinery stays green
r = subprocess.run([sys.executable,
                    os.path.join(HERE, "test_shared_bus.py")],
                   capture_output=True, text=True)
check("14 shared-bus (I2C) regression remains green", r.returncode == 0,
      (r.stdout or "").strip().splitlines()[-1] if r.stdout else "")

npass = sum(1 for ok in checks if ok)
print("%d/%d C3 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
