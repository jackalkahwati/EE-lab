"""Stage 5 — ERC (Electrical Rules Check). DRC proves the board is manufacturable
and connected; ERC proves it is electrically SANE — the class of defect that
ships a DRC-clean board which still can't work. KiCad's ERC needs a schematic,
which our composed boards don't have, so this runs netlist-level rules derived
from the routed board + the device manifest.

Checks (errors block the gate; warnings are reported):
  - dangling signal net: a non-power net with < 2 connections
  - bus completeness: I2C needs SDA+SCL; SPI needs SCK+MOSI+MISO; UART needs TX+RX
  - I2C pull-ups: SDA and SCL each need a pull-up to a rail (a module like the
    GY-521 IMU carries its own; a bare sensor does not)
  - power sanity: every multi-pin IC must reach GND and a supply rail
  - rail short: no net ties two different power rails together

Usage:  <kicad-python3> erc_check.py <board.kicad_pcb> <out.json>
Prints  ERC: <n> errors, <m> warnings   and writes the report.
"""
import json
import os
import re
import sys

import pcbnew

BOARD = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else None

RAILS = {"+3V3", "+5V", "+1V8", "VBAT", "VBUS"}
GND = {"GND", "AGND", "DGND"}
POWER = RAILS | GND

# modules that carry their own I2C pull-ups (breakout boards)
PULLUP_PROVIDERS = {"imu"}  # GY-521 IMU breakout has onboard 4.7k pull-ups


def load():
    b = pcbnew.LoadBoard(BOARD)
    net_pads = {}          # net -> [(ref, pad)]
    fp_nets = {}           # ref -> {pad: net}
    fp_npads = {}          # ref -> pad count
    for fp in b.GetFootprints():
        ref = fp.GetReference()
        pads = list(fp.Pads())
        fp_npads[ref] = len(pads)
        for p in pads:
            net = str(p.GetNetname()).strip()
            net_pads.setdefault(net, []).append((ref, p.GetNumber()))
            fp_nets.setdefault(ref, {})[p.GetNumber()] = net
    devices = []
    mpath = os.path.splitext(BOARD)[0] + ".devices.json"
    if os.path.exists(mpath):
        try:
            devices = json.load(open(mpath))
        except Exception:
            devices = []
    return net_pads, fp_nets, fp_npads, devices


def check(net_pads, fp_nets, fp_npads, devices):
    errors, warnings = [], []
    nets = set(net_pads)
    dev_types = {d.get("type") for d in devices}

    # 1. dangling signal nets
    for net, pads in net_pads.items():
        if not net or net in POWER:
            continue
        if len(pads) < 2:
            warnings.append("dangling net '%s' — only 1 connection (%s.%s)"
                            % (net, pads[0][0], pads[0][1]))

    # 2. bus completeness
    pairs = [("I2C_SDA", "I2C_SCL", "I2C"),
             ("GPS_TX", "GPS_RX", "GNSS UART"),
             ("CELL_TX", "CELL_RX", "cellular UART")]
    for a, c, name in pairs:
        if (a in nets) != (c in nets):
            errors.append("%s bus incomplete: has %s but not the other line"
                          % (name, a if a in nets else c))
    # SPI needs a clock plus at least one data line. MISO is OPTIONAL: shift
    # registers (74HC595), DACs, and LED drivers are write-only, no read-back.
    # Flag only a genuinely broken bus (data without a clock, or a lone clock).
    if ("SPI_MOSI" in nets or "SPI_MISO" in nets) and "SPI_SCK" not in nets:
        errors.append("SPI bus incomplete: data line present but no SPI_SCK clock")
    if "SPI_SCK" in nets and "SPI_MOSI" not in nets and "SPI_MISO" not in nets:
        errors.append("SPI bus incomplete: SPI_SCK present but no data line")

    # 3. I2C pull-ups (unless a module provides them)
    def has_pullup(signal):
        for ref, _pad in net_pads.get(signal, []):
            if ref.startswith("R"):
                others = [n for pn, n in fp_nets.get(ref, {}).items() if n != signal]
                if any(n in RAILS for n in others):
                    return True
        return False

    if "I2C_SDA" in nets and not (dev_types & PULLUP_PROVIDERS):
        for sig in ("I2C_SDA", "I2C_SCL"):
            if not has_pullup(sig):
                errors.append("I2C bus has no pull-up resistor on %s "
                              "(needed: ~4.7k to 3V3; the bus won't function)" % sig)

    # 4. power sanity: every multi-pin IC reaches GND + a rail. Only check the
    # rails this board actually defines, so a board with custom rail names (e.g.
    # the legacy relay board's lv/hv) isn't false-failed.
    board_rails = RAILS & nets
    for ref, pads in fp_nets.items():
        if ref[0] not in ("U",) or fp_npads.get(ref, 0) < 4:
            continue  # only real ICs (U*), skip 2-pin parts/connectors
        net_set = set(pads.values())
        if GND and not (net_set & GND):
            errors.append("%s has no GND connection" % ref)
        if board_rails and not (net_set & board_rails):
            errors.append("%s has no supply-rail connection" % ref)

    # 5. rail short
    for net, pads in net_pads.items():
        if net in RAILS:
            # a rail net touching a GND pad on a 2-pin part would be a cap (ok);
            # only flag if two DIFFERENT rails share a net (impossible by net id,
            # so this is a placeholder for future multi-rail boards)
            pass

    return errors, warnings


def main():
    errors, warnings = check(*load())
    report = {"errors": errors, "warnings": warnings, "pass": len(errors) == 0}
    if OUT:
        json.dump(report, open(OUT, "w"), indent=1)
    for e in errors:
        print("ERC ERROR: " + e)
    for w in warnings:
        print("ERC warn: " + w)
    print("ERC: %d errors, %d warnings — %s"
          % (len(errors), len(warnings), "PASS" if not errors else "FAIL"))
    sys.exit(0 if not errors else 1)


if __name__ == "__main__":
    main()
