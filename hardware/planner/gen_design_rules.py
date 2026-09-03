#!/usr/bin/env python3
"""Auto-grow the design-correctness rules DB from the part library.

Every library part (library/*.json) already carries its pin names + etypes and a
reference-circuit hint. This reads them, infers the part's CLASS, and emits a
design_rules entry — pin-ROLE map (by name) + class-based functional requirements
— so the gate's coverage grows with the library instead of one hand entry at a
time. Hand-curated rules in design_rules.json always WIN (this only fills gaps);
output goes to design_rules_auto.json, which design_check.py merges under it.

Usage:  python3 gen_design_rules.py            # regenerate design_rules_auto.json
"""
import glob
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "library")


def role_of(name):
    """Canonical role token from a pin NAME (datasheet name -> gate role)."""
    n = name.upper().strip()
    n = re.sub(r"[\s/]+", "_", n)
    for pat, role in [
        (r"^AIN?(\d+)$", lambda m: "AIN" + m.group(1)),
        (r"^IN?(\d+)$|^CH(\d+)$|^I(\d+)$", lambda m: "I" + (m.group(1) or m.group(2) or m.group(3))),
        (r"^A[BS]?(\d+)$|^S(\d+)$", lambda m: "S" + (m.group(1) or m.group(2))),
    ]:
        m = re.match(pat, n)
        if m:
            return pat and (role(m) if callable(role) else role)
    table = {
        "COM": "COM", "COMMON": "COM", "OUT": "OUT", "VOUT": "OUT", "VREF": "OUT",
        "SCL": "SCL", "SDA": "SDA", "SCLK": "SCK", "MOSI": "MOSI", "MISO": "MISO",
        "A": "A", "B": "B", "Y": "A", "Z": "B", "DE": "DE", "RE": "RE",
        "RO": "RO", "DI": "DI", "R": "RO", "D": "DI",
        "EN": "EN", "E": "EN", "ENABLE": "EN", "CE": "EN",
        "ADDR": "ADDR", "AD0": "ADDR", "ALERT_RDY": "ALERT", "ALERT": "ALERT", "RDY": "ALERT",
        "VDD": "VDD", "VCC": "VCC", "VS": "VCC", "VIN": "VIN", "GND": "GND", "VSS": "GND",
    }
    return table.get(n, name)


def classify(pins_by_role, category):
    roles = set(pins_by_role.values())
    cat = (category or "").lower()
    if "reference" in cat or (roles & {"OUT"} and len([r for r in roles if r not in ("GND", "VIN", "VCC", "VDD")]) <= 2):
        return "reference"
    if {"A", "B"} <= roles and (roles & {"DE", "RE", "RO", "DI"}):
        return "transceiver"
    if roles & {"COM"} and any(r.startswith("S") and r[1:].isdigit() for r in roles):
        return "mux"
    if any(r.startswith("AIN") for r in roles) and (roles & {"SCL", "SDA", "SCK"}):
        return "adc"
    if "mcu" in cat or "microcontroller" in cat:
        return "mcu"
    return "generic"


CLASS_RULES = {
    "adc": lambda p: [
        {"id": "adc_has_input", "check": "at_least_one_of", "pins": [r for r in p.values() if r.startswith("AIN")], "severity": "fail", "msg": "ADC has no analog input connected — nothing to measure"},
        {"id": "adc_bus", "check": "all_of", "pins": [r for r in ("SCL", "SDA") if r in p.values()], "severity": "fail", "msg": "ADC bus (SCL/SDA) incomplete"},
    ],
    "mux": lambda p: [
        {"id": "mux_com", "check": "connected", "pins": ["COM"], "severity": "fail", "msg": "mux COM (output) not connected — drives nothing"},
        {"id": "mux_select", "check": "at_least_one_of", "pins": [r for r in p.values() if r.startswith("S") and r[1:].isdigit()], "severity": "fail", "msg": "mux select lines not driven — channel can never be chosen"},
        {"id": "mux_channels", "check": "at_least_n_of", "n": 1, "pins": [r for r in p.values() if r.startswith("I") and r[1:].isdigit()], "severity": "fail", "msg": "mux has no channel inputs connected"},
    ],
    "reference": lambda p: [
        {"id": "ref_output_used", "check": "signal_pin_count_min", "min": 2, "severity": "fail", "msg": "voltage reference output goes nowhere (unused)"},
    ],
    "transceiver": lambda p: [
        {"id": "xcv_bus", "check": "all_of", "pins": [r for r in ("A", "B") if r in p.values()], "severity": "fail", "msg": "transceiver differential bus (A/B) not connected"},
        {"id": "xcv_ctrl", "check": "at_least_one_of", "pins": [r for r in ("RO", "DI") if r in p.values()], "severity": "fail", "msg": "transceiver data lines not connected to a controller"},
    ],
}


def main():
    out = {"_doc": "AUTO-GENERATED from library/*.json by gen_design_rules.py. Hand-curated design_rules.json wins on conflict. Regenerate when the library changes.", "ics": {}}
    n = 0
    for f in sorted(glob.glob(os.path.join(LIB, "*.json"))):
        try:
            part = json.load(open(f))
        except Exception:
            continue
        mpn = part.get("mpn")
        pins = part.get("pins") or []
        if not mpn or not pins:
            continue
        pin_map = {}
        for p in pins:
            num = str(p.get("number", ""))
            role = role_of(p.get("name", ""))
            if num:
                pin_map[num] = role
        pins_by_role = pin_map
        cls = classify(pins_by_role, part.get("category", ""))
        entry = {"class": cls, "total_pins": len(pins), "pins": pin_map, "auto": True}
        mk = CLASS_RULES.get(cls)
        if mk:
            rules = [r for r in mk(pins_by_role) if r.get("pins") or r.get("check") == "signal_pin_count_min"]
            if rules:
                entry["rules"] = rules
        out["ics"][mpn] = entry
        n += 1
    json.dump(out, open(os.path.join(HERE, "design_rules_auto.json"), "w"), indent=1)
    print(f"AUTO-RULES generated for {n} library parts -> design_rules_auto.json")
    print("classes:", {c: sum(1 for v in out["ics"].values() if v["class"] == c) for c in set(v["class"] for v in out["ics"].values())})


if __name__ == "__main__":
    main()
