#!/usr/bin/env python3
"""Functional-wiring synthesis pass (Part 2 of the design-correctness fix).

synth.py wires every chip to shared BUSES + power/ground from its own declared
interface pins. It has no APPLICATION-TOPOLOGY synthesis — the point-to-point
signal chains that make a board actually do its job. This pass adds them, using
the SAME per-IC pin-role knowledge the gate (design_check.py) checks against, so
what the gate demands, this creates.

Patterns synthesized (extend by adding to PATTERNS):
  analog_measurement:  mux.COM -> ADC.AIN0 ; MCU GPIO -> mux.S0..S3 + EN ;
                       reference.OUT -> a mux channel (measurable self-cal) ;
                       remaining mux channels -> input connector.
  mcu_module:          a Pico-module RP2040 carries flash/crystal/USB onboard —
                       mark it so the gate doesn't demand an external flash.
  connector:           add the header/terminal the intent asks for, wired to the
                       signals that need to leave the board.

Usage:  python3 functional_wire.py <chipscale-spec.json> [design_rules.json] [intent]
Writes the augmented spec in place (adds nets + connector parts + a mcu 'module'
flag). Prints what it wired. Idempotent-ish (skips a link already present).
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# RP2040 (Pico module) pin roles the netmap uses. Free GPIO usable for mux control
# (excludes the I2C pins already taken and power/ground). From mcu_specs._RP2040.
RP2040 = {
    "i2c_sda": ["6", "11", "31"], "i2c_scl": ["7", "12", "32"],
    "gpio": ["1", "2", "4", "5", "9", "10", "14", "15", "16", "17", "19", "20",
             "21", "22", "24", "25", "26", "27", "29", "34"],
    "v3v3_out": "36", "module": True,
}


def load(p):
    return json.load(open(p))


def main():
    spec_path = sys.argv[1]
    rules = load(sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "design_rules.json"))
    intent = sys.argv[3] if len(sys.argv) > 3 else str(load(spec_path).get("intent", ""))
    spec = load(spec_path)
    parts = spec.setdefault("parts", [])
    nets = spec.setdefault("nets", [])
    ic_rules = rules["ics"]

    # index parts by class (from the rules DB pin map / class), + used pin set
    def role_map(mpn):
        for k, rr in ic_rules.items():
            if mpn and (k.upper() in mpn.upper() or mpn.upper() in k.upper()):
                return rr
        return None
    by_class = {}
    ref_mpn = {}
    for p in parts:
        ref, mpn = p.get("name"), (p.get("mpn") or "")
        ref_mpn[ref] = mpn
        rr = role_map(mpn)
        if rr:
            by_class.setdefault(rr.get("class"), []).append((ref, rr))

    used_pins = set()  # "U1.6"
    for net in nets:
        for pin in net:
            used_pins.add(pin)

    def pnum(rr, role):
        for k, v in (rr.get("pins") or {}).items():
            if v == role:
                return k
        return None
    def add_net(a, b, why):
        if a in used_pins and b in used_pins and any(a in n and b in n for n in nets):
            return False
        nets.append([a, b])
        used_pins.add(a); used_pins.add(b)
        wired.append(f"{a} <-> {b}  ({why})")
        return True

    wired = []
    next_ref = max([int(re.sub(r"\D", "", p["name"]) or 0) for p in parts] + [0]) + 1

    # ---- MCU module flag: Pico module has flash/crystal/USB onboard ----------
    mcu = by_class.get("mcu", [])
    mcu_ref = mcu[0][0] if mcu else None
    if mcu_ref and "RP2040" in ref_mpn.get(mcu_ref, ""):
        for p in parts:
            if p.get("name") == mcu_ref:
                p["module"] = True  # gate reads this: onboard flash/crystal/USB
        # free GPIO not already used
        free_gpio = [g for g in RP2040["gpio"] if f"{mcu_ref}.{g}" not in used_pins]

    # ---- analog_measurement pattern ------------------------------------------
    if "mux" in by_class and "adc" in by_class:
        mux_ref, mux_rr = by_class["mux"][0]
        adc_ref, adc_rr = by_class["adc"][0]
        com = pnum(mux_rr, "COM")
        ain0 = pnum(adc_rr, "AIN0")
        if com and ain0:
            add_net(f"{mux_ref}.{com}", f"{adc_ref}.{ain0}", "mux output -> ADC input")
        # MCU drives select lines + enable
        if mcu_ref:
            sel_roles = ["S0", "S1", "S2", "S3", "EN"]
            gp = list(free_gpio) if 'free_gpio' in dir() else []
            for role in sel_roles:
                n = pnum(mux_rr, role)
                if n and gp:
                    add_net(f"{mcu_ref}.{gp.pop(0)}", f"{mux_ref}.{n}", f"MCU drives mux {role}")
        # reference output -> a spare mux channel (measurable self-calibration)
        if "reference" in by_class:
            ref_ref, ref_rr = by_class["reference"][0]
            # reference OUT = its non-power, non-gnd pin. Power pin is the one on a
            # rail net; find the remaining pin.
            ref_pins = set((ref_rr.get("pins") or {}).keys())
            ref_used = {p.split(".")[1] for p in used_pins if p.split(".")[0] == ref_ref}
            out_pin = next((n for n in sorted(ref_pins) if n not in ref_used), None)
            i15 = pnum(mux_rr, "I15")
            if out_pin and i15:
                add_net(f"{ref_ref}.{out_pin}", f"{mux_ref}.{i15}", "reference -> mux channel (self-cal)")
        # input connector for the remaining mux channels
        chans = [pnum(mux_rr, f"I{i}") for i in range(15)]
        chans = [c for c in chans if c and f"{mux_ref}.{c}" not in used_pins]
        if chans:
            jref = f"J{next_ref}"
            parts.append({"name": jref, "mpn": "1x18-2.54-Header", "footprint": f"header_1x{len(chans)+2}", "kind": "connector"})
            add_net(f"{jref}.1", f"{mux_ref}.{chans[0]}", "input connector pin 1")  # ensure >=1 net
            for i, c in enumerate(chans):
                add_net(f"{jref}.{i+1}", f"{mux_ref}.{c}", f"input channel {i}")
            wired.append(f"added input connector {jref} ({len(chans)} channels)")

    # ---- addressable_led pattern (WS2812B and kin) — point-to-point data chain
    # the bus synth doesn't build: MCU GPIO -> first LED DIN, then each LED's DOUT
    # -> the next LED's DIN. VDD/GND come from the rail synthesis.
    if "led" in by_class and mcu_ref:
        leds = by_class["led"]
        gp = list(free_gpio) if "free_gpio" in dir() else []
        first_ref, first_rr = leds[0]
        din = pnum(first_rr, "DIN")
        if din and gp:
            add_net(f"{mcu_ref}.{gp.pop(0)}", f"{first_ref}.{din}", "MCU drives LED data-in")
        for i in range(len(leds) - 1):
            a_ref, a_rr = leds[i]
            b_ref, b_rr = leds[i + 1]
            dout, din2 = pnum(a_rr, "DOUT"), pnum(b_rr, "DIN")
            if dout and din2:
                add_net(f"{a_ref}.{dout}", f"{b_ref}.{din2}", f"LED chain {i}->{i + 1}")
        wired.append(f"wired addressable-LED data chain ({len(leds)} LED{'s' if len(leds) != 1 else ''})")

    # ---- generic connector-required (host/bus header) ------------------------
    cr = rules["generic"]["connector_required_if_intent"]
    has_conn = any(re.search(cr["detect_part_footprint"], (p.get("footprint", "") or "") + " " + (p.get("mpn", "") or ""), re.I) for p in parts)
    if re.search(cr["detect_intent"], intent, re.I) and not has_conn and mcu_ref:
        hdr = f"J{next_ref+1}"
        parts.append({"name": hdr, "mpn": "2x4-2.54-Header", "footprint": "header_2x4", "kind": "connector"})
        # wire host header to 3V3, GND, and the I2C / control lines the MCU uses
        v3 = RP2040["v3v3_out"]
        add_net(f"{hdr}.1", f"{mcu_ref}.{v3}", "host header 3V3")
        # a couple control/comms pins
        gp2 = [g for g in RP2040["gpio"] if f"{mcu_ref}.{g}" not in used_pins]
        for i, g in enumerate(gp2[:3]):
            add_net(f"{hdr}.{i+2}", f"{mcu_ref}.{g}", f"host header signal {i}")
        wired.append(f"added host/bus header {hdr}")

    json.dump(spec, open(spec_path, "w"), indent=1)
    print(f"FUNCTIONAL-WIRE — added {len(wired)} connections/parts:")
    for w in wired:
        print("  +", w)
    print(f"FUNCWIRE {len(wired)}")


if __name__ == "__main__":
    main()
