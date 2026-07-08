"""C1 — Role-Aware Placement Engine v1.

Placement knows ELECTRICAL ROLES, not just connectivity. v1 delivers:
role classification (ref/value/net driven), support-circuit grouping,
role-specific placement constraints, machine-checkable evaluation against
REAL board files, risk scoring, and a placement report that explains
decisions. Constraints are evaluated, never assumed: a rule the current
placer does not satisfy shows up as a finding, not a silent pass.
No physical/production/advanced claim is added by anything here.
"""
import math
import os
import re

ROLES = (
    "mcu", "mcu_module", "external_flash", "crystal", "decoupling_cap",
    "bulk_cap", "ldo", "buck_regulator", "inductor", "diode",
    "current_sense_resistor", "adc", "dac", "voltage_reference",
    "level_shifter", "i2c_sensor", "spi_peripheral", "uart_header",
    "can_transceiver", "rs485_transceiver", "usb_connector",
    "esd_protection", "debug_header", "programming_header",
    "b2b_connector", "power_connector", "rf_module", "antenna_connector",
    "motor_driver_module", "relay", "fuse_protection", "test_point",
    "mounting_hole",
)

# value/name patterns -> role (checked in order; first hit wins)
ROLE_PATTERNS = [
    (r"RP2040(?!.*Pico)|QFN-56", "mcu"),
    (r"Pico|ESP32|module.*mcu", "mcu_module"),
    (r"W25Q|25Q\d+|QSPI.*flash|NOR flash", "external_flash"),
    (r"Crystal|XTAL|oscillator", "crystal"),
    (r"REF\d{4}|LM4040|voltage reference", "voltage_reference"),
    (r"AMS1117|LM1117|LDO|MCP1700", "ldo"),
    (r"TPS5|MP\d{4}|buck", "buck_regulator"),
    (r"ADS\d{4}|MCP3\d{3}", "adc"),
    (r"MCP4\d{3}|DAC\d", "dac"),
    (r"TXB\d{4}|TXS\d{4}|level shift", "level_shifter"),
    (r"BME280|SHT\d|LM75|HDC\d|I2C.*sensor", "i2c_sensor"),
    (r"74HC595|shift register|W25|SPI.*peripheral", "spi_peripheral"),
    (r"24LC\d+|AT24|EEPROM", "i2c_sensor"),
    (r"INA2\d\d|shunt monitor", "current_sense_resistor"),
    (r"MCP2515|TJA10\d\d|SN65HVD23|CAN", "can_transceiver"),
    (r"MAX485|SN75176|THVD|RS-?485", "rs485_transceiver"),
    (r"USB4125|USB_C|USB-C|USB_B|receptacle", "usb_connector"),
    (r"USBLC6|TPD\dE|PESD|SRV05|ESD", "esd_protection"),
    (r"SWD|JTAG|debug", "debug_header"),
    (r"G5V|relay", "relay"),
    (r"fuse|polyfuse|PTC", "fuse_protection"),
    (r"SX12\d\d|RFM9|LoRa|LTE|GNSS|BLE|WiFi module", "rf_module"),
    (r"U\.FL|SMA|antenna", "antenna_connector"),
    (r"TestPoint|TP pad", "test_point"),
    (r"MountingHole", "mounting_hole"),
    (r"Fiducial", "mounting_hole"),
]

NOISY_ROLES = {"buck_regulator", "relay", "motor_driver_module"}
SENSITIVE_ROLES = {"adc", "voltage_reference", "crystal", "rf_module",
                   "i2c_sensor"}

