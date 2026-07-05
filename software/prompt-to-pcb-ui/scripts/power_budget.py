"""Power budget: rail currents, regulator loss, battery life — from the BOM.

No SPICE, no vibes: worst-case and typical-duty current per rail from a
device table keyed on the BOM's real parts, then arithmetic. The +3V3 rail
rides the Pico's onboard buck (VSYS->3V3, ~85% efficient), so 3V3 load
reflects back into the 5V inlet at (3.3/5.0)/0.85.

  python3 power_budget.py <bom.json> <out.json>

Prints "PWRBUDGET <inlet worst mA> <inlet typ mA>" sentinel.
"""
import json
import re
import sys

bom_path, out_path = sys.argv[1], sys.argv[2]
lines = json.load(open(bom_path))

# (pattern, rail, worst_mA, typical_mA, note) — typical = realistic duty cycle
DEVICE_TABLE = [
    (r"pico|rp2040", "+5V", 45.0, 25.0, "MCU active; VSYS input incl. onboard buck"),
    (r"rfm9|sx12|lora", "+3V3", 120.0, 12.0, "worst: TX +17dBm continuous; typ: 5% TX duty + idle RX"),
    (r"quectel l80|l76|neo-|gnss|gps", "+3V3", 25.0, 20.0, "worst: acquisition; typ: tracking"),
    (r"sim7|bg9[56]|sara|cellular", "+5V", 2000.0, 150.0, "worst: GSM TX burst; typ: idle registered"),
    (r"mpu|lsm|bmi|icm|imu", "+3V3", 4.0, 3.0, "IMU active"),
    (r"sht|bme|bmp|tmp|lm75|mcp98|ina2|veml|opt3|apds|vl53|tsl2|ccs811|sgp|sensor",
     "+3V3", 1.0, 0.5, "I2C sensor"),
    (r"drv8|a4988|tb66|stepper|motor", "+5V", 1500.0, 300.0, "worst: stall-limited drive; typ: light load"),
]

BUCK_EFF = 0.85
V_IN, V_33 = 5.0, 3.3

rails = {"+5V": {"loads": [], "worst_ma": 0.0, "typ_ma": 0.0},
         "+3V3": {"loads": [], "worst_ma": 0.0, "typ_ma": 0.0}}

for line in lines:
    name = ((line.get("mpn") or "") + " " + (line.get("part") or "")).lower()
    ref = line.get("ref", "?")
    for pat, rail, worst, typ, note in DEVICE_TABLE:
        if re.search(pat, name):
            rails[rail]["loads"].append(
                {"ref": ref, "part": (line.get("mpn") or line.get("part") or "")[:40],
                 "worst_ma": worst, "typ_ma": typ, "note": note})
            rails[rail]["worst_ma"] += worst
            rails[rail]["typ_ma"] += typ
            break

# reflect the 3V3 rail into the 5V inlet through the buck
r33 = rails["+3V3"]
reflected_worst = r33["worst_ma"] * (V_33 / V_IN) / BUCK_EFF
reflected_typ = r33["typ_ma"] * (V_33 / V_IN) / BUCK_EFF
inlet_worst = rails["+5V"]["worst_ma"] + reflected_worst
inlet_typ = rails["+5V"]["typ_ma"] + reflected_typ

reg_loss_worst_mw = r33["worst_ma"] * V_33 * (1 - BUCK_EFF) / BUCK_EFF
reg_loss_typ_mw = r33["typ_ma"] * V_33 * (1 - BUCK_EFF) / BUCK_EFF

budget = {
    "version": 1,
    "rails": rails,
    "inlet_5v": {
        "worst_ma": round(inlet_worst, 1),
        "typ_ma": round(inlet_typ, 1),
        "worst_w": round(inlet_worst * V_IN / 1000.0, 2),
        "typ_w": round(inlet_typ * V_IN / 1000.0, 2),
    },
    "regulator": {
        "topology": "Pico onboard buck (VSYS -> 3V3)",
        "efficiency": BUCK_EFF,
        "loss_worst_mw": round(reg_loss_worst_mw, 1),
        "loss_typ_mw": round(reg_loss_typ_mw, 1),
    },
    "battery_per_1000mAh_5v": {
        "worst_h": round(1000.0 / inlet_worst, 1) if inlet_worst else None,
        "typ_h": round(1000.0 / inlet_typ, 1) if inlet_typ else None,
        "note": "5V-equivalent pack; scale linearly with capacity",
    },
    "assumptions": [
        "worst = every device at max simultaneous draw (design margin, not operating point)",
        "typical = realistic duty cycles noted per device",
        "unlisted BOM lines (passives, connectors, TPs) draw ~0",
    ],
}

json.dump(budget, open(out_path, "w"), indent=1)
print("PWRBUDGET %.0f %.0f" % (inlet_worst, inlet_typ))
