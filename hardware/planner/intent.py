"""Design Intent Model (Phase 1) — separate WHAT the user wants from HOW the board
is built. Intent is captured as capabilities + exact-part requests + constraints;
implementation (which real parts, which circuits) is decided later by the resolver
and recovery loop, so a substitution changes the implementation without losing the
recorded intent.

The parser here is deterministic (keyword + alias + part-number extraction) so the
demo is reproducible. Full natural-language parsing is where an LLM plugs in; when
it does, it fills the SAME DesignIntent structure — nothing downstream changes.

  from intent import parse_intent
  di = parse_intent(prompt)   # -> the Design Intent Model dict
"""
import re

# shorthand / alias -> canonical MPN the resolver understands
PART_ALIASES = {
    "bme280": "BME280", "bme688": "BME688", "bme680": "BME680",
    "ina219": "INA219", "ina226": "INA226",
    "w25q": "W25Q128JVSIQ", "spi flash": "W25Q128JVSIQ",
    "max3485": "MAX3485", "74hc595": "74HC595", "ws2812": "WS2812B",
    "mcp23017": "MCP23017", "ds3231": "DS3231", "lis3dh": "LIS3DH",
    "drv8833": "DRV8833", "mcp73831": "MCP73831", "tps62162": "TPS62162",
    "ap2112": "AP2112K-3.3", "mcp2515": "MCP2515",
    "usb-c": "USB4085-GF-A", "usb c": "USB4085-GF-A", "usbc": "USB4085-GF-A",
}

# phrase -> required capability
CAPABILITY_PHRASES = {
    "environmental sens": "environmental", "temperature": "temperature",
    "humidity": "humidity", "pressure": "pressure", "gas": "gas", "voc": "voc",
    "air quality": "air_quality",
    "current sens": "current_sense", "current monitor": "current_sense",
    "power monitor": "power_monitor",
    "accelerom": "accelerometer", "motion": "motion",
    "rtc": "rtc", "real-time clock": "rtc", "real time clock": "rtc",
    "spi flash": "spi_flash", "flash": "flash", "storage": "storage",
    "rs485": "rs485", "rs-485": "rs485",
    "led driver": "led_driver", "shift register": "shift_register",
    "addressable led": "addressable_led", "neopixel": "addressable_led",
    "motor driver": "motor_driver", "dc motor": "dc_motor",
    "battery charg": "battery_charger",
    "usb-c power": "usb_c_power", "usb c power": "usb_c_power",
    "ethernet": "ethernet", "can bus": "can", "canbus": "can",
}

# what capabilities an unsupported part is understood to represent, so recovery
# can preserve intent (matches the user's BME688 -> temp/humidity/pressure example)
PART_INTENT = {
    "BME688": ["temperature", "humidity", "pressure", "gas", "voc"],
    "BME680": ["temperature", "humidity", "pressure", "gas", "voc"],
}


def _blank_intent():
    return {
        "product_goal": "", "functional_requirements": [],
        "required_capabilities": [], "optional_capabilities": [],
        "exact_part_requests": [],       # [{mpn, must_substitute, intended_capabilities}]
        "acceptable_substitutions": True,
        "selected_architecture": None,
        "mcu": {"family": None, "programming": [], "requirements": []},
        "power": {"source": None, "rails": [], "requirements": []},
        "battery": {"required": False},
        "sensors": [], "radios": [], "buses": [], "connectors": [],
        "motor_drivers": [], "analog": [], "digital_io": [],
        "board_size": None, "layer_count": None, "cost_target": None,
        "manufacturing_constraints": [], "testability": [],
        "firmware": {"programming": [], "debug": [], "requirements": []},
        "fl1_validation": {"required": False, "requirements": []},
        "unsupported_or_risky": [],      # requests flagged as risky up front
    }


def parse_intent(prompt):
    di = _blank_intent()
    p = prompt.lower()

    m = re.search(r"(?:build|design|make)\s+an?\s+(.+?)(?:\s+with\b|\.|$)", p)
    if m:
        di["product_goal"] = m.group(1).strip()

    # MCU
    for fam in ("rp2040", "stm32", "esp32", "nrf52", "samd21"):
        if fam in p:
            di["mcu"]["family"] = fam.upper()
            break

    # exact part requests (skip ones that appear inside an "unsupported ..." clause,
    # handled below)
    for alias, mpn in PART_ALIASES.items():
        if alias in p and not _in_unsupported_clause(p, alias):
            _add_part(di, mpn, must_substitute=False)

    # the "unsupported <something> that must be substituted" construct — model it
    # as a real part request the resolver will find unsupported, with its intent
    # preserved for the recovery loop.
    for m in re.finditer(r"(?:one\s+)?unsupported\s+([\w\s\-]+?)\s+(?:sensor|part|component|interface|regulator)?"
                         r"\s*(?:that\s+must\s+be\s+substituted|if\s+needed|which\s+is\s+unsupported)?", p):
        phrase = m.group(1).strip()
        if "environ" in phrase or "gas" in phrase or "voc" in phrase or "sensor" in phrase:
            _add_part(di, "BME688", must_substitute=True,
                      intended=PART_INTENT["BME688"])
            di["unsupported_or_risky"].append(
                {"request": "BME688 (unsupported environmental sensor)",
                 "reason": "flagged unsupported in the prompt; substitute preserving intent"})

    # capabilities
    for phrase, cap in CAPABILITY_PHRASES.items():
        if phrase in p and cap not in di["required_capabilities"]:
            di["required_capabilities"].append(cap)

    # power
    if "usb-c" in p or "usb c" in p:
        di["power"]["source"] = "usb_c"
        di["power"]["rails"] = ["+5V", "+3V3"]
    if "battery" in p:
        di["battery"]["required"] = True

    # buses (from capabilities/parts)
    for cap, bus in (("rs485", "RS485"), ("spi_flash", "SPI"), ("shift_register", "SPI"),
                     ("current_sense", "I2C"), ("environmental", "I2C")):
        if cap in di["required_capabilities"] and bus not in di["buses"]:
            di["buses"].append(bus)

    # firmware / programming / debug
    if "swd" in p:
        di["mcu"]["programming"].append("SWD")
        di["firmware"]["programming"].append("SWD")
    if "uart debug" in p or "debug uart" in p or ("uart" in p and "debug" in p):
        di["firmware"]["debug"].append("UART")
        if "UART" not in di["buses"]:
            di["buses"].append("UART")

    # FL-1 validation
    if "fl-1" in p or "fl1" in p or "validation" in p:
        di["fl1_validation"]["required"] = True

    # unsupported/risky standalone requests (e.g. Ethernet)
    if "ethernet" in p:
        di["unsupported_or_risky"].append(
            {"request": "Ethernet", "reason": "needs an unsupported PHY + differential routing"})

    # functional requirements summary (human-readable)
    di["functional_requirements"] = [
        c.replace("_", " ") for c in di["required_capabilities"]]
    return di


def _add_part(di, mpn, must_substitute=False, intended=None):
    for e in di["exact_part_requests"]:
        if e["mpn"] == mpn:
            return
    di["exact_part_requests"].append({
        "mpn": mpn, "must_substitute": must_substitute,
        "intended_capabilities": intended or [],
    })


def _in_unsupported_clause(p, alias):
    # true if `alias` appears only inside an "unsupported ..." clause
    idx = p.find(alias)
    if idx < 0:
        return False
    window = p[max(0, idx - 40):idx]
    return "unsupported" in window and "substitut" in p[idx:idx + 60]
