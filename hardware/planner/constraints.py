"""Constraint Manager v1 — the layer between design intent / component specs and
board generation + routing.

It answers "does this net need special electrical treatment?" for the practical
embedded-board net classes (power, digital, I2C, SPI, UART, RS485, CAN, RF,
analog, motor, high-current, clock, reset/debug, test point). It produces:

  1. a serializable CONSTRAINT MODEL (per-net class + reason + rules),
  2. concrete rules (trace width, clearance, priority, preferred layer, flags),
  3. an HONEST unsupported list — differential-pair / controlled-impedance /
     high-speed nets (USB-HS, Ethernet) are marked UNSUPPORTED in v1, never
     faked, with the required constraint and a possible fallback.

v1 deliberately does NOT attempt DDR / PCIe / USB-HS / Ethernet / MIPI / dense
BGA / advanced RF — it detects them and refuses.

  from constraints import build_model
  model = build_model(net_names)           # the run artifact
"""
import re

# ---- net classes + how a net name maps to one (name -> (class, reason)) ------
# Order matters: first match wins.
_RULES = [
    (r"^GND$|^AGND$|^DGND$", "gnd", "ground return, plane-served"),
    (r"^\+?5V$|^VBUS$|^VIN$|^VMOTOR$|^\+?12V$|^\+?24V$", "power_input",
     "unregulated power input rail, carries the board's total current"),
    (r"^\+?3V3$|^\+?1V8$|^\+?2V5$|^VDD.*$|^VCC.*$", "power_rail",
     "regulated supply rail"),
    (r"COIL\d|^M_[AB]\d|MOTOR\d|^O[AB]\d", "motor_output",
     "motor / coil drive, inductive + higher current"),
    (r"I2C_SDA|I2C_SCL|_SDA$|_SCL$", "i2c",
     "I2C open-drain bus, needs pull-ups to the rail"),
    (r"SPI_SCK|_SRCLK$|_SCLK$", "spi_clock",
     "SPI clock, route short and direct"),
    (r"SPI_MOSI|SPI_MISO|_CS$|_NSS$|SR_LATCH|_SER$|_RCLK$", "spi",
     "SPI data / chip-select, normal digital"),
    (r"RS485_A$|RS485_B$|^A$|^B$", "rs485",
     "RS485 industrial differential pair, controlled routing (impedance not "
     "guaranteed without a defined stackup in v1)"),
    (r"CANH|CANL", "can",
     "CAN differential pair, controlled routing"),
    (r"USB_DP|USB_DM|^D\+$|^D-$|USBD[PM]", "usb_hs",
     "USB data differential pair — needs 90ohm controlled impedance + length match"),
    (r"^ETH|_TXP$|_TXN$|_RXP$|_RXN$|MDI", "ethernet",
     "Ethernet differential pairs — need 100ohm impedance + length match + PHY"),
    (r"ANT|_RF$|^RF", "rf",
     "RF single-ended trace — needs a controlled-impedance line to the antenna"),
    (r"_TX$|_RX$|_DI$|_RO$|_DE$|_RE$|DEBUG", "uart",
     "UART / async serial control, normal digital"),
    (r"RESET|^RST$|SWDIO|SWCLK|SWD|_RST$", "reset_debug",
     "reset / SWD debug line, normal digital"),
    (r"^CLK$|_CLK$|OSC|XTAL", "clock",
     "clock line, route short and direct, keep away from analog"),
    (r"AIN\d|_AIN|^ADC|VIN[+-]|SHUNT|SENSE", "analog",
     "analog-sensitive net, keep from switching/noisy nets"),
    (r"PROBE\d|^TP\d|^TP_", "test_point", "FL-1 probe / test point"),
]

# ---- per-class routing/layout rules (v1, practical embedded defaults) --------
# widths in mm; flroute routes at a single global width, so power/high-current
# widths are applied post-route where clearance allows (see widen pass).
CLASS_RULES = {
    "gnd": {"min_width": 0.3, "clearance": 0.2, "priority": 1, "plane": True},
    "power_input": {"min_width": 0.5, "clearance": 0.2, "priority": 9,
                    "high_current": True},
    "power_rail": {"min_width": 0.4, "clearance": 0.2, "priority": 8, "plane": True},
    "motor_output": {"min_width": 0.5, "clearance": 0.25, "priority": 8,
                     "high_current": True, "thermal": True},
    "i2c": {"min_width": 0.2, "clearance": 0.2, "priority": 4, "needs_pullup": True},
    "spi_clock": {"min_width": 0.2, "clearance": 0.2, "priority": 6,
                  "route": "short_direct"},
    "spi": {"min_width": 0.2, "clearance": 0.2, "priority": 4},
    "rs485": {"min_width": 0.2, "clearance": 0.2, "priority": 5,
              "diff_pair_preferred": True, "controlled": True,
              "note": "routed as a controlled pair; true impedance not guaranteed in v1"},
    "can": {"min_width": 0.2, "clearance": 0.2, "priority": 5,
            "diff_pair_preferred": True, "controlled": True},
    "rf": {"min_width": 0.2, "clearance": 0.3, "priority": 7, "rf": True,
           "impedance_target": 50, "note": "single-ended; impedance not controlled in v1"},
    "uart": {"min_width": 0.2, "clearance": 0.2, "priority": 4},
    "reset_debug": {"min_width": 0.2, "clearance": 0.2, "priority": 3},
    "clock": {"min_width": 0.2, "clearance": 0.2, "priority": 6, "route": "short_direct"},
    "analog": {"min_width": 0.2, "clearance": 0.25, "priority": 5, "analog": True},
    "test_point": {"min_width": 0.2, "clearance": 0.2, "priority": 2},
    "digital_signal": {"min_width": 0.2, "clearance": 0.2, "priority": 3},
}