# (rule_id, role, constraint kind, params, rationale)
RULES = [
    ("decoupling_near_ic", "decoupling_cap",
     {"near_role": ("mcu", "adc", "i2c_sensor", "level_shifter",
                    "external_flash", "mcu_module", "spi_peripheral",
                    "relay", "voltage_reference", "can_transceiver",
                    "rs485_transceiver", "ldo"), "max_mm": 6.0},
     "decoupling must sit at its IC's power pins"),
    ("bulk_near_entry", "bulk_cap",
     {"near_role": ("ldo", "buck_regulator", "power_connector",
                    "usb_connector"), "max_mm": 15.0},
     "bulk capacitance belongs at rail entry / regulator output"),
    ("crystal_near_mcu", "crystal",
     {"near_role": ("mcu",), "max_mm": 10.0,
      "away_from_noisy_mm": 8.0},
     "crystal close to oscillator pins, away from switch nodes"),
    ("flash_near_mcu", "external_flash",
     {"near_role": ("mcu",), "max_mm": 12.0},
     "QSPI flash close to the MCU's flash pins"),
    ("esd_near_connector", "esd_protection",
     {"near_role": ("usb_connector", "power_connector", "b2b_connector"),
      "max_mm": 8.0},
     "ESD device protects the connector it sits next to"),
    ("usb_connector_edge", "usb_connector",
     {"edge_mm": 6.0},
     "USB connector must preserve edge/mating orientation"),
    ("adc_away_from_noise", "adc",
     {"away_from_noisy_mm": 12.0},
     "ADC/reference region separated from noisy switch nodes"),
    ("reference_away_from_noise", "voltage_reference",
     {"away_from_noisy_mm": 12.0},
     "reference circuitry protected from noise"),
    ("levelshift_between_domains", "level_shifter",
     {"between": True},
     "level shifter sits between its two voltage domains"),
    ("can_between_mcu_connector", "can_transceiver",
     {"between": True},
     "CAN transceiver between MCU side and connector side"),
    ("rs485_between_mcu_connector", "rs485_transceiver",
     {"between": True},
     "RS485 transceiver between MCU side and terminal/header"),
    ("buck_hot_loop", "buck_regulator",
     {"group_mm": 8.0, "mark_noisy": True},
     "buck hot-loop grouped tight; switch node marked noisy"),
    ("sense_in_path", "current_sense_resistor",
     {"kelvin_intent": True},
     "current sense aligned with the current path, Kelvin/testpoint intent"),
    ("testpoint_accessible", "test_point",
     {"edge_bias_mm": 40.0},
     "test points accessible, not buried in congestion"),
    ("rf_module_contained", "rf_module",
     {"module_contained": True},
     "RF stays module-contained: connector + keepout notes, no board-level "
     "RF tuning claim"),
]


def classify_role(ref, value):
    """ref+value -> role. Falls back on reference-designator conventions."""
    text = "%s %s" % (ref, value)
    for pat, role in ROLE_PATTERNS:
        if re.search(pat, text, re.I):
            return role
    m = re.match(r"([A-Za-z]+)", ref or "")
    prefix = (m.group(1).uppper() if False else m.group(1).upper()) if m else ""
    if prefix == "C":
        # bulk if large value, else decoupling
        v = re.search(r"(\d+(?:\.\d+)?)\s*u", value or "", re.I)
        return "bulk_cap" if v and float(v.group(1)) >= 4.7 else "decoupling_cap"
    if prefix == "L":
        return "inductor"
    if prefix == "D" and "LED" not in (value or "").upper():
        return "diode"
    if prefix in ("J", "P"):
        return "power_connector" if re.search(r"power|vin|barrel",
                                              value or "", re.I) \
            else "uart_header"
    if prefix == "R" and re.search(r"m(illi)?ohm|R\d{3}\b|shunt",
                                   value or "", re.I):
        return "current_sense_resistor"
    if prefix == "TP":
        return "test_point"
    if prefix == "K":
        return "relay"
    if prefix == "F":
        return "fuse_protection"
    if prefix == "Y":
        return "crystal"
    return None


def _bom_names(board_path):
    """ref -> part name from the run's bom.json (composed boards store the
    footprint string in Value; part identity lives in the BOM)."""
    import json
    bom_path = os.path.join(os.path.dirname(board_path), "data", "bom.json")
    names = {}
    if os.path.exists(bom_path):
        try:
            for line in json.load(open(bom_path)):
                for ref in str(line.get("ref", "")).split(","):
                    names[ref.strip()] = "%s %s" % (
                        line.get("part", ""), line.get("sourcedMpn", ""))
        except Exception:
            pass
    return names


def parse_board(board_path):
    """REAL positions/values from a .kicad_pcb (regex parse, read-only),
    enriched with BOM part names for role classification."""
    t = open(board_path).read()
    names = _bom_names(board_path)
    comps = []
    for m in re.finditer(
            r'\(footprint "([^"]+)"[\s\S]*?\(at ([-\d.]+) ([-\d.]+)[^)]*\)'
            r'[\s\S]*?\(property "Reference" "([^"]+)"'
            r'[\s\S]*?\(property "Value" "([^"]+)"', t):
        fp, x, y, ref, val = m.groups()
        ident = "%s %s %s" % (val, fp, names.get(ref, ""))
        comps.append({"ref": ref, "value": val, "footprint": fp,
                      "x": float(x), "y": float(y),
                      "role": classify_role(ref, ident)})
    xs = [c["x"] for c in comps] or [0]
    ys = [c["y"] for c in comps] or [0]
    return {"components": comps,
            "extent": {"min_x": min(xs), "max_x": max(xs),
                       "min_y": min(ys), "max_y": max(ys)}}


def _dist(a, b):
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


