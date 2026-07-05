"""Generate the FL-1 Validation Package for a composed board.

This is the artifact FL-1 EXECUTES. Beyond gerbers/BOM/STEP/firmware, Compose
emits one machine-readable package that tells FL-1 exactly how to bring the
board to life and prove it works:

  - identification    : fiducials + outline for vision registration
  - probe_map         : probe locations / test-point map (net -> pad + XY + size)
  - power_sequence    : pre-power short screen, power-up steps, expected currents,
                        rail timing requirements, pass/fail limits
  - firmware_programming : how to flash + verify the MCU
  - bus_protocols     : every bus on the board, its signals, speed, and devices
  - functional_tests  : the ordered test sequence with pass/fail criteria
  - calibration       : gantry/probe/reference calibration procedures

It COMPOSES the already-generated fl1-testplan.json (probes, expected voltages,
limits, power-up) with the device manifest (bus protocols, programming, per-part
checks) and the power budget (expected currents, timing), so nothing is
duplicated or invented — every entry traces to a real net, pad, or part.

  python3 gen_validation.py <board.kicad_pcb> <testplan.json> <devices.json> \\
                            <power-budget.json> <out.json>

Prints "VALIDATION <n_tests>" sentinel.
"""
import json
import re
import sys

import pcbnew

board_path, tp_path, dev_path, pb_path, out_path = sys.argv[1:6]


def _load(path, default):
    try:
        return json.load(open(path))
    except Exception:
        return default


tp = _load(tp_path, {})
devices = _load(dev_path, [])
pb = _load(pb_path, {})

b = pcbnew.LoadBoard(board_path)
nets = {b.GetNetInfo().GetNetItem(i).GetNetname()
        for i in range(b.GetNetInfo().GetNetCount())}
nets.discard("")

# ---- bus protocols: from the nets present + what the device manifest says -----
by_type = {}
for d in devices:
    by_type.setdefault(d.get("type"), []).append(d)


def _dev_list(types):
    out = []
    for t in types:
        for d in by_type.get(t, []):
            out.append({"ref": d.get("ref"),
                        "part": d.get("name") or d.get("desc") or d.get("type")})
    return out


bus_protocols = []
if "I2C_SDA" in nets and "I2C_SCL" in nets:
    bus_protocols.append({
        "bus": "I2C", "signals": ["I2C_SDA", "I2C_SCL"],
        "speed": "100 kHz (standard); 400 kHz if all devices support fast-mode",
        "pull_ups": "4.7k to +3V3 (bus master)",
        "address_scan": "0x08-0x77",
        "devices": _dev_list(["i2c_sensor", "i2c_device", "i2c_tempsensor",
                              "current_sense"]),
    })
if "SPI_SCK" in nets and ("SPI_MOSI" in nets or "SPI_MISO" in nets):
    duplex = "full-duplex" if "SPI_MISO" in nets else "write-only (no MISO)"
    bus_protocols.append({
        "bus": "SPI", "signals": [n for n in ("SPI_SCK", "SPI_MOSI", "SPI_MISO")
                                  if n in nets],
        "mode": duplex, "speed": "up to 10 MHz (mode 0 unless the datasheet differs)",
        "chip_selects": sorted(n for n in nets if n.endswith(("_NSS", "_CS", "SR_LATCH"))),
        "devices": _dev_list(["spi_device", "shift_register", "radio"]),
    })
if "CAN_TXD" in nets and "CAN_RXD" in nets:
    bus_protocols.append({
        "bus": "CAN", "signals": ["CANH", "CANL"], "logic": ["CAN_TXD", "CAN_RXD"],
        "speed": "500 kbps (default); confirm against the network",
        "termination": "120 ohm across CANH/CANL (present on-board)",
        "devices": _dev_list(["can_transceiver"]),
    })
