"""
FL-1 Calibration Board Self-Test Firmware
MicroPython for Raspberry Pi Pico 2 (RP2040) on the relay/probe matrix board.

This firmware runs ON THE RELAY/PROBE MATRIX BOARD (pcba-rev-a), not on
the cal board itself. The cal board is a passive fixture that the FL-1
probes make contact with. This firmware exercises the full path:
  FL-1 pogo probes → cal board reference element → relay matrix → instrument lane.

Two operating modes:
  STANDALONE: coil health via INA219 + cal board EEPROM read + window-
              comparator contact checks. Reports JSON over USB CDC.
  COMMAND:    station PC sends routing commands; firmware routes relays and
              returns comparator state. COTS instruments (DMM6500, PicoScope,
              DAQ) do precision measurements; station PC compiles report.

USB CDC protocol (command mode):
  TX (host → MCU):
    ROUTE <probe> <lane>\n     e.g.  ROUTE P2 DMM_HI
    OPEN ALL\n                        release all relays
    CHECK <probe>\n                   read window comparator for probe
    EEPROM READ <addr> <len>\n        read cal board EEPROM via I2C
    STATUS\n                          report INA219 coil current + temperature
  RX (MCU → host):
    JSON line per command e.g. {"cmd":"ROUTE","probe":"P2","lane":"DMM_HI","ok":true}

Self-test manifest (see docs/self_test_manifest.json) defines every test
point, probe lane assignment, and expected measurement range.
"""

import json
import struct
import sys
import time

from machine import I2C, Pin, SPI

# ---------------------------------------------------------------------------
# Hardware constants — relay/probe matrix board (pcba-rev-a)
# ---------------------------------------------------------------------------

# SPI to TPIC6B595 shift-register chain (96 sink channels = 12 ICs × 8)
SPI_SCK   = Pin(18)
SPI_MOSI  = Pin(19)
SPI_LATCH = Pin(20)   # RCK — rising edge transfers shift to output
SPI_OE_N  = Pin(21)   # active-low output enable; also watchdog reset trigger
SPI_BUS   = SPI(0, baudrate=1_000_000, sck=SPI_SCK, mosi=SPI_MOSI)
NUM_SR    = 12        # number of TPIC6B595 ICs in chain
NUM_SINKS = 96        # total coil sink channels

# I2C bus: INA219 (coil telemetry) + board EEPROM + cartridge EEPROM
I2C_BUS = I2C(1, sda=Pin(2), scl=Pin(3), freq=100_000)
INA219_ADDR   = 0x40  # A0=A1=GND
CAL_EEPROM_ADDR = 0x50  # 24AA025UIDT on relay/probe matrix board (A0=A1=GND)
CART_EEPROM_ADDR = 0x51  # cal board EEPROM accessed through probe pads

# Window comparator inputs from TLV3502 (one per probe resource)
VCHECK_HI = [Pin(p) for p in (6, 7, 8, 9, 10, 11, 12, 13)]   # P1–P4, KF+/-, KS+/-
VCHECK_LO = [Pin(p) for p in (14, 15, 16, 17, 22, 26, 27, 28)]

# Probe resource index (must match coil channel map in relay-probe-matrix-rev-a.md)
PROBE_IDX = {"P1": 0, "P2": 1, "P3": 2, "P4": 3,
             "KFP": 4, "KFN": 5, "KSP": 6, "KSN": 7}

# Lane index within each probe tree (8 G6K lanes + 3 reed lanes)
LANE_IDX = {"BANK": 0, "SCOPE_A": 1, "SCOPE_B": 2, "DAQ_1": 3,
            "DAQ_2": 4, "LOGIC_1": 5, "LOGIC_2": 6, "PWR_INJ": 7,
            "DMM_HI": 8, "DMM_LO": 9, "GND_REF": 10}

# Coil channel map v2: drain_number = probe_idx * 11 + lane_idx + 1
# (matches ctl.drain1..drain96 in pcba-rev-a main.ato)
def coil_channel(probe: str, lane: str) -> int:
    p = PROBE_IDX[probe.upper()]
    l = LANE_IDX[lane.upper()]
    return p * 11 + l + 1   # 1-based, max 88 matrix + 3 ref = 91


# ---------------------------------------------------------------------------
# Relay matrix control
# ---------------------------------------------------------------------------

_sink_state = bytearray(NUM_SR)   # 96 bits, LSB-first per IC


def _commit_relays():
    """Shift shadow state into TPIC6B595 output registers."""
    SPI_OE_N.value(1)            # disable outputs while shifting
    SPI_BUS.write(_sink_state)
    SPI_LATCH.value(1)
    SPI_LATCH.value(0)
    SPI_OE_N.value(0)            # enable outputs (watchdog fed separately)


def open_all():
    """De-energise every relay (safe state)."""
    for i in range(NUM_SR):
        _sink_state[i] = 0x00
    _commit_relays()


