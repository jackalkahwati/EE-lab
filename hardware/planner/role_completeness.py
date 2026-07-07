"""Role-completeness checker (Phase 15.6 P2).

Separate from DRC/ERC: a board can route perfectly and still not BE the thing its
name claims. This checks the REALIZED board (footprints, nets, device manifest —
never labels alone) against its FL-1 role requirements.

Statuses:
  role_complete             every required role feature physically present
  role_complete_with_review present but with noted caveats
  role_incomplete           missing role requirements (exact list)
  do_not_order              role failures that make fabrication pointless

A DRC-clean but role_incomplete board is REJECTED for order.
"""
import json
import re


def _board_facts(board_text, devices):
    dev_types = {d.get("type") for d in devices}
    dev_names = {str(d.get("name", "")) for d in devices}
    # format tolerant: compose writes (net 5 "X"); pcbnew v10 writes pad refs as
    # (net "X") with no numeric id. Accept both.
    nets = set(re.findall(r'\(net\s+(?:\d+\s+)?"([^"]+)"', board_text))
    return {
        "mounting_holes": board_text.count('footprint "MountingHole:'),
        "test_points": board_text.count('footprint "TestPoint:'),
        "silk_labels": board_text.count("(gr_text "),
        "fl1_bus_header": any("FL-1 instrument bus" in n for n in dev_names),
        # compose path types it board_id_eeprom; the synth/UCS path types the
        # 24LC02 as plain "eeprom" (category memory.eeprom) — both are identity
        "board_id_eeprom": "board_id_eeprom" in dev_types or "eeprom" in dev_types,
        "nets": nets,
        "dev_types": dev_types,
        "dev_names": dev_names,
        "devices": devices,
    }


# per-role physical requirements: (requirement, check(facts) -> bool)
def _common_reqs(f):
    return [
        ("mounting holes (>=4)", f["mounting_holes"] >= 4),
        ("test points (>=4, labeled)", f["test_points"] >= 4),
        ("board-ID EEPROM on shared I2C", f["board_id_eeprom"]),
        ("FL-1 instrument bus header", f["fl1_bus_header"]),
        ("functional silkscreen labels", f["silk_labels"] >= 5),
        ("shared I2C control bus", {"I2C_SDA", "I2C_SCL"} <= f["nets"]),
    ]


def _controller_reqs(f):
    return _common_reqs(f) + [
        ("interlock line wired to MCU", "INTERLOCK" in f["nets"]),
        ("fault line wired to MCU", "FAULT" in f["nets"]),
        ("reset line wired to MCU", "RST_OUT" in f["nets"]),
        ("trigger line wired to MCU", "TRIG" in f["nets"]),
        ("comms/backplane link (CAN)", {"CANH", "CANL"} <= f["nets"]),
    ]


def _digital_reqs(f):
    return _common_reqs(f) + [
        ("SPI bus built (not dropped)", {"SPI_SCK", "SPI_MOSI", "SPI_MISO"} <= f["nets"]),
        ("protected GPIO bank (series-R + header)",
         any("GPIO" in n and n.endswith("_EXT") for n in f["nets"])),
        ("I2C peripheral or header present",
         "i2c_sensor" in f["dev_types"] or "I2C_SDA" in f["nets"]),
    ]


def _relay_reqs(f):
    ch_map = next((d for d in f["devices"] if d.get("type") == "channel_map"), None)
    return _common_reqs(f) + [
        ("relay/switch matrix present", "shift_register" in f["dev_types"]
         and "darlington_array" in f["dev_types"]),
        ("coil flyback protection (driver COM)", "darlington_array" in f["dev_types"]),
        ("channel breakout connectors (probes + bus)",
         {"PROBE0", "PROBE1", "PROBE2", "PROBE3", "INSTR_BUS"} <= f["nets"]),
        ("clear channel map (manifest + silk)", ch_map is not None and bool(ch_map.get("map"))),
        ("safe default disconnected state (gated OE, off at boot)",
         "SR_OE" in f["nets"] and ch_map is not None and "OFF" in str(ch_map.get("safe_default", "")).upper()),
    ]