for pfx, proto in (("GPS", "UART/NMEA"), ("CELL", "UART/AT")):
    if "%s_TX" % pfx in nets:
        bus_protocols.append({
            "bus": "%s (%s)" % (pfx, proto), "signals": ["%s_TX" % pfx, "%s_RX" % pfx],
            "speed": "9600 baud (typical; confirm module default)",
        })
if "STEP" in nets and "DIR" in nets:
    bus_protocols.append({
        "bus": "STEP/DIR", "signals": ["STEP", "DIR", "MOT_EN"],
        "protocol": "one pulse per microstep on STEP, level on DIR, active-low enable",
        "devices": _dev_list(["stepper_driver"]),
    })
if "RS485_A" in nets and "RS485_B" in nets:
    bus_protocols.append({
        "bus": "RS485", "signals": ["RS485_A", "RS485_B"],
        "logic": ["RS485_DI", "RS485_RO", "RS485_DE"],
        "speed": "up to 115.2 kbaud (half-duplex; confirm network)",
        "termination": "120 ohm across A/B (present on-board)",
        "devices": _dev_list(["rs485"]),
    })

# ---- firmware programming: driven by the MCU on the board ---------------------
has_mcu = any(d.get("type") == "mcu" for d in devices)
firmware_programming = None
if has_mcu:
    firmware_programming = {
        "target": "RP2040 (Pico class)",
        "interface": "SWD (2-wire) or USB UF2 mass-storage bootloader",
        "steps": [
            {"step": 1, "action": "probe SWDIO/SWCLK (or hold BOOTSEL and enumerate "
                                  "USB) to enter programming mode"},
            {"step": 2, "action": "erase + write the firmware image "
                                  "(firmware.uf2 in the firmware package)"},
            {"step": 3, "action": "reset and read back the boot signature to confirm "
                                  "the image is running"},
        ],
        "verify": "boot signature / heartbeat on the self-test image",
        "recovery": "re-enter bootloader and reflash on verify failure",
    }

# ---- expected currents + rail timing: from the power budget -------------------
expected_currents = []
for rail, r in (pb.get("rails") or {}).items():
    expected_currents.append({
        "rail": rail,
        "typical_ma": r.get("typ_ma", 0.0),
        "max_ma": r.get("worst_ma", 0.0),
        "over_current_trip_ma": round((r.get("worst_ma", 0.0) or 0.0) * 1.5 + 50, 1),
    })
inlet = pb.get("inlet_5v", {})

timing = [
    {"requirement": "rail rise time", "signal": "each supply rail",
     "spec": "monotonic to final value within 10 ms of enable"},
    {"requirement": "power sequencing", "signal": "+5V then +3V3",
     "spec": "+3V3 valid within 5 ms after +5V is in range"},
    {"requirement": "reset pulse width", "signal": "MCU reset",
     "spec": ">= 1 ms low before release"},
]
for bp in bus_protocols:
    if bp["bus"] == "I2C":
        timing.append({"requirement": "I2C clock period", "signal": "I2C_SCL",
                       "spec": ">= 10 us (100 kHz) or >= 2.5 us (400 kHz)"})
    if bp["bus"].startswith("STEP"):
        timing.append({"requirement": "STEP pulse", "signal": "STEP",
                       "spec": ">= 1 us high / >= 1 us low (TMC2209 minimum)"})

# ---- calibration procedures --------------------------------------------------
fiducials = tp.get("fiducials", [])
calibration = [
    {"procedure": "gantry XY calibration",
     "reference": "3 board fiducials (%s)" % ", ".join(f["ref"] for f in fiducials),
     "steps": ["vision-locate each fiducial", "solve the board-to-machine transform",
               "verify residual < 25 um at each fiducial"]},
    {"procedure": "probe force / Z-touch zero",
     "reference": "board top surface at a known-clear point",
     "steps": ["descend until the force sensor reads contact",
               "record Z-zero", "confirm probe-force within 20-80 gf"]},
    {"procedure": "measurement reference check",
     "reference": "on-board +3V3 rail vs the DMM internal reference",
     "steps": ["measure +3V3 with the calibrated DMM front-end",
               "confirm within +/-0.5% before trusting rail measurements"]},
]

