"""MCU Capability Spec + seed library (Phase 1 + 2).

A structured, schema-validated spec of what an MCU can do, at the PHYSICAL PAD
level — because that is what board synthesis + pin allocation need (the symbol is
for ERC/BOM; the footprint pads carry the nets). Each spec records the fixed pads
(power / ground / reset / boot / debug / clock / USB) and, per capability
(gpio / adc / pwm / i2c / spi / uart / can / usb), the set of pads that can carry
it — taken from the real datasheet / module pinout, never invented.

HONESTY: routability depends on the footprint. Module (Pico, ESP32-S3-WROOM) and
DIP (ATmega328P) footprints route cleanly; bare fine-pitch QFP/QFN parts (STM32,
bare nRF/ESP, SAMD21) are marked status="partial" with the reason, because the
current router may not close them. A spec is never marked "supported" unless its
KiCad symbol AND footprint are real and the pad map is datasheet-accurate.

  from mcu_specs import MCU_SEEDS, validate_mcu
"""

MCU_SPEC_VERSION = "1.0"

CAPABILITIES = ("gpio", "adc", "pwm", "i2c_sda", "i2c_scl",
                "spi_sck", "spi_mosi", "spi_miso", "spi_cs",
                "uart_tx", "uart_rx", "can_tx", "can_rx", "usb_dp", "usb_dm")

# ---- schema (light, dependency-free) ----------------------------------------
_REQUIRED = ("manufacturer", "mpn", "family", "package", "kicad_symbol",
             "kicad_footprint", "voltage", "power_pins", "ground_pins",
             "reset_pins", "capable", "firmware_target", "status", "confidence")


def validate_mcu(spec):
    """Return (ok, errors). Structural + honesty checks."""
    errs = []
    for k in _REQUIRED:
        if k not in spec:
            errs.append("missing field: %s" % k)
    if spec.get("status") not in ("supported", "partial"):
        errs.append("status must be supported|partial")
    cap = spec.get("capable", {})
    for c in cap:
        if c not in CAPABILITIES:
            errs.append("unknown capability: %s" % c)
    # honesty: a "supported" MCU must name a real symbol + footprint + power/gnd
    if spec.get("status") == "supported":
        for k in ("kicad_symbol", "kicad_footprint"):
            if not spec.get(k):
                errs.append("supported MCU needs a real %s" % k)
        if not spec.get("power_pins") or not spec.get("ground_pins"):
            errs.append("supported MCU needs power+ground pads")
    # no pad may be both a power/ground/boot-avoid pad and an allocatable function
    reserved = set(map(str, spec.get("power_pins", []) + spec.get("ground_pins", [])
                       + spec.get("avoid", [])))
    for c, pads in cap.items():
        dup = reserved.intersection(map(str, pads))
        if dup:
            errs.append("capability %s uses reserved pad(s) %s" % (c, sorted(dup)))
    return (len(errs) == 0, errs)


def _spec(**kw):
    kw.setdefault("version", MCU_SPEC_VERSION)
    kw.setdefault("avoid", [])
    kw.setdefault("boot_pins", [])
    kw.setdefault("debug_pins", [])
    kw.setdefault("clock_pins", [])
    kw.setdefault("usb_pins", [])
    kw.setdefault("notes", "")
    return kw


# =============================================================================
# Seed library — 6 MCUs. Pads are footprint pad names (strings).
# =============================================================================