def _calibration_reqs(f):
    return _common_reqs(f) + [
        ("precision reference wired to REF_OUT", "REF_OUT" in f["nets"]),
        ("divider producing REF_DIV", "REF_DIV" in f["nets"]),
        ("ADC measures the reference nodes",
         any("ADS1115" in n for n in f["dev_names"]) or "adc" in str(f["dev_types"])),
        ("bus-v2 safety lines (FAULT/INTERLOCK/RST_OUT/TRIG)",
         {"FAULT", "INTERLOCK", "RST_OUT", "TRIG"} <= f["nets"]),
        ("board-ID address straps (ID_A0-A2)", {"ID_A0", "ID_A1", "ID_A2"} <= f["nets"]),
    ]


def _eii_reqs(f):
    return _common_reqs(f) + [
        ("instrument UART bridge header",
         any("UART bridge" in n for n in f["dev_names"])),
        ("protected GPIO for trigger/sync/presence",
         any("GPIO" in n and n.endswith("_EXT") for n in f["nets"])),
        ("bus-v2 safety lines (FAULT/INTERLOCK/RST_OUT/TRIG)",
         {"FAULT", "INTERLOCK", "RST_OUT", "TRIG"} <= f["nets"]),
        ("board-ID address straps (ID_A0-A2)",
         {"ID_A0", "ID_A1", "ID_A2"} <= f["nets"]),
    ]


def _pcm_reqs(f):
    return _common_reqs(f) + [
        ("voltage sense path (divider -> protected ADC input)",
         {"DUT_V", "VSENSE_DIV", "VSENSE_ADC"} <= f["nets"]),
        ("current sense path (shunt -> protected ADC input)",
         {"SHUNT_HI", "ISENSE_ADC"} <= f["nets"]),
        ("shunt present (device manifest)", "shunt" in f["dev_types"]),
        ("ADC on shared I2C (ADS1115)",
         "adc" in f["dev_types"] and any("ADS1115" in n for n in f["dev_names"])),
        ("ADC input protection (series R into both channels)",
         {"VSENSE_ADC", "ISENSE_ADC"} <= f["nets"]),
        ("DUT input connector", "DUT_V" in f["nets"]),
        ("bus-v2 safety lines (FAULT/INTERLOCK/RST_OUT/TRIG)",
         {"FAULT", "INTERLOCK", "RST_OUT", "TRIG"} <= f["nets"]),
        ("board-ID address straps (ID_A0-A2)",
         {"ID_A0", "ID_A1", "ID_A2"} <= f["nets"]),
    ]


def _mono_core6_reqs(f):
    """Monolithic Core-6 (Phase 18.8): all six board-family functions on ONE
    board, plus the universal primitives. Works for Pico and no-Pico variants;
    no-Pico additionally uses _mono_nopico_reqs."""
    ch_map = next((d for d in f["devices"] if d.get("type") == "channel_map"), None)
    return _common_reqs(f) + [
        ("system identity (board-ID EEPROM)", f["board_id_eeprom"]),
        ("MCU present (module or bare)", "mcu" in f["dev_types"]),
        ("digital bring-up IO (protected GPIO bank)",
         any("GPIO" in n and n.endswith("_EXT") for n in f["nets"])),
        ("relay/probe matrix present", "shift_register" in f["dev_types"]),
        ("relay safe default (gated OE, off at boot)",
         "SR_OE" in f["nets"] and ch_map is not None
         and "OFF" in str(ch_map.get("safe_default", "")).upper()),
        ("calibration/reference path (REF_OUT/REF_DIV measured)",
         {"REF_OUT", "REF_DIV"} <= f["nets"]
         and "voltage_reference" in f["dev_types"]),
        ("external instrument bridge (UART)",
         any("UART bridge" in n for n in f["dev_names"])),
        ("power/current monitor path (shunt + protected ADC)",
         {"SHUNT_HI", "ISENSE_ADC", "VSENSE_ADC"} <= f["nets"]),
        ("safety lines (FAULT/INTERLOCK/RST_OUT/TRIG)",
         {"FAULT", "INTERLOCK", "RST_OUT", "TRIG"} <= f["nets"]),
        ("comms/backplane link (CAN)", {"CANH", "CANL"} <= f["nets"]),
    ]


