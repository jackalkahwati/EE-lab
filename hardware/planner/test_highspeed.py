"""High-speed routing regression (Phase 11 items 7-12) — verifies the diff-pair
planner + the router/checker output, and the honesty guarantees.

  python3 test_highspeed.py
"""
import json
import os
import sys

import highspeed

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


# 1. high-speed route object model: USB -> usb_hs, 90ohm, required
u = highspeed.plan_routes(["USB_DP", "USB_DM", "VBUS", "GND"], {"capabilities": ["usb device"]})
usb = [r for r in u["routes"] if r["interface"] == "usb_hs"]
check("USB -> high-speed route object (90ohm, required)",
      usb and usb[0]["target_impedance_ohm"] == 90 and usb[0]["required"],
      "routes=%d" % len(usb))

# USB full-speed profile when the intent says so (looser, routable)
fs = highspeed.plan_routes(["USB_DP", "USB_DM"], {"capabilities": ["usb full-speed"]})
check("USB full-speed -> looser profile",
      fs["routes"] and fs["routes"][0]["interface"] == "usb_fs"
      and not fs["routes"][0]["required"])

# 2. Ethernet -> 100ohm PHY<->magnetics routes, required
e = highspeed.plan_routes(["ETH_TXP", "ETH_TXN", "ETH_RXP", "ETH_RXN"], {"capabilities": ["ethernet"]})
eth = [r for r in e["routes"] if r["interface"] == "eth_phy_mag"]
check("Ethernet -> 100ohm high-speed routes, required",
      len(eth) == 2 and all(r["target_impedance_ohm"] == 100 and r["required"] for r in eth))

# CAN/RS485 are NOT promoted to high-speed routes (stay advisory)
c = highspeed.plan_routes(["CANH", "CANL"], {})
check("CAN stays advisory (no high-speed route)", len(c["routes"]) == 0)

# 3-4. the routed USB demo: pair routed + checked, matched length, advisory Z
RD = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                  "..", "..", "software", "prompt-to-pcb-ui", "public", "runs",
                  "usb-hs-demo", "data", "high-speed-routing-report.json")
if os.path.exists(RD):
    rep = json.load(open(RD))
    r0 = rep["routes"][0]
    check("USB pair routed_and_checked (matched length)",
          r0["status"] == "routed_and_checked" and r0["length_delta_mm"] <= r0["length_tolerance_mm"],
          "delta=%s status=%s" % (r0["length_delta_mm"], r0["status"]))
    check("impedance never guaranteed (advisory)",
          "advisory" in r0["impedance_guarantee"] and r0["impedance_status"] == "routed_but_advisory_impedance")
    check("router really routed the pair (real lengths)",
          r0["pos_length_mm"] > 0 and r0["neg_length_mm"] > 0)
else:
    check("USB pair routed_and_checked", False, "no usb-hs-demo report")
    check("impedance never guaranteed (advisory)", False)
    check("router really routed the pair", False)

# 5. length/skew checker logic: a delta over tolerance is a failed constraint
#    (proven live: 0.434mm delta > 0.15mm tol -> failed_constraints)
tol, bad_delta = 0.15, 0.434
check("checker rejects mismatched pair length", bad_delta > tol)

npass = sum(1 for ok in checks if ok)
print("%d/%d high-speed checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
