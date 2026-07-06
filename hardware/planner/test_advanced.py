"""Advanced-routing regression (Phase 13 items 9-14) — fast checks over the
advanced constraint model. Never claims impedance/high-speed support; asserts the
HONEST unsupported behavior.

  python3 test_advanced.py
"""
import sys

import advanced_constraints as ac

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


# 9. USB diff-pair constraints are generated
u = ac.build_model(["USB_DP", "USB_DM", "VBUS", "GND"], [], {"capabilities": ["usb"]})
usb = [p for p in u["differential_pairs"] if p["class"] == "usb"]
check("9 USB diff-pair constraints generated",
      usb and usb[0]["target_impedance_ohm"] == 90 and usb[0]["high_speed"],
      "pairs=%d" % len(usb))

# high-speed USB is honestly unsupported (not faked)
check("USB high-speed -> unsupported_by_router (honest)",
      not u["summary"]["advanced_routable"] and u["unsupported_constraints"],
      "routable=%s" % u["summary"]["advanced_routable"])

# 10. Ethernet diff-pair constraints are generated
e = ac.build_model(["ETH_TXP", "ETH_TXN", "ETH_RXP", "ETH_RXN"], [], {"capabilities": ["ethernet"]})
eth = [p for p in e["differential_pairs"] if p["class"] == "ethernet"]
check("10 Ethernet diff-pair constraints generated",
      len(eth) == 2 and all(p["target_impedance_ohm"] == 100 for p in eth),
      "pairs=%d" % len(eth))

# 11. unknown impedance stackup reported honestly (never guaranteed)
imp = u["impedance_plan"]
check("11 impedance reported as estimate, not guaranteed",
      "estimate" in imp["guarantee"].lower() and "NONE" in imp["guarantee"]
      and imp["controlled_impedance_quote_required"])

# real microstrip math is in a sane range for 50 ohm
w = ac.microstrip_width_mm(50)
check("impedance math sane (50ohm width)", 0.15 < w < 0.6, "%.3f mm" % w)

# CAN is a controlled pair but NOT treated as high-speed (routable)
c = ac.build_model(["CANH", "CANL"], [], {})
canp = [p for p in c["differential_pairs"] if p["class"] == "can"]
check("CAN controlled, not high-speed (routable)",
      canp and not canp[0]["high_speed"] and c["summary"]["advanced_routable"])

# 13. analog layout constraints emitted for ADC/reference/shunt patterns
a = ac.build_model(["I2C_SDA"], [{"ref": "U2", "name": "ADS1115", "type": "adc.precision"}], {})
check("13 analog constraints emitted for ADC",
      any(r["rule"] == "quiet_zone" for r in a["analog_rules"]),
      "rules=%s" % [r["rule"] for r in a["analog_rules"]])

# 14. power layout constraints emitted for regulator/current-monitor patterns
p = ac.build_model(["+5V"], [{"ref": "U3", "name": "TPS62162"}], {}, net_classes={"power_input": 1})
check("14 power constraints emitted for regulator",
      any(r["rule"] == "regulator_hot_loop" for r in p["power_rules"])
      and any(r["rule"] == "high_current_trace" for r in p["power_rules"]),
      "rules=%s" % [r["rule"] for r in p["power_rules"]])

# keepout detected for an antenna module
k = ac.build_model([], [{"ref": "U1", "name": "ESP32", "footprint": "ESP32-S3-WROOM-1"}], {})
check("antenna keepout detected", any(x["type"] == "antenna_keepout" for x in k["keepouts"]))

npass = sum(1 for ok in checks if ok)
print("%d/%d advanced checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