def route(probe: str, lane: str):
    """Energise the coil for probe→lane; leaves other relays unchanged."""
    ch = coil_channel(probe, lane)          # 1-based channel number
    bit = ch - 1
    ic  = bit // 8
    b   = bit % 8
    _sink_state[ic] |= (1 << b)
    _commit_relays()


def check_probe(probe: str) -> dict:
    """Read window comparator outputs for a probe node."""
    idx = PROBE_IDX[probe.upper()]
    hi  = VCHECK_HI[idx].value()
    lo  = VCHECK_LO[idx].value()
    return {"probe": probe, "vcheck_hi": hi, "vcheck_lo": lo,
            "live": (hi == 0 and lo == 0)}  # both low → voltage in window


# ---------------------------------------------------------------------------
# INA219 (I2C 0x40) — coil rail telemetry
# ---------------------------------------------------------------------------
INA_CFG_REG   = 0x00
INA_SHUNT_REG = 0x01
INA_BUS_REG   = 0x02

# Config: 32 V bus, PGA /8 (320 mV shunt range), 12-bit, continuous
INA_CONFIG = 0x3FFF


def ina219_init():
    I2C_BUS.writeto_mem(INA219_ADDR, INA_CFG_REG, struct.pack(">H", INA_CONFIG))


def ina219_read() -> dict:
    raw_shunt = struct.unpack(">h", I2C_BUS.readfrom_mem(INA219_ADDR, INA_SHUNT_REG, 2))[0]
    raw_bus   = struct.unpack(">H", I2C_BUS.readfrom_mem(INA219_ADDR, INA_BUS_REG,   2))[0]
    shunt_mv  = raw_shunt * 0.01   # 10 µV LSB → mV
    bus_v     = (raw_bus >> 3) * 0.004  # 4 mV LSB
    # R_shunt = 50 mΩ
    current_ma = shunt_mv / 0.05
    return {"bus_v": round(bus_v, 3), "shunt_mv": round(shunt_mv, 3),
            "current_ma": round(current_ma, 1)}


# ---------------------------------------------------------------------------
# EEPROM I2C
# ---------------------------------------------------------------------------

def eeprom_read(i2c_addr: int, mem_addr: int, length: int) -> bytes:
    """Read `length` bytes from EEPROM at I2C address, starting at `mem_addr`."""
    I2C_BUS.writeto(i2c_addr, bytes([mem_addr]))
    time.sleep_ms(5)
    return I2C_BUS.readfrom(i2c_addr, length)


def eeprom_write(i2c_addr: int, mem_addr: int, data: bytes):
    I2C_BUS.writeto(i2c_addr, bytes([mem_addr]) + data)
    time.sleep_ms(10)   # write cycle time


def parse_cal_header(data: bytes) -> dict:
    """Decode the first 32 bytes of the cal board EEPROM header."""
    try:
        board_type = data[0:8].decode("ascii").rstrip("\x00")
        revision   = data[8:16].decode("ascii").rstrip("\x00")
        serial     = data[16:24].decode("ascii").rstrip("\x00")
        state      = data[24]
        checksum   = data[25]
        computed   = 0
        for b in data[:25]:
            computed ^= b
        return {
            "board_type": board_type,
            "revision": revision,
            "serial": serial,
            "state": hex(state),
            "checksum_ok": (checksum == computed),
        }
    except Exception as e:
        return {"error": str(e)}


def parse_cal_constants(data: bytes) -> dict:
    """Decode float32 calibration constants from EEPROM bytes 0x20–0x37."""
    try:
        r10     = struct.unpack("<f", data[0:4])[0]
        r1k     = struct.unpack("<f", data[4:8])[0]
        r100k   = struct.unpack("<f", data[8:12])[0]
        di_vf   = struct.unpack("<f", data[12:16])[0]
        ds_vf   = struct.unpack("<f", data[16:20])[0]
        c_rc_nf = struct.unpack("<f", data[20:24])[0]
        return {"r10_ohm": round(r10, 4), "r1k_ohm": round(r1k, 4),
                "r100k_ohm": round(r100k, 4), "di_vf_mv": round(di_vf, 2),
                "ds_vf_mv": round(ds_vf, 2), "c_rc_nf": round(c_rc_nf, 2)}
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# Standalone self-test sequence
# ---------------------------------------------------------------------------

