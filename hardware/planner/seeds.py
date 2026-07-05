"""Seed component library — 15 real parts, each a KiCad-backed Universal Component
Spec. These are PROOF that the generic schema + ingestion + resolver + recovery
loop work end to end; they are NOT the architecture. Every part is ingested from
its real KiCad symbol (pins are authoritative) and refined with per-part
overrides carrying real electrical/interface/support-circuit values.

  from seeds import build_seeds
  lib = build_seeds()        # {mpn: UCS}

Overrides are the ONLY hand-authored data; everything else comes from the KiCad
library via ingest.from_kicad_symbol, so a seed can never claim a pin the symbol
doesn't have. Values are typical catalogue figures for these standard parts; the
provenance for overridden electrical limits is 'datasheet' at moderate confidence.
"""
import ingest

# (symbol_query, mpn, manufacturer, category, overrides)
SEEDS = [
    ("74HC595", "74HC595", "Texas Instruments", "logic.shift_register", {
        "description": "8-bit serial-in, parallel-out shift register (write-only SPI)",
        "interfaces": [{"type": "spi_write_only",
                        "signals": {"sck": "SRCLK", "mosi": "SER", "latch": "RCLK"}}],
        "power": {"vcc_min": 2.0, "vcc_max": 6.0, "vcc_typ": 3.3, "i_max_ma": 70.0},
        "support_circuit": {
            "pulldowns": [{"pin": "OE", "to": "GND", "note": "output enable, active low"}],
            "pullups": [{"pin": "SRCLR", "to": "VCC", "note": "clear, active low"}]},
        "firmware": {"driver": "spi_shift_out", "test": "write_pattern"},
    }),
    ("BME280", "BME280", "Bosch", "sensor.environmental", {
        "description": "Temperature / humidity / pressure sensor (I2C or SPI)",
        "capabilities": ["temperature", "humidity", "pressure"],
        "interfaces": [{"type": "i2c", "signals": {"scl": "SCK", "sda": "SDI"}, "role": "primary"},
                       {"type": "spi", "signals": {}, "role": "alt"}],
        "power": {"vcc_min": 1.71, "vcc_max": 3.6, "vcc_typ": 3.3, "i_max_ma": 0.7},
        "support_circuit": {"pullups": [{"pin": "SCK", "to": "VCC", "value": "4.7k", "note": "I2C SCL"},
                                        {"pin": "SDI", "to": "VCC", "value": "4.7k", "note": "I2C SDA"}]},
        "firmware": {"driver": "i2c", "id_reg": "0xD0", "id_value": "0x60", "test": "read_id"},
        "fl1_validation": {"bus": "I2C", "expect_ack": True},
    }),
    ("INA219", "INA219", "Texas Instruments", "sensor.current", {
        "description": "Bidirectional current / power monitor, I2C",
        "capabilities": ["current_sense", "voltage_sense", "power_sense"],
        "interfaces": [{"type": "i2c", "signals": {"scl": "SCL", "sda": "SDA"}}],
        "power": {"vcc_min": 3.0, "vcc_max": 5.5, "vcc_typ": 3.3, "i_max_ma": 1.0},
        "support_circuit": {"other_passives": [{"type": "shunt", "value": "0.1ohm",
                            "between": ["IN+", "IN-"], "note": "current sense element"}]},
        "firmware": {"driver": "i2c", "id_reg": "0x00", "test": "read_config"},
    }),
    ("DRV8833", "DRV8833", "Texas Instruments", "motor.driver", {
        "description": "Dual H-bridge motor driver",
        "capabilities": ["dc_motor_x2", "stepper_x1"],
        "kicad_footprint": "Package_SO:HTSSOP-16-1EP_4.4x5mm_P0.65mm_EP3.4x5mm",
        "power": {"vcc_min": 2.7, "vcc_max": 10.8, "vcc_typ": 5.0, "i_max_ma": 2000.0},
        "support_circuit": {
            "decoupling": [{"value": "100nF", "from": "VM", "to": "GND"},
                           {"value": "10uF", "from": "VM", "to": "GND", "note": "bulk"},
                           {"value": "10nF", "from": "VCP", "to": "VM", "note": "charge pump"}],
            "other_passives": [{"type": "sense", "pin": "AISEN", "to": "GND", "value": "0.2ohm"},
                               {"type": "sense", "pin": "BISEN", "to": "GND", "value": "0.2ohm"}]},
        "constraints": {"thermal": ["HTSSOP thermal pad to copper pour"],
                        "routing": ["VM and motor outputs use wide/high-current traces"]},
        "firmware": {"driver": "hbridge", "test": "gated_output", "safety": True},
    }),
    ("WS2812B", "WS2812B", "Worldsemi", "led.addressable", {
        "description": "Addressable RGB LED, single-wire 800kHz protocol",
        "interfaces": [{"type": "gpio", "signals": {"din": "DIN", "dout": "DOUT"},
                        "role": "single_wire_800khz"}],
        "power": {"vcc_min": 3.5, "vcc_max": 5.3, "vcc_typ": 5.0, "i_max_ma": 60.0},
        "support_circuit": {"decoupling": [{"value": "100nF", "from": "VDD", "to": "GND",
                            "note": "one per LED"}]},
        "constraints": {"routing": ["DIN->DOUT chain, keep the data line short"]},
        "firmware": {"driver": "ws2812_pio", "test": "color_walk"},
    }),
    ("MCP23017", "MCP23017", "Microchip", "interface.gpio_expander", {
        "description": "16-bit I2C GPIO expander",
        "interfaces": [{"type": "i2c", "signals": {"scl": "SCK", "sda": "SDA"}}],
        "power": {"vcc_min": 1.8, "vcc_max": 5.5, "vcc_typ": 3.3, "i_max_ma": 1.0},
        "support_circuit": {"pullups": [{"pin": "RESET", "to": "VCC", "note": "active low"}]},
        "firmware": {"driver": "i2c", "test": "read_write_iodir"},
    }),
    ("DS3231", "DS3231", "Analog Devices (Maxim)", "timer.rtc", {
        "description": "Extremely accurate I2C real-time clock",
        "interfaces": [{"type": "i2c", "signals": {"scl": "SCL", "sda": "SDA"}}],
        "power": {"vcc_min": 2.3, "vcc_max": 5.5, "vcc_typ": 3.3, "i_max_ma": 0.2},
        "support_circuit": {"other_passives": [{"type": "battery", "pin": "VBAT",
                            "note": "coin cell backup"}]},
        "firmware": {"driver": "i2c", "test": "read_time"},
    }),
    ("W25Q128", "W25Q128JVSIQ", "Winbond", "memory.spi_flash", {
        "description": "128Mbit SPI NOR flash",
        "interfaces": [{"type": "spi", "signals": {"sck": "CLK", "mosi": "DI", "miso": "DO", "cs": "CS"}}],
        "power": {"vcc_min": 2.7, "vcc_max": 3.6, "vcc_typ": 3.3, "i_max_ma": 25.0},
        "support_circuit": {"pullups": [{"pin": "WP", "to": "VCC", "note": "write protect"},
                                        {"pin": "HOLD", "to": "VCC", "note": "hold, active low"}]},
        "firmware": {"driver": "spi", "id_cmd": "0x9F", "test": "read_jedec_id"},
    }),
    ("LIS3DH", "LIS3DH", "STMicroelectronics", "sensor.accelerometer", {
        "description": "3-axis MEMS accelerometer (I2C or SPI)",
        "interfaces": [{"type": "i2c", "signals": {"scl": "SPC", "sda": "SDI"}, "role": "primary"},
                       {"type": "spi", "signals": {}, "role": "alt"}],
        "power": {"vcc_min": 1.71, "vcc_max": 3.6, "vcc_typ": 3.3, "i_max_ma": 0.2},
        "firmware": {"driver": "i2c", "id_reg": "0x0F", "id_value": "0x33", "test": "read_whoami"},
    }),
    ("MAX3485", "MAX3485", "Analog Devices (Maxim)", "interface.rs485", {
        "description": "3.3V half-duplex RS-485 transceiver",
        "interfaces": [{"type": "rs485", "signals": {"a": "A", "b": "B", "ro": "RO",
                        "di": "DI", "de": "DE", "re": "RE"}}],
        "power": {"vcc_min": 3.0, "vcc_max": 3.6, "vcc_typ": 3.3, "i_max_ma": 1.0},
        "support_circuit": {"other_passives": [{"type": "termination", "value": "120ohm",
                            "between": ["A", "B"], "note": "bus termination"}]},
        "constraints": {"routing": ["A/B as a differential pair to the connector"]},
        "firmware": {"driver": "uart_de", "test": "loopback_if_fixture"},
    }),
    ("MCP73831", "MCP73831", "Microchip", "power.battery_charger", {
        "description": "Single-cell Li-Ion/Li-Po linear charge controller",
        "interfaces": [{"type": "battery", "signals": {"vbat": "VBAT"}},
                       {"type": "power_in", "signals": {"vdd": "VDD"}}],
        "power": {"vcc_min": 3.75, "vcc_max": 6.0, "vcc_typ": 5.0, "i_max_ma": 500.0},
        "support_circuit": {
            "decoupling": [{"value": "4.7uF", "from": "VDD", "to": "GND", "note": "input"},
                           {"value": "4.7uF", "from": "VBAT", "to": "GND", "note": "output"}],
            "other_passives": [{"type": "prog", "pin": "PROG", "to": "GND", "value": "2k",
                                "note": "sets charge current ~500mA"}]},
        "constraints": {"thermal": ["copper pour under package for heat"],
                        "layout": ["place near the battery connector"]},
        "firmware": {"driver": "gpio", "test": "read_stat"},
    }),
    ("TPS62162", "TPS62162", "Texas Instruments", "power.buck_regulator", {
        "description": "3.3V 1A step-down (buck) converter",
        "interfaces": [{"type": "power_out", "signals": {"vout": "VOS"}}],
        "power": {"vcc_min": 3.0, "vcc_max": 17.0, "vcc_typ": 5.0, "i_max_ma": 1000.0},
        "support_circuit": {
            "decoupling": [{"value": "10uF", "from": "VIN", "to": "GND", "note": "input"},
                           {"value": "22uF", "from": "VOUT", "to": "GND", "note": "output"}],
            "other_passives": [{"type": "inductor", "value": "2.2uH", "note": "buck inductor"},
                               {"type": "feedback", "note": "FB divider sets 3.3V"}]},
        "constraints": {"layout": ["tight input cap + inductor loop"]},
        "firmware": {"driver": "none", "test": "rail_measure_fl1"},
    }),
    ("AP2112", "AP2112K-3.3", "Diodes Inc", "power.ldo_regulator", {
        "description": "3.3V 600mA low-dropout linear regulator",
        "interfaces": [{"type": "power_out", "signals": {"vout": "VOUT"}}],
        "power": {"vcc_min": 2.5, "vcc_max": 6.0, "vcc_typ": 5.0, "i_max_ma": 600.0},
        "support_circuit": {
            "decoupling": [{"value": "1uF", "from": "VIN", "to": "GND", "note": "input"},
                           {"value": "1uF", "from": "VOUT", "to": "GND", "note": "output"}],
            "pullups": [{"pin": "EN", "to": "VIN", "note": "enable"}]},
        "firmware": {"driver": "none", "test": "rail_measure_fl1"},
    }),
    ("USB_C_Receptacle_USB2.0", "USB4085-GF-A", "GCT", "connector.usb_c_power", {
        "description": "USB-C receptacle (USB 2.0 + power)",
        "interfaces": [{"type": "power_in", "signals": {"vbus": "VBUS", "gnd": "GND"}},
                       {"type": "usb", "signals": {"dp": "D+", "dm": "D-"}}],
        "support_circuit": {"pulldowns": [{"pin": "CC1", "to": "GND", "value": "5.1k", "note": "sink"},
                                          {"pin": "CC2", "to": "GND", "value": "5.1k", "note": "sink"}]},
        "constraints": {"routing": ["D+/D- as a 90ohm differential pair (or leave for power-only)"]},
    }),
]