# ---- 1. RP2040 (Raspberry Pi Pico module) — PROVEN (the current golden path) -
# Pico module pinout; GP0..GP28 on the outer pads. RP2040 GPIO are flexible: any
# GPIO can PWM; I2C/SPI/UART are muxable across GPIO. ADC only on GP26/27/28.
_RP2040 = _spec(
    manufacturer="Raspberry Pi", mpn="RP2040", family="RP2040", package="Module (Pico)",
    kicad_symbol="MCU_RaspberryPi_and_Boards:Pico",
    kicad_footprint="RPi_Pico:RaspberryPi_Pico_SMD_HandSolder",
    voltage={"core": 3.3, "vin_min": 1.8, "vin_max": 5.5, "io": 3.3, "regulator_out": 3.3},
    power_pins=["40", "39"],          # VBUS(5V), VSYS
    ground_pins=["3", "8", "13", "18", "23", "28", "33", "38"],
    regulator_out={"pad": "36", "rail": "+3V3"},   # 3V3OUT
    reset_pins=["30"],                # RUN
    boot_pins=[],                     # BOOTSEL is on-module button
    debug_pins=["SWCLK", "SWDIO"],    # module debug pads
    clock_pins=[],                    # internal ROSC/XOSC on module
    usb_pins=[],                      # USB on the module's micro-USB
    capable={
        "gpio": ["1", "2", "4", "5", "6", "7", "9", "10", "11", "12", "14", "15",
                 "16", "17", "19", "20", "21", "22", "24", "25", "26", "27", "29",
                 "31", "32", "34"],
        "adc": ["31", "32", "34"],    # GP26, GP27, GP28
        "pwm": ["1", "2", "4", "5", "6", "7", "9", "10", "11", "12", "14", "15",
                "16", "17", "19", "20", "21", "22", "24", "25", "26", "27", "29"],
        "i2c_sda": ["6", "11", "31"], "i2c_scl": ["7", "12", "32"],
        "spi_sck": ["4", "24"], "spi_mosi": ["5", "25"], "spi_miso": ["6", "21"],
        "spi_cs": ["7", "22"],
        "uart_tx": ["1", "21"], "uart_rx": ["2", "22"],
        "can_tx": ["24"], "can_rx": ["25"],   # via PIO
    },
    interfaces_supported=["i2c", "spi", "spi_write_only", "uart", "pwm", "adc", "usb"],
    wireless=None, low_power=False, has_can="pio", has_usb=True,
    firmware_target="RP2040 (C SDK / MicroPython / Arduino-Pico)",
    programming=["SWD", "USB-BOOTSEL"],
    sourcing={"mpn": "RP2040", "lcsc": "C2040", "typical_cost_usd": 1.0},
    status="supported", confidence=0.9,
    provenance="RP2040 datasheet + Pico pinout; proven in the existing synth path",
)

# ---- 2. ESP32-S3-WROOM-1 module — Wi-Fi + BLE, routable module ---------------
# Module castellated pads. Most IOx are flexible (matrix mux): GPIO/PWM(LEDC)/
# I2C/SPI/UART can map to nearly any IO. ADC1 on IO1..IO10. USB on IO19/IO20.
# Strapping pins IO0/IO45/IO46 avoided for signals.
_ESP32S3 = _spec(
    manufacturer="Espressif", mpn="ESP32-S3-WROOM-1", family="ESP32-S3",
    package="Module (WROOM-1)",
    kicad_symbol="RF_Module:ESP32-S3-WROOM-1",
    kicad_footprint="RF_Module:ESP32-S3-WROOM-1",
    voltage={"core": 3.3, "vin_min": 3.0, "vin_max": 3.6, "io": 3.3},
    power_pins=["2"],                 # 3V3
    ground_pins=["1", "40", "41"],    # GND + thermal pad
    reset_pins=["3"],                 # EN
    boot_pins=["27"],                 # IO0 strapping (boot)
    avoid=["27", "45", "46"],         # strapping pins IO0/IO45/IO46
    debug_pins=["30", "31"],          # IO39/IO40 usable for JTAG
    usb_pins=["37", "38"],            # IO19(D-)/IO20(D+)
    capable={
        # WROOM-1 exposed IO pads (module pin numbers), strapping pins excluded
        "gpio": ["4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14",
                 "15", "16", "17", "18", "21", "33", "34", "35", "36", "38"],
        "adc": ["4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14"],  # ADC1 IO1..10
        "pwm": ["4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14",
                "15", "16", "17", "18", "21", "33", "34", "35", "36", "38"],
        "i2c_sda": ["4", "5", "6", "7", "8"], "i2c_scl": ["5", "6", "7", "8", "9"],
        "spi_sck": ["12", "13"], "spi_mosi": ["11", "14"], "spi_miso": ["13", "15"],
        "spi_cs": ["10", "16"],
        "uart_tx": ["37", "17"], "uart_rx": ["36", "18"],
    },
    interfaces_supported=["i2c", "spi", "spi_write_only", "uart", "pwm", "adc", "usb"],
    wireless=["wifi", "ble"], low_power=False, has_can="twai", has_usb=True,
    firmware_target="ESP32-S3 (ESP-IDF / Arduino-ESP32)",
    programming=["UART-bootloader", "USB-JTAG"],
    sourcing={"mpn": "ESP32-S3-WROOM-1-N8", "lcsc": "C2913202", "typical_cost_usd": 3.2},
    status="supported", confidence=0.75,
    provenance="ESP32-S3-WROOM-1 datasheet pinout; flexible IO matrix (pad->function "
               "sets are the datasheet-recommended defaults, not the only options)",
)

