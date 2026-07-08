"""C6 — Expanded Enterprise Module Library v1.

Modules are the honest fast path to enterprise coverage: RF/cellular/
GNSS complexity stays INSIDE certified modules; the board supplies power,
buses, connectors, and keepouts. Every module primitive carries interface
type, voltage domain, required rails/support, footprint/source state
(proven-on-a-real-board vs candidate), firmware metadata, placement
constraints, blocked claims, and a validation workflow. Unknown
footprints block or demand review — nothing is silently substituted.
"""

def _m(name, interface, domain, rails, support, state, blocked,
       placement, validation, firmware=None, connectors=None, mpn=None):
    return {"module": name, "mpn_example": mpn, "interface": interface,
            "voltage_domain": domain, "required_rails": rails,
            "required_support": support,
            "connectors": connectors or [],
            "footprint_source_state": state,
            "firmware_metadata": firmware or {},
            "placement_constraints": placement,
            "blocked_claims": blocked,
            "validation_workflow": validation}


RF_BLOCKED = ["board_level_RF_performance", "antenna_performance",
              "regulatory_certification (module cert evidence required)",
              "link_budget", "EMC"]

MODULES = {
    "lora": _m("LoRa radio module", "spi/uart", "3V3", ["+3V3"],
               ["decoupling", "antenna keepout notes"],
               "PROVEN on compose lora-node boards",
               RF_BLOCKED,
               ["rf_module_contained (C1)", "antenna connector at edge"],
               ["power-on current", "SPI/UART comms check",
                "RF: module-contained; no board claim"],
               {"driver": "LoRa stack scaffold"},
               ["U.FL antenna connector"], "SX1276 module class"),
    "gnss": _m("GNSS module", "uart", "3V3", ["+3V3"],
               ["decoupling", "backup supply optional (evidence-gated)"],
               "PROVEN on compose gps-tracker class boards",
               RF_BLOCKED + ["position_accuracy (needs sky test)"],
               ["antenna connector at edge", "away from noisy nodes"],
               ["UART NMEA output check (bench)",
                "fix acquisition is a SKY test — not a bench claim"],
               {"protocol": "NMEA"}, ["U.FL/SMA antenna"], "NEO-M8 class"),
    "cellular": _m("LTE/cellular modem module", "uart/usb-fs", "3V8/3V3",
                   ["+3V8 or module-specific"],
                   ["bulk capacitance (burst current)", "SIM socket"],
                   "PROVEN on compose cellular-logger class boards",
                   RF_BLOCKED + ["carrier_certification"],
                   ["bulk caps near module (burst)",
                    "antenna keepout"],
                   ["registration is a network test — bench checks power/"
                    "UART only"], {"at_commands": True},
                   ["antenna connector", "SIM"], "SARA/EC2x class"),
    "wifi_ble": _m("Wi-Fi/BLE module", "spi/uart/sdio", "3V3", ["+3V3"],
                   ["decoupling"],
                   "candidate — footprint verification required per part",
                   RF_BLOCKED, ["rf_module_contained (C1)"],
                   ["power + host-bus check"], None, ["chip antenna "
                    "(module-contained) or U.FL"], "ESP32-WROOM class"),
    "imu": _m("IMU module", "i2c/spi", "3V3", ["+3V3"], ["decoupling"],
              "PROVEN (MPU6050 class on compose boards)",
              ["motion_accuracy (needs calibration evidence)"],
              ["away from vibration sources — review note"],
              ["WHO_AM_I register check"], None, None, "MPU6050 class"),
    "isolated_can": _m("Isolated CAN module/transceiver block", "can",
                       "3V3 + isolated side", ["+3V3", "ISO_5V (isolated)"],
                       ["isolated DC-DC (evidence-gated)",
                        "isolation barrier keepout"],
                       "candidate — isolation parts need footprint + "
                       "creepage review",
                       ["isolation_rating (creepage/clearance review + "
                        "evidence)", "ISO_11898_compliance"],
                       ["isolation barrier keepout is MANDATORY review"],
                       ["isolation continuity check (must be OPEN)"],
                       None, None, "ISO1050 class"),
    "rs485_block": _m("RS485 transceiver block", "rs485", "3V3/5V",
                      ["+3V3 or +5V"], ["termination/bias per C3 policy"],
                      "candidate — MAX485-class footprint verification "
                      "required",
                      ["modbus_protocol_correctness",
                       "network_length_rating"],
                      ["rs485_between_mcu_connector (C1)"],
                      ["A/B continuity", "DE/RE control"],
                      None, ["screw terminal"], "MAX485 class"),
    "adc_module": _m("ADC module", "i2c/spi", "3V3", ["+3V3"],
                     ["reference decoupling"],
                     "PROVEN (ADS1115 chip-down + module class)",
                     ["measurement_accuracy (calibration evidence "
                      "required)"],
                     ["adc_away_from_noise (C1)"],
                     ["I2C/SPI comms", "known-voltage sanity read "
                      "(NOT calibration)"], None, None, "ADS1115 class"),
    "dac_module": _m("DAC module", "i2c/spi", "3V3", ["+3V3"],
                     ["output buffering review"],
                     "candidate — footprint verification required",
                     ["output_accuracy (calibration evidence required)"],
                     ["away from noisy nodes"], ["comms + output sanity"],
                     None, None, "MCP4725 class"),
    "relay_module": _m("Relay block", "gpio", "coil domain (5V/12V)",
                       ["coil rail", "+3V3 logic"],
                       ["driver transistor", "flyback diode",
                        "contact-side clearance review"],
                       "PROVEN (G6K relay class on FL-1 boards)",
                       ["contact_current_rating (evidence)",
                        "switching_lifetime"],
                       ["contact side away from logic; clearance review"],
                       ["coil drive check", "contact continuity"],
                       None, None, "G6K/G5V class"),
    "power_module": _m("Power module (integrated regulator)", "power",
                       "input rail", ["VIN"], ["io caps per evidence"],
                       "candidate — module-specific footprint required",
                       ["efficiency_claim", "thermal_safety",
                        "power_integrity_claim"],
                       ["bulk_near_entry (C1)"],
                       ["output voltage check"], None, None,
                       "OKI-78SR class"),
    "motor_driver_low": _m("Motor driver module (LOW-RISK class only)",
                           "gpio/pwm", "logic + motor rail",
                           ["+3V3 logic", "VMOTOR <= 24V, <= 2A class"],
                           ["bulk capacitance", "flyback handling per "
                            "module datasheet"],
                           "candidate — module footprint verification "
                           "required",
                           ["current_capacity_guarantee", "thermal_safety",
                            "high_current_stage (BLOCKED — M9R)",
                            "motor_drive_readiness"],
                           ["noisy node marking (C1)",
                            "away from analog/RF"],
                           ["logic-side checks only on the bench"],
                           None, None, "DRV8833/TB6612 class"),
    "board_id_eeprom": _m("Board-ID EEPROM block", "i2c", "3V3", ["+3V3"],
                          ["pullups per shared bus", "WP strap per C2 "
                           "evidence"],
                          "PROVEN (24LC02 on FL-1 boards)",
                          [], ["near debug/service access"],
                          ["I2C scan + ID read"], None, None, "24LC02"),
    "debug_module": _m("Debug/programming header block", "swd/uart", "3V3",
                       ["+3V3"], [],
                       "PROVEN (SWD headers on bare-RP2040 boards)",
                       [], ["board edge (C1 testpoint access)"],
                       ["SWD continuity"], {"probe": "CMSIS-DAP class"},
                       ["2x5 1.27mm or 1x3 header"], None),
    "telemetry_pattern": _m("Telemetry module pattern (MCU+radio+sensor)",
                            "composite", "3V3", ["+3V3"],
                            ["per-member support"],
                            "pattern — composes PROVEN members",
                            RF_BLOCKED,
                            ["members keep their own C1 constraints"],
                            ["member-level checks"], None, None, None),
}


def get_module(name):
    m = MODULES.get(name)
    if not m:
        return {"error": "unknown module %s — unknown footprints BLOCK, "
                         "nothing is substituted silently" % name}
    return m


def compose_module_board(members):
    """Compose a module board contract: members must exist; candidate
    footprints make the BOARD review-required; blocked claims union."""
    mods, missing = [], []
    for name in members:
        m = MODULES.get(name)
        (mods if m else missing).append(m or name)
    if missing:
        return {"state": "blocked",
                "reason": "unknown modules: %s" % missing}
    candidates = [m["module"] for m in mods
                  if "candidate" in m["footprint_source_state"]]
    return {
        "state": "review_required" if candidates
                 else "composable_review_required",
        "members": [m["module"] for m in mods],
        "candidate_footprints_requiring_review": candidates,
        "blocked_claims": sorted({c for m in mods
                                  for c in m["blocked_claims"]}),
        "validation_workflow": [s for m in mods
                                for s in m["validation_workflow"]],
        "honesty": "module presence claims nothing about RF/accuracy/"
                   "certification; candidate footprints demand review "
                   "before any board generation",
    }