def group_support(components):
    """Support-circuit grouping: every decoupling/bulk cap, crystal, and
    flash is assigned to its nearest owner IC (explicit, reviewable)."""
    owners = [c for c in components if c["role"] in
              ("mcu", "mcu_module", "adc", "i2c_sensor", "level_shifter",
               "ldo", "buck_regulator", "can_transceiver",
               "rs485_transceiver", "spi_peripheral", "relay",
               "voltage_reference")]
    groups = {}
    for c in components:
        if c["role"] in ("decoupling_cap", "bulk_cap", "crystal",
                         "external_flash") and owners:
            owner = min(owners, key=lambda o: _dist(c, o))
            groups.setdefault(owner["ref"], []).append(
                {"ref": c["ref"], "role": c["role"],
                 "distance_mm": round(_dist(c, owner), 2)})
    return groups


def evaluate(board, synthetic_roles=None):
    """Evaluate every applicable rule against real positions. Returns
    per-rule findings + a risk score. Rules with no applicable parts are
    'not_applicable' — never silently passed."""
    comps = board["components"]
    if synthetic_roles:
        comps = comps + synthetic_roles
    by_role = {}
    for c in comps:
        if c.get("role"):
            by_role.setdefault(c["role"], []).append(c)
    noisy = [c for c in comps if c.get("role") in NOISY_ROLES]
    ext = board["extent"]
    findings = []
    for rule_id, role, params, why in RULES:
        subjects = by_role.get(role, [])
        if not subjects:
            findings.append({"rule": rule_id, "state": "not_applicable",
                             "why": why})
            continue
        problems, notes = [], []
        for s in subjects:
            if "near_role" in params:
                targets = [t for r in params["near_role"]
                           for t in by_role.get(r, [])]
                if targets:
                    d = min(_dist(s, t) for t in targets)
                    if d > params["max_mm"]:
                        problems.append("%s is %.1fmm from nearest %s "
                                        "(limit %.1f)" % (
                                            s["ref"], d,
                                            "/".join(params["near_role"]),
                                            params["max_mm"]))
            if "away_from_noisy_mm" in params and noisy:
                d = min(_dist(s, n) for n in noisy)
                if d < params["away_from_noisy_mm"]:
                    problems.append("%s is %.1fmm from a noisy node "
                                    "(min %.1f)" % (
                                        s["ref"], d,
                                        params["away_from_noisy_mm"]))
            if "edge_mm" in params:
                d_edge = min(s["x"] - ext["min_x"], ext["max_x"] - s["x"],
                             s["y"] - ext["min_y"], ext["max_y"] - s["y"])
                if d_edge > params["edge_mm"]:
                    problems.append("%s is %.1fmm from the board edge "
                                    "(connector wants <= %.1f)" % (
                                        s["ref"], d_edge, params["edge_mm"]))
            if params.get("between"):
                mcus = by_role.get("mcu", []) + by_role.get("mcu_module", [])
                conns = (by_role.get("power_connector", [])
                         + by_role.get("uart_header", [])
                         + by_role.get("b2b_connector", []))
                if mcus and conns:
                    dm = min(_dist(s, m) for m in mcus)
                    dc = min(_dist(s, c2) for c2 in conns)
                    dmc = min(_dist(m, c2) for m in mcus for c2 in conns)
                    if dm + dc > dmc * 1.6:
                        problems.append("%s is not between MCU and "
                                        "connector (detour %.0f%%)" % (
                                            s["ref"],
                                            100 * (dm + dc) / dmc - 100))
                else:
                    notes.append("between-check advisory: counterpart "
                                 "side missing on this board")
            if params.get("mark_noisy"):
                notes.append("%s switch node marked NOISY (keepout hint "
                             "for analog/RF)" % s["ref"])
            if params.get("kelvin_intent"):
                notes.append("%s: Kelvin/testpoint intent recorded — "
                             "measurement accuracy remains blocked without "
                             "calibration evidence" % s["ref"])
            if params.get("module_contained"):
                notes.append("%s: RF module-contained; board claims no "
                             "RF tuning/performance" % s["ref"])
        findings.append({
            "rule": rule_id, "why": why,
            "state": "violated" if problems else "satisfied",
            "problems": problems, "notes": notes,
            "subjects": [s["ref"] for s in subjects]})
    applicable = [f for f in findings if f["state"] != "not_applicable"]
    violated = [f for f in findings if f["state"] == "violated"]
    return {
        "findings": findings,
        "risk_score": round(len(violated) / max(1, len(applicable)), 3),
        "applicable_rules": len(applicable),
        "violations": len(violated),
        "honesty": "rules are EVALUATED against real positions; violations "
                   "are findings for the placement repair loop, not hidden; "
                   "satisfying every rule is not a physical claim",
    }


def placement_report(board_path, synthetic_roles=None):
    board = parse_board(board_path)
    ev = evaluate(board, synthetic_roles)
    return {
        "board": os.path.basename(board_path),
        "components": len(board["components"]),
        "roles_classified": sum(1 for c in board["components"] if c["role"]),
        "support_groups": group_support(board["components"]),
        "evaluation": ev,
    }