# ---- 3. nRF52840 (Raytac MDBT50Q module) — BLE, low power -------------------
# Module footprint routes; nRF52840 IO are fully flexible (any GPIO -> any
# function via GPIOTE/SPIM/TWIM/UARTE). P0.xx / P1.xx map to module pads.
_NRF52840 = _spec(
    manufacturer="Nordic / Raytac", mpn="MDBT50Q-1MV2 (nRF52840)", family="nRF52840",
    package="Module (Raytac MDBT50Q)",
    kicad_symbol="RF_Module:Raytac_MDBT50Q-1MV2",
    kicad_footprint="RF_Module:Raytac_MDBT50Q",
    voltage={"core": 3.3, "vin_min": 1.7, "vin_max": 3.6, "io": 3.3},
    power_pins=["31"],                # VDD
    ground_pins=["1", "30"],
    reset_pins=["19"],                # P0.18/RESET
    boot_pins=[],
    debug_pins=["24", "23"],          # SWDIO/SWCLK
    usb_pins=["16", "17"],            # D-/D+
    capable={
        "gpio": ["4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14",
                 "15", "20", "21", "22", "25", "26", "27", "28", "29"],
        "adc": ["4", "5", "6", "7", "27", "28", "29", "20"],  # AIN0..7 on P0.02..05,28..31
        "pwm": ["4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14",
                "15", "20", "21", "22", "25", "26", "27", "28", "29"],
        "i2c_sda": ["25", "8"], "i2c_scl": ["26", "9"],
        "spi_sck": ["12"], "spi_mosi": ["13"], "spi_miso": ["14"], "spi_cs": ["15"],
        "uart_tx": ["6"], "uart_rx": ["8"],
    },
    interfaces_supported=["i2c", "spi", "spi_write_only", "uart", "pwm", "adc", "usb"],
    wireless=["ble", "thread", "zigbee"], low_power=True, has_can=None, has_usb=True,
    firmware_target="nRF52840 (nRF Connect SDK / Zephyr / Arduino-nRF52)",
    programming=["SWD"],
    sourcing={"mpn": "MDBT50Q-1MV2", "lcsc": "C190794", "typical_cost_usd": 6.5},
    status="partial", confidence=0.55,
    notes="Module footprint routes, but the MDBT50Q symbol/footprint pad numbering "
          "needs verification against the specific KiCad library version before fab.",
    provenance="nRF52840 + Raytac MDBT50Q datasheet; flexible GPIO matrix",
)

