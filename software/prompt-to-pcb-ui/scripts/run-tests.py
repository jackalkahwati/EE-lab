"""Pipeline test suite — run a battery of diverse board specs through the live
/api/pipeline/run endpoint and summarize pass/fail + the issue per case.

  python3 scripts/run-tests.py            # run all
  python3 scripts/run-tests.py <name>     # run one
Runs are sequential (the pipeline holds a global lock).
"""
import base64
import json
import sys
import urllib.request

BASE = "http://localhost:3000/api/pipeline/run"

CASES = [
    ("lora-node", ["battery power", "RP2040 MCU", "LoRa radio", "U.FL antenna"]),
    ("drone-fc", ["USB-C power", "RP2040 flight controller", "LoRa telemetry",
                  "U.FL antenna", "MPU6050 IMU", "4x ESC motor outputs"]),
    ("gps-tracker", ["power", "MCU", "cellular LTE-M NB-IoT GNSS combo module",
                     "GNSS_RF", "antenna connectors"]),
    ("env-sensor", ["battery power", "low-power MCU", "LoRa radio SX1276",
                    "I2C temperature sensor", "U.FL antenna"]),
    ("usb-temp-logger", ["USB-C power", "RP2040 MCU", "I2C temperature sensor"]),
    ("data-logger", ["power (USB-C 5V + protection)", "MCU (STM32 Cortex-M)",
                     "sensors (6-axis IMU + digital temperature)",
                     "storage (SPI NOR flash)", "USB data interface"]),
    ("motor-ctrl", ["USB-C power", "RP2040 MCU", "4x servo/ESC outputs"]),
    ("unknown-blocks", ["MCU", "soil moisture sensor", "OLED display", "buzzer"]),
    ("minimal", ["MCU", "power"]),
    ("kitchen-sink", ["USB-C power", "RP2040 MCU", "MPU6050 IMU",
                      "I2C temperature sensor", "LoRa radio", "U.FL antenna"]),
    # asset tracker that exposed the clearance + firmware-gating bugs — regression guard
    ("asset-tracker", ["USB-C power", "low-power MCU", "LoRa radio SX1276",
                       "GNSS GPS module", "I2C temperature sensor", "U.FL antenna"]),
    # busy mix: 4 motors + two I2C sensors + USB-C fine pitch (placement + bus + routing)
    ("robot-ctrl", ["USB-C power", "RP2040 MCU", "MPU6050 IMU",
                    "I2C temperature sensor", "4x ESC motor outputs"]),
    # cellular modem in isolation (no GNSS) + sourced sensor
    ("cellular-logger", ["USB-C power", "RP2040 MCU", "LTE-M cellular modem",
                         "I2C temperature sensor"]),
    # two RF subsystems on one board (LoRa + cellular + their UARTs/antennas)
    ("dual-radio", ["battery power", "RP2040 MCU", "LoRa radio", "U.FL antenna",
                    "cellular modem"]),
]


def run(name, blocks):
    spec = base64.b64encode(json.dumps(
        {"blocks": blocks, "boardClass": name}).encode()).decode()
    url = "{}?prompt={}&runId=test-{}&compose=1&spec={}".format(
        BASE, name, name, urllib.parse.quote(spec))
    stages, logs, status, err = {}, [], "?", None
    try:
        with urllib.request.urlopen(url, timeout=400) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                ev = json.loads(line[5:].strip())
                t = ev.get("type")
                if t == "stage":
                    stages[ev["id"]] = ev["state"]
                elif t == "log":
                    logs.append(ev.get("text", ""))
                elif t == "done":
                    status = ev.get("status")
                elif t == "error":
                    err = ev.get("message")
    except Exception as e:  # noqa: BLE001
        err = "stream error: %s" % e

    failed = [s for s, st in stages.items() if st == "failed"]
    drc = next((l for l in logs if "DRC →" in l or "violations," in l), "")
    routed = next((l for l in logs if "board.json:" in l), "")
    dropped = next((l for l in logs if "COMPOSE_COVERAGE" in l), "")
    nd = 0
    if dropped:
        try:
            nd = len(json.loads(dropped.split("COMPOSE_COVERAGE:")[1])["dropped"])
        except Exception:
            pass
    return {
        "name": name, "status": status, "failed": failed, "err": err,
        "drc": drc.split("→")[-1].strip() if "→" in drc else "",
        "routed": routed.split("board.json:")[-1].strip()[:40] if routed else "",
        "dropped": nd,
    }


def main():
    import urllib.parse  # noqa: F401 (referenced in run)
    only = sys.argv[1] if len(sys.argv) > 1 else None
    cases = [c for c in CASES if not only or c[0] == only]
    rows = []
    for name, blocks in cases:
        sys.stdout.write("running %-16s … " % name)
        sys.stdout.flush()
        res = run(name, blocks)
        ok = res["status"] == "PASSED" and not res["failed"]
        print("%s%s" % ("PASS" if ok else "FAIL",
                        "" if ok else "  <- %s %s" % (res["failed"], res["err"] or "")))
        rows.append(res)
    print("\n=== SUMMARY ===")
    print("%-16s %-8s %-8s %-26s %s" % ("case", "status", "dropped", "routed/drc", "failed"))
    npass = 0
    for r in rows:
        ok = r["status"] == "PASSED" and not r["failed"]
        npass += ok
        print("%-16s %-8s %-8d %-26s %s" % (
            r["name"], r["status"], r["dropped"], r["routed"] or r["drc"],
            ",".join(r["failed"]) or "-"))
    print("\n%d/%d passed" % (npass, len(rows)))


if __name__ == "__main__":
    import urllib.parse
    main()