# JST battery connector is a footprint, not a symbol — ingest it as a pin table.
_JST = None


def build_seeds():
    """Ingest all seeds into UCS. Returns {mpn: spec}. Raises if any seed fails
    schema validation (a bad seed must never enter the library)."""
    lib = {}
    for sym, mpn, mfr, cat, ov in SEEDS:
        spec = ingest.from_kicad_symbol(sym, mpn=mpn, manufacturer=mfr,
                                        category=cat, overrides=ov)
        lib[mpn] = spec
    # JST PH 2-pin battery connector (footprint-only part) via a manual pin table
    jst = ingest.from_pin_table(
        "S2B-PH-K-S", [("1", "VBAT", "power_in"), ("2", "GND", "ground")],
        kicad_symbol="Connector:Conn_01x02_Pin",
        kicad_footprint="Connector_JST:JST_PH_S2B-PH-K_1x02_P2.00mm_Horizontal",
        category="connector.battery", manufacturer="JST")
    jst["interfaces"] = [{"type": "battery", "signals": {"vbat": "VBAT"}}]
    lib["S2B-PH-K-S"] = jst
    return lib


if __name__ == "__main__":
    lib = build_seeds()
    for mpn, s in lib.items():
        ifaces = ",".join(i["type"] for i in s["interfaces"])
        print("%-16s %-28s %-14s %s" % (mpn, s["category"], s["support_status"], ifaces))
    print("\n%d seed components, %d fully supported" % (
        len(lib), sum(1 for s in lib.values() if s["support_status"] == "supported")))