# ---- 4. STM32F103C8T6 (LQFP-48) — industrial, CAN, ADC ----------------------
# Bare LQFP-48 (0.5mm pitch) -> FINE-PITCH, routing not guaranteed by the current
# router. Real symbol+footprint, datasheet-accurate pads. status=partial.
_STM32F103 = _spec(
    manufacturer="STMicroelectronics", mpn="STM32F103C8T6", family="STM32F1",
    package="LQFP-48",
    kicad_symbol="MCU_ST_STM32F1:STM32F103C8Tx",
    kicad_footprint="Package_QFP:LQFP-48_7x7mm_P0.5mm",
    voltage={"core": 3.3, "vin_min": 2.0, "vin_max": 3.6, "io": 3.3},
    power_pins=["24", "36", "48", "9"],   # VDD x3 + VDDA
    ground_pins=["23", "35", "47", "8"],  # VSS x3 + VSSA
    reset_pins=["7"],                     # NRST
    boot_pins=["44", "20"],               # BOOT0, BOOT1(PB2)
    avoid=["44", "20"],
    debug_pins=["34", "37"],              # SWDIO(PA13)/SWCLK(PA14)
    clock_pins=["5", "6"],                # OSC_IN/OSC_OUT
    usb_pins=["32", "33"],                # PA11(D-)/PA12(D+)
    capable={
        # LQFP-48: PA0..7=10..17, PB0..1=18..19, PB10..11=21..22, PB12..15=25..28,
        # PA8..10=29..31, PA15=38, PB3..9=39..46
        "gpio": ["10", "11", "12", "13", "14", "15", "16", "17", "18", "19",
                 "21", "22", "25", "26", "27", "28", "29", "30", "31", "38",
                 "39", "40", "41", "42", "43", "45", "46"],
        "adc": ["10", "11", "12", "13", "14", "15", "16", "17", "18", "19"],  # PA0..7,PB0..1
        "pwm": ["10", "11", "12", "13", "16", "17", "29", "30", "31", "42", "43", "45", "46"],
        "i2c_sda": ["43", "22"], "i2c_scl": ["42", "21"],   # I2C1 PB7/PB6, I2C2 PB11/PB10
        "spi_sck": ["15", "26"], "spi_mosi": ["17", "28"], "spi_miso": ["16", "27"],
        "spi_cs": ["14", "25"],   # SPI1 PA4..7, SPI2 PB12..15
        "uart_tx": ["30", "12"], "uart_rx": ["31", "13"],   # USART1 PA9/10, USART2 PA2/3
        "can_tx": ["33"], "can_rx": ["32"],   # CAN PA12/PA11 (shared with USB)
    },
    interfaces_supported=["i2c", "spi", "spi_write_only", "uart", "pwm", "adc", "can", "usb"],
    wireless=None, low_power=False, has_can=True, has_usb=True,
    firmware_target="STM32F1 (STM32Cube HAL / Arduino-STM32)",
    programming=["SWD"],
    sourcing={"mpn": "STM32F103C8T6", "lcsc": "C8734", "typical_cost_usd": 2.5},
    status="partial", confidence=0.5,
    notes="Bare LQFP-48 at 0.5mm pitch is fine-pitch — the current router may not "
          "close it. Spec + selection + allocation are real; board routing is the risk.",
    provenance="STM32F103x8 datasheet pinout (LQFP-48)",
)

# ---- 5. SAMD21G18A (TQFP-48) — partial, symbol availability varies ----------
_SAMD21 = _spec(
    manufacturer="Microchip", mpn="ATSAMD21G18A", family="SAMD21", package="TQFP-48",
    kicad_symbol="MCU_Microchip_SAMD:ATSAMD21G18A-AU",
    kicad_footprint="Package_QFP:TQFP-48_7x7mm_P0.5mm",
    voltage={"core": 3.3, "vin_min": 1.62, "vin_max": 3.63, "io": 3.3},
    power_pins=["4", "37", "44"], ground_pins=["3", "38", "43"],
    reset_pins=["25"], boot_pins=[], debug_pins=["30", "31"], usb_pins=["23", "24"],
    capable={
        "gpio": ["1", "2", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14",
                 "15", "16", "17", "18", "19", "20", "21", "22", "39", "40", "41", "42"],
        "adc": ["5", "6", "7", "8", "9", "10", "11", "12"],
        "pwm": ["1", "2", "5", "6", "7", "8", "11", "12", "13", "14"],
        "i2c_sda": ["21"], "i2c_scl": ["22"],
        "spi_sck": ["19"], "spi_mosi": ["17"], "spi_miso": ["18"], "spi_cs": ["16"],
        "uart_tx": ["9"], "uart_rx": ["10"],
    },
    interfaces_supported=["i2c", "spi", "spi_write_only", "uart", "pwm", "adc", "usb"],
    wireless=None, low_power=True, has_can=None, has_usb=True,
    firmware_target="SAMD21 (Arduino-SAMD / ASF)",
    programming=["SWD"],
    sourcing={"mpn": "ATSAMD21G18A-AU", "lcsc": "C71284", "typical_cost_usd": 2.8},
    status="partial", confidence=0.4,
    notes="TQFP-48 fine-pitch (routing risk) and the exact KiCad SAMD symbol name "
          "varies by library version — verify before fab. SERCOM pin muxing is "
          "flexible; the pad->function sets here are one valid mapping.",
    provenance="SAMD21G18A datasheet; SERCOM mux",
)