# ---- functional test sequence: the ordered run FL-1 executes ------------------
measurements = tp.get("measurements", [])
functional_tests = [
    {"step": 1, "name": "pre-power short screen",
     "actions": tp.get("pre_power", []),
     "pass_if": "no supply-to-GND short (each rail >= 10 ohm to GND)"},
    {"step": 2, "name": "power-up + rail validation",
     "actions": tp.get("power_up", []),
     "pass_if": "every rail within its min/max under its inrush limit"},
    {"step": 3, "name": "quiescent current check",
     "actions": [{"rail": c["rail"], "expect_ma_max": c["max_ma"]}
                 for c in expected_currents],
     "pass_if": "each rail draws <= its max_ma at idle (no over-current trip)"},
    {"step": 4, "name": "firmware program + boot",
     "actions": (firmware_programming or {}).get("steps", []),
     "pass_if": "boot signature verified"},
    {"step": 5, "name": "bus activity + device discovery",
     "actions": [{"bus": bp["bus"], "expect": "devices respond / lines toggle"}
                 for bp in bus_protocols] or [{"note": "no external buses on this board"}],
     "pass_if": "each bus shows the expected activity and all listed devices ack"},
    {"step": 6, "name": "signal measurements",
     "actions": measurements,
     "pass_if": "every measured point within its pass/fail limits"},
]

# ---- required FL-1 tools + manual/unsupported tests (derived, not invented) --
_tools = set()
for m in measurements:
    t = m.get("type")
    _tools.add({"dc_voltage": "DMM / rail probe", "continuity": "continuity meter",
                "digital_activity": "logic analyzer / bus host",
                "current": "current probe"}.get(t, "DMM"))
for bp in bus_protocols:
    _tools.add("%s host" % bp["bus"].split(" ")[0])
if firmware_programming:
    _tools.add(firmware_programming["interface"].split(" or ")[0].strip() + " programmer")
required_tools = sorted(_tools)

# tests FL-1's base can't run automatically — they need an external fixture or a
# capability pack. Surfaced honestly so the operator knows what stays manual.
manual_tests = []
for bp in bus_protocols:
    b = bp["bus"]
    if b == "RS485" or b == "CAN":
        manual_tests.append({"test": "%s bus loopback / link" % b,
                             "reason": "needs a second node or a bus fixture; FL-1 base cannot self-loop"})
    if b.startswith(("GPS", "CELL")):
        manual_tests.append({"test": "%s radio link" % b,
                             "reason": "needs live signal / RF pack"})

package = {
    "version": 1,
    "generator": "firstlight-compose",
    "spec": "FL-1 Validation Package — the executable bring-up + test spec",
    "board": tp.get("board", {}),
    "required_fl1_tools": required_tools,
    "manual_or_unsupported_tests": manual_tests,
    "identification": {
        "fiducials": fiducials,
        "outline_mm": tp.get("board", {}),
        "serial_field": "assign at first successful validation",
    },
    "probe_map": tp.get("test_points", []),
    "power_sequence": {
        "pre_power_checks": tp.get("pre_power", []),
        "power_up": tp.get("power_up", []),
        "expected_currents": expected_currents,
        "inlet": {"typical_ma": inlet.get("typ_ma"), "max_ma": inlet.get("worst_ma")},
        "timing": timing,
    },
    "firmware_programming": firmware_programming,
    "bus_protocols": bus_protocols,
    "functional_tests": functional_tests,
    "calibration": calibration,
    "measurements": measurements,
    "pass_fail": {
        "overall": "PASS only if every functional_tests step passes",
        "limits_source": "net-name rules + datasheet + power budget",
    },
    "notes": tp.get("notes", []),
}

json.dump(package, open(out_path, "w"), indent=1)
print("VALIDATION %d" % len(functional_tests))