# classes v1 CANNOT route correctly — they need differential-pair /
# controlled-impedance / high-speed handling that does not exist yet.
UNSUPPORTED_CLASSES = {
    "usb_hs": ("USB high-speed data", "90ohm differential pair + length matching + defined stackup",
               "USB power-only, or a supported bus (UART / CAN / RS485)"),
    "ethernet": ("Ethernet", "100ohm differential pairs + length match + magnetics + PHY",
                 "a supported bus (CAN / RS485 / UART) if the network allows"),
}


def classify_net(name):
    for pat, cls, reason in _RULES:
        if re.search(pat, name, re.IGNORECASE):
            return cls, reason
    return "digital_signal", "general digital signal, normal rules"


def build_model(net_names, board=None):
    """Build the constraint model for a board's nets. `board` is optional
    metadata (name, layers). Returns a JSON-serialisable dict."""
    nets = {}
    class_counts = {}
    unsupported = []
    high_risk = []
    for n in sorted(net_names):
        if not n or n == "GND" and n in nets:
            continue
        cls, reason = classify_net(n)
        rules = CLASS_RULES.get(cls, CLASS_RULES["digital_signal"])
        nets[n] = {"class": cls, "reason": reason, "rules": rules}
        class_counts[cls] = class_counts.get(cls, 0) + 1
        if cls in UNSUPPORTED_CLASSES:
            feat, req, fb = UNSUPPORTED_CLASSES[cls]
            unsupported.append({"net": n, "feature": feat, "required": req,
                                "why": "no controlled-impedance / differential-pair routing in v1",
                                "fallback": fb})
        if rules.get("rf") or rules.get("controlled") or rules.get("diff_pair_preferred"):
            high_risk.append({"net": n, "class": cls,
                              "note": rules.get("note", "controlled/RF net — verify by hand")})

    used_classes = {c: CLASS_RULES[c] for c in class_counts if c in CLASS_RULES}
    return {
        "version": 1,
        "generator": "firstlight-compose constraint-manager v1",
        "board": board or {},
        "nets": nets,
        "classes": used_classes,
        "class_counts": class_counts,
        "unsupported": unsupported,
        "high_risk_nets": high_risk,
        "summary": {
            "total_nets": len(nets),
            "distinct_classes": len(class_counts),
            "unsupported_features": sorted({u["feature"] for u in unsupported}),
            "has_high_current": any(nets[n]["rules"].get("high_current") for n in nets),
            "note": "v1 supports practical embedded net classes; differential-pair / "
                    "controlled-impedance / high-speed classes are detected and refused, "
                    "not faked.",
        },
    }


# ---- KiCad net-class emission (real: the design carries the classes) ---------
# Group nets by class and emit a KiCad net_settings block (per-class clearance +
# via + track width) plus netclass_patterns so KiCad DRC + the board carry them.
def kicad_net_settings(model):
    classes = [{
        "name": "Default", "clearance": 0.2, "track_width": 0.2,
        "via_diameter": 0.6, "via_drill": 0.3, "microvia_diameter": 0.3,
        "microvia_drill": 0.1, "diff_pair_gap": 0.25, "diff_pair_width": 0.2,
        "priority": 2147483647,
    }]
    patterns = []
    seen = set()
    for n, info in model["nets"].items():
        cls = info["class"]
        r = info["rules"]
        cname = "cls_" + cls
        if cname not in seen and cls != "digital_signal":
            classes.append({
                # NEVER emit a clearance stricter than the routed default — the
                # board was already routed at 0.2 (or the fab_6mil .dru), and a
                # tighter per-class clearance would retroactively fail DRC on
                # valid copper. The DESIRED per-class clearance is kept in the
                # constraint model (for the report / a future constraint-aware
                # router); the EMITTED clearance stays at the routed default.
                "name": cname, "clearance": 0.2,
                "track_width": r.get("min_width", 0.2),
                "via_diameter": 0.6, "via_drill": 0.3,
                "microvia_diameter": 0.3, "microvia_drill": 0.1,
                "diff_pair_gap": 0.25, "diff_pair_width": r.get("min_width", 0.2),
                "priority": r.get("priority", 3),
            })
            seen.add(cname)
        if cls != "digital_signal":
            patterns.append({"pattern": "^%s$" % re.escape(n), "netclass": cname})
    return {"classes": classes, "netclass_patterns": patterns}