# ---- 6. ATmega328P (DIP-28) — classic, hand-solderable, routes easily -------
# Through-hole DIP -> trivially routable. Fixed peripheral pins (no deep mux):
# I2C on A4/A5, SPI on D10-13, UART on D0/D1, ADC A0-A5, PWM on 3/5/6/9/10/11.
_ATMEGA328 = _spec(
    manufacturer="Microchip", mpn="ATmega328P-PU", family="AVR", package="DIP-28",
    kicad_symbol="MCU_Microchip_ATmega:ATmega328P-PU",
    kicad_footprint="Package_DIP:DIP-28_W7.62mm",
    voltage={"core": 5.0, "vin_min": 1.8, "vin_max": 5.5, "io": 5.0},
    power_pins=["7", "20"],           # VCC, AVCC
    ground_pins=["8", "22"],          # GND, AGND
    reset_pins=["1"],                 # /RESET (PC6)
    boot_pins=[],
    # AVR ISP programming shares the hardware SPI pins (SCK/MISO/MOSI on
    # 19/18/17) + RESET — they are NOT separately reserved, the ISP header taps
    # the SPI bus nets. Only note the ISP pin roles here.
    debug_pins=[],
    isp_shares_spi=True,
    clock_pins=["9", "10"],           # XTAL1/XTAL2
    capable={
        "gpio": ["2", "3", "4", "5", "6", "11", "12", "13", "14", "15", "16",
                 "23", "24", "25", "26", "27", "28"],
        "adc": ["23", "24", "25", "26", "27", "28"],       # A0..A5 = PC0..PC5
        "pwm": ["5", "11", "12", "15", "16", "17"],        # D3,D5,D6,D9,D10,D11
        "i2c_sda": ["27"], "i2c_scl": ["28"],              # A4/A5 = PC4/PC5
        "spi_sck": ["19"], "spi_mosi": ["17"], "spi_miso": ["18"], "spi_cs": ["16"],
        "uart_tx": ["3"], "uart_rx": ["2"],                # D1/D0 = PD1/PD0
    },
    interfaces_supported=["i2c", "spi", "spi_write_only", "uart", "pwm", "adc"],
    wireless=None, low_power=True, has_can=None, has_usb=False,
    firmware_target="ATmega328P (Arduino / avr-gcc)",
    programming=["ISP", "UART-bootloader"],
    sourcing={"mpn": "ATmega328P-PU", "lcsc": "C14877", "typical_cost_usd": 2.2},
    status="supported", confidence=0.85,
    provenance="ATmega328P datasheet (DIP-28); fixed peripheral pin mapping",
)

MCU_SEEDS = {
    "RP2040": _RP2040,
    "ESP32-S3": _ESP32S3,
    "nRF52840": _NRF52840,
    "STM32F103": _STM32F103,
    "SAMD21": _SAMD21,
    "ATmega328P": _ATMEGA328,
}


def get_mcu(key):
    return MCU_SEEDS.get(key)


if __name__ == "__main__":
    for k, s in MCU_SEEDS.items():
        ok, errs = validate_mcu(s)
        n_gpio = len(s["capable"].get("gpio", []))
        print("%-11s %-22s %-9s gpio=%-3d %s%s" % (
            k, s["package"], s["status"], n_gpio,
            "OK" if ok else "INVALID", "" if ok else " " + "; ".join(errs)))