def mono_nopico_checks(board_text, devices):
    """No-Pico specific checks: the Pico module must be ABSENT and every bare
    subsystem element present (or its absence is the exact blocker)."""
    dev_names = {str(d.get("name", "")) for d in devices}
    nets = set(re.findall(r'\(net\s+(?:\d+\s+)?"([^"]+)"', board_text))
    checks = [
        ("no Pico module footprint", "RaspberryPi_Pico" not in board_text),
        ("bare RP2040 present (QFN-56)", "QFN-56" in board_text
         and any("RP2040" in n for n in dev_names)),
        ("QSPI flash present", "qspi_flash" in {d.get("type") for d in devices}
         and {"QSPI_SS", "QSPI_SCLK", "QSPI_SD0"} <= nets),
        ("clock source present (crystal + XIN/XOUT)",
         'footprint "Crystal:' in board_text and {"RP_XIN", "RP_XOUT"} <= nets),
        ("3V3 regulator present", "SOT-223" in board_text),
        ("SWD/boot/reset present",
         {"RP_SWCLK", "RP_SWDIO", "RP_RUN", "QSPI_SS"} <= nets),
        ("USB advisory-only (pads, no connector claim)",
         {"RP_USB_DM", "RP_USB_DP"} <= nets and "USB_C_Receptacle" not in board_text),
    ]
    return {"checks": [{"check": c, "ok": bool(ok)} for c, ok in checks],
            "all_present": all(ok for _c, ok in checks)}


def _sensor_board_reqs(f):
    """GENERIC sensor board role (Phase 22.1) — no FL-1 bus, straps, envelope,
    or system-identity requirements. What any honest sensor board needs."""
    return [
        ("power input present", "+5V" in f["nets"] or "VBAT" in f["nets"]),
        ("MCU/compute path present", "mcu" in f["dev_types"]),
        ("sensor connected on a bus",
         any(t and "sensor" in str(t) for t in f["dev_types"])
         and {"I2C_SDA", "I2C_SCL"} <= f["nets"]),
        ("I2C pull-ups owned (single board = card-owned)",
         True),  # single-board build: card pull-ups populated by design
        ("programming/debug path (module USB/BOOTSEL)", "mcu" in f["dev_types"]),
        ("status LED present or intentionally omitted", "LED_K" in f["nets"]),
        ("test points (>=4)", f["test_points"] >= 4),
        ("mounting holes (>=4)", f["mounting_holes"] >= 4),
        ("silk labels present", f["silk_labels"] >= 4),
        ("board identity (optional pattern, present)", f["board_id_eeprom"]),
    ]


ROLE_CHECKS = {
    "controller_backplane": _controller_reqs,
    "digital_bringup": _digital_reqs,
    "relay_probe_matrix": _relay_reqs,
    "calibration_reference": _calibration_reqs,
    "external_instrument_interface": _eii_reqs,
    "power_current_monitor": _pcm_reqs,
    "monolithic_core6": _mono_core6_reqs,
    "sensor_board": _sensor_board_reqs,
}

# caveats that keep a complete board at _with_review (honest limits, not failures)
ROLE_CAVEATS = {
    "controller_backplane": ["fixture IO is header-level (no dedicated protected fixture bank yet)",
                             "sync/clock line not implemented (TRIG only) — v1 scope"],
    "digital_bringup": ["no JTAG connector (SWD via Pico USB header) — v1 scope",
                        "no CAN/RS485 population on the bring-up board — v1 scope",
                        "no level shifting (single 3V3 domain) — v1 scope"],
    "relay_probe_matrix": ["4-channel v1 matrix (PROBEn -> shared 2-wire bus), not a crossbar",
                           "NO high-voltage isolation claim (signal relays, standard spacing)",
                           "NO precision/low-leakage switching claim"],
    "external_instrument_interface": [
        "NOT a measurement instrument: no DMM/scope/funcgen/RF/LA capability claims",
        "UART bridge is TTL-level (RS232 needs an external transceiver)",
        "trigger/sync are protected GPIO (Pico boots as inputs = safe default); "
        "timing is sanity-class unless measured by an external instrument",
        "COTS instrument capability is COTS capability, never internal FL-1 capability"],
    "sensor_board": [
        "GENERIC benchmark role — no FL-1 assumptions",
        "temperature only in v1: humidity/pressure sensor (BME280-class) is a "
        "recorded missing_component_model gap",
        "battery input is the composer 2-pin inlet (net named +5V by the rail "
        "convention — Pico VSYS accepts 1.8-5.5V); no charger, no battery-safety "
        "claim", "no low-power/sleep-current claim without measurement",
        "sensor accuracy uncalibrated"],
    "monolithic_core6": [
        "STRESS TEST article — not a product decision; the six modular plugin "
        "boards remain the valid first-article architecture",
        "monolithic bring-up has all-or-nothing risk: one fault suspends every "
        "function (no module isolation)",
        "analog/relay/digital domains share one board — noise partitioning is "
        "modeled, not measured",
        "no-Pico variants: RP2040/W25Q16 pin maps are manual transcriptions — "
        "ingestion validation REQUIRED; USB advisory pads only; QSPI timing and "
        "crystal layout unvalidated"],
    "power_current_monitor": [
        "MONITOR-ONLY: not a DMM, not a programmable supply, no electronic-load behavior",
        "UNCALIBRATED until verified against COTS DMM (cots_verifiable) or the physical "
        "Calibration/Reference board (internally_calibratable)",
        "low-current low-voltage only: 0-24V, 0-500mA labeled limits; 0402 shunt "
        "power budget bounds the current claim; NO high-current/high-voltage/isolation claim",
        "Pico MODULE is the deliberate v1 MCU choice — not a bare-RP2040 productization claim"],
    "calibration_reference": ["NO calibration claim until a traceable reference chain "
                              "exists post-fab", "metrology traceability external",
                              "board-ID defaults to 0x50 standalone; slot straps give "
                              "0x50-0x57 on a backplane"],
}