def run_standalone_selftest() -> dict:
    """
    Quick autonomous self-test, no station PC required.
    Uses INA219 coil signatures + window comparators + EEPROM.
    Returns structured JSON result suitable for USB CDC output.
    """
    results = {"mode": "standalone", "timestamp_ms": time.ticks_ms(), "tests": []}

    def record(name, passed, data=None):
        results["tests"].append({"name": name, "pass": passed, **(data or {})})

    # 1. INA219 init
    try:
        ina219_init()
        record("ina219_init", True)
    except Exception as e:
        record("ina219_init", False, {"error": str(e)})
        results["overall"] = "FAIL"
        return results

    # 2. Relay coil census: walk every channel, check INA219 current signature
    open_all()
    time.sleep_ms(10)
    coil_fails = []
    for ch in range(1, NUM_SINKS + 1):
        bit = ch - 1
        ic  = bit // 8
        b_  = bit % 8
        _sink_state[ic] |= (1 << b_)
        _commit_relays()
        time.sleep_ms(2)
        tel = ina219_read()
        _sink_state[ic] &= ~(1 << b_)
        _commit_relays()
        # G6K relay coil: 5 V / 500 Ω ≈ 10 mA; reed ≈ 7 mA; ref block ≈ 10 mA
        # accept 3–25 mA as "relay energised"
        if ch <= 91 and not (3.0 <= tel["current_ma"] <= 25.0):
            coil_fails.append({"channel": ch, "current_ma": tel["current_ma"]})
    open_all()
    record("relay_coil_census", len(coil_fails) == 0,
           {"channels_tested": 91, "failures": coil_fails})

    # 3. Cal board EEPROM read through TP18-TP21 probe pads
    #    (requires FL-1 pogo probes on contact with the cal board)
    ee_ok = False
    ee_data = {}
    try:
        raw = eeprom_read(CART_EEPROM_ADDR, 0x00, 26)
        hdr = parse_cal_header(raw)
        raw_cal = eeprom_read(CART_EEPROM_ADDR, 0x20, 24)
        cal = parse_cal_constants(raw_cal)
        ee_ok   = (hdr.get("board_type", "") == "FL1-CAL-" and
                   hdr.get("checksum_ok", False))
        ee_data = {**hdr, **cal}
    except Exception as e:
        ee_data = {"error": str(e)}
    record("cal_board_eeprom", ee_ok, ee_data)

    # 4. Probe contact checks via window comparators
    #    Route P1 → GND_REF; probe should see ≈0 V (both comparator outputs low)
    open_all()
    contact_results = {}
    for probe in ["P1", "P2", "P3", "P4"]:
        route(probe, "GND_REF")
        time.sleep_ms(5)
        r = check_probe(probe)
        contact_results[probe] = r
        open_all()
    all_live = all(v["live"] for v in contact_results.values())
    record("probe_contact", all_live, {"probes": contact_results})

    # 5. Short reference: route P2 → DMM_HI and P1 → GND_REF, both on same net
    #    Expect pre-connect voltage check: TP02/TP03 at 0 V → both live
    open_all()
    route("P2", "DMM_HI")
    route("P1", "GND_REF")
    time.sleep_ms(10)
    p2_check = check_probe("P2")
    open_all()
    record("short_reference", p2_check["live"], {"comparator": p2_check})

    results["overall"] = "PASS" if all(t["pass"] for t in results["tests"]) else "FAIL"
    return results


# ---------------------------------------------------------------------------
# Command mode (station PC driven)
# ---------------------------------------------------------------------------

def handle_command(line: str) -> dict:
    """Parse one line command from station PC; return JSON response dict."""
    parts = line.strip().upper().split()
    if not parts:
        return {"error": "empty command"}

    cmd = parts[0]

    if cmd == "ROUTE" and len(parts) >= 3:
        probe = parts[1]
        lane  = parts[2]
        try:
            route(probe, lane)
            return {"cmd": "ROUTE", "probe": probe, "lane": lane, "ok": True}
        except Exception as e:
            return {"cmd": "ROUTE", "probe": probe, "lane": lane, "ok": False, "error": str(e)}

    if cmd == "OPEN":
        open_all()
        return {"cmd": "OPEN", "ok": True}

    if cmd == "CHECK" and len(parts) >= 2:
        r = check_probe(parts[1])
        return {"cmd": "CHECK", **r}

    if cmd == "EEPROM" and len(parts) >= 4 and parts[1] == "READ":
        addr   = int(parts[2], 16)
        length = int(parts[3])
        try:
            raw = eeprom_read(CART_EEPROM_ADDR, addr, length)
            return {"cmd": "EEPROM_READ", "addr": hex(addr), "len": length,
                    "data": raw.hex()}
        except Exception as e:
            return {"cmd": "EEPROM_READ", "ok": False, "error": str(e)}

    if cmd == "STATUS":
        tel = ina219_read()
        return {"cmd": "STATUS", **tel}

    return {"error": f"unknown command: {cmd}"}


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def main():
    SPI_OE_N.value(0)
    open_all()
    ina219_init()

    # Check if a station PC has already connected (stdin has data ready)
    import uselect
    poll = uselect.poll()
    poll.register(sys.stdin, uselect.POLLIN)
    ready = poll.poll(2000)   # wait up to 2 s for PC

    if not ready:
        # Standalone mode: run built-in self-test and dump JSON report
        report = run_standalone_selftest()
        sys.stdout.write(json.dumps(report) + "\n")
    else:
        # Command mode: announce readiness then parse commands
        sys.stdout.write(json.dumps({"mode": "command", "ready": True}) + "\n")
        buf = ""
        while True:
            ch = sys.stdin.read(1)
            if ch is None:
                time.sleep_ms(1)
                continue
            buf += ch
            if ch == "\n":
                resp = handle_command(buf)
                sys.stdout.write(json.dumps(resp) + "\n")
                buf = ""


if __name__ == "__main__":
    main()