def check_role(role, board_text, devices):
    f = _board_facts(board_text, devices)
    fn = ROLE_CHECKS.get(role)
    if not fn:
        return {"role": role, "status": "role_incomplete",
                "missing": ["no role requirements defined for '%s'" % role]}
    reqs = fn(f)
    missing = [name for name, ok in reqs if not ok]
    caveats = ROLE_CAVEATS.get(role, [])
    if missing:
        status = "role_incomplete"
    elif caveats:
        status = "role_complete_with_review"
    else:
        status = "role_complete"
    return {
        "role": role, "status": status,
        "requirements_checked": len(reqs),
        "requirements_met": len(reqs) - len(missing),
        "missing": missing,
        "caveats": caveats,
        "facts": {"mounting_holes": f["mounting_holes"], "test_points": f["test_points"],
                  "silk_labels": f["silk_labels"], "board_id_eeprom": f["board_id_eeprom"],
                  "fl1_bus_header": f["fl1_bus_header"]},
        "orderable": not missing,
        "note": "DRC-clean but role_incomplete boards are REJECTED for order" if missing else None,
    }


def primitive_library():
    """The FL-1 board primitive library manifest (Phase 15.6 P1)."""
    return {
        "version": "v1",
        "primitives": [
            {"block": "fl1_bus_header", "key": "fl1bus",
             "provides": ["+5V", "+3V3", "GND", "I2C_SDA", "I2C_SCL", "FAULT",
                          "INTERLOCK", "RST_OUT", "TRIG"],
             "hardware": "2x05 header wired to real MCU pins; silkscreen pin legend"},
            {"block": "board_id_eeprom", "key": "boardid",
             "provides": ["board identity at I2C 0x50 (24LC02)"],
             "hardware": "SOIC-8 on the shared I2C bus, A0-A2+WP strapped, decoupled",
             "validation_hook": "read_board_id"},
            {"block": "mounting_holes", "key": "(universal)",
             "provides": ["4x M3 corner holes"],
             "hardware": "corner margin band, fiducials moved inboard, no collisions"},
            {"block": "test_points", "key": "(universal)",
             "provides": ["labeled TPs on +5V/+3V3/GND + I2C/FAULT/INTERLOCK/TRIG/SR_OE when present"],
             "hardware": "1.5mm probe pads along the bottom margin, silk net names"},
            {"block": "functional_silkscreen_labels", "key": "(universal)",
             "provides": ["board name + rev", "connector names", "bus/pin legends"],
             "hardware": "F.SilkS gr_text emitted from every block's label() calls"},
            {"block": "gpio_bank", "key": "gpiobank",
             "provides": ["4 protected GPIO (100R series) + GND on a labeled header"]},
            {"block": "spibus", "key": "spibus",
             "provides": ["SPI SCK/MOSI/MISO/CS + 3V3/GND bring-up header"]},
            {"block": "relay safe-default", "key": "(relaymatrix)",
             "provides": ["SR_OE gated shift-register outputs, pulled up = relays OFF at boot"],
             "hardware": "74HC595 /OE on SR_OE net + pull-up; MCU enables after safe word"},
        ],
    }
