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
flag) and prints what it wired. Last line is ONE of:
    FUNCWIRE <n>          exit 0   n connections/parts added (0 = nothing to do)
    FUNCWIRE ERROR <why>  exit 2   could not run (unreadable/malformed spec, bad
                                   rules DB, any exception); the spec file is
                                   left UNTOUCHED. Never a traceback.
IDEMPOTENT: a pin that already carries a net (or is a ground pin) is never wired
again, so re-running on an already-wired spec adds 0. The pipeline re-runs this
on the persisted spec every time, so that property is load-bearing.
MPN -> rule lookup is rule_match.match_rule (shared with design_check /
functional_sim).
"""
import json
import os
import re
import sys

from rule_match import load_rules, match_rule, validate_spec

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


def wire(spec, rules, intent=""):
    """Synthesize the application signal chains INTO `spec` (mutated in place).
    Returns the list of human-readable additions (len == FUNCWIRE count).
    Raises ValueError on a malformed spec / rules DB."""
    parts, nets, gnd = validate_spec(spec)
    spec["parts"] = parts
    spec["nets"] = nets          # persist appends even when 'nets' was absent
    ic_rules = rules["ics"]
    cr = rules["generic"]["connector_required_if_intent"]

    # index parts by class (from the rules DB pin map / class)
    by_class = {}
    ref_mpn = {}
    for p in parts:
        ref, mpn = p["name"], (p.get("mpn") or "")
        ref_mpn[ref] = mpn
        rr = match_rule(mpn, ic_rules)
        if rr:
            by_class.setdefault(rr.get("class"), []).append((ref, rr))

    # every pin that already carries a net OR is a ground pin is TAKEN. This is
    # what makes the pass idempotent: nothing below ever wires a taken pin.
    used_pins = set(gnd)  # "U1.6"
    for net in nets:
        for pin in net:
            used_pins.add(pin)

    wired = []

    def pnum(rr, role):
        for k, v in (rr.get("pins") or {}).items():
            if v == role:
                return k
        return None

    def add_net(a, b, why):
        """Create a 2-pin net a<->b. REFUSED if either pin is already taken —
        a second run must never tie a fresh MCU output onto a pin that is
        already driven (that was the old non-idempotent behaviour)."""
        if a in used_pins or b in used_pins:
            return False
        nets.append([a, b])
        used_pins.add(a)
        used_pins.add(b)
        wired.append(f"{a} <-> {b}  ({why})")
        return True

    def join_net(new_pin, rail_pin, why):
        """Attach a FRESH pin to a power rail the `rail_pin` already sits on.
        Only the new pin must be free (the rail pin is expected taken). Emits a
        new 2-pin edge, the same pairwise net shape synth --netlist writes, so
        downstream readers never see an n-ary net."""
        if new_pin in used_pins:
            return False
        nets.append([new_pin, rail_pin])
        used_pins.add(new_pin)
        wired.append(f"{new_pin} <-> {rail_pin}  ({why})")
        return True

    next_ref = max([int(re.sub(r"\D", "", p["name"]) or 0) for p in parts] + [0]) + 1

    # ---- MCU module flag: Pico module has flash/crystal/USB onboard ----------
    mcu = by_class.get("mcu", [])
    mcu_ref = mcu[0][0] if mcu else None
    is_rp2040 = bool(mcu_ref and "RP2040" in ref_mpn.get(mcu_ref, "").upper())
    if is_rp2040:
        for p in parts:
            if p["name"] == mcu_ref:
                p["module"] = True  # gate reads this: onboard flash/crystal/USB

    def take_gpio():
        """Next free MCU GPIO (consults used_pins LIVE so no two patterns can
        be handed the same pin), or None."""
        if not is_rp2040:
            return None
        for g in RP2040["gpio"]:
            if f"{mcu_ref}.{g}" not in used_pins:
                return g
        return None

    # ---- analog_measurement pattern ------------------------------------------
    if "mux" in by_class and "adc" in by_class:
        mux_ref, mux_rr = by_class["mux"][0]
        adc_ref, adc_rr = by_class["adc"][0]
        com = pnum(mux_rr, "COM")
        ain0 = pnum(adc_rr, "AIN0")
        if com and ain0:
            add_net(f"{mux_ref}.{com}", f"{adc_ref}.{ain0}", "mux output -> ADC input")
        # MCU drives select lines + enable (only lines not already driven)
        if mcu_ref:
            for role in ["S0", "S1", "S2", "S3", "EN"]:
                n = pnum(mux_rr, role)
                if not n or f"{mux_ref}.{n}" in used_pins:
                    continue
                g = take_gpio()
                if g:
                    add_net(f"{mcu_ref}.{g}", f"{mux_ref}.{n}", f"MCU drives mux {role}")
        # reference output -> a spare mux channel (measurable self-calibration)
        if "reference" in by_class:
            ref_ref, ref_rr = by_class["reference"][0]
            # reference OUT = its non-power, non-gnd pin: the power pin sits on a
            # rail net and the ground pin is in `gnd`, both are in used_pins.
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
            for i, c in enumerate(chans):
                add_net(f"{jref}.{i+1}", f"{mux_ref}.{c}", f"input channel {i}")
            wired.append(f"added input connector {jref} ({len(chans)} channels)")

    # ---- addressable_led pattern (WS2812B and kin) — point-to-point data chain
    # the bus synth doesn't build: MCU GPIO -> first LED DIN, then each LED's DOUT
    # -> the next LED's DIN. VDD/GND come from the rail synthesis.
    if "led" in by_class and mcu_ref:
        leds = by_class["led"]
        n_before = len(wired)
        first_ref, first_rr = leds[0]
        din = pnum(first_rr, "DIN")
        if din and f"{first_ref}.{din}" not in used_pins:
            g = take_gpio()
            if g:
                add_net(f"{mcu_ref}.{g}", f"{first_ref}.{din}", "MCU drives LED data-in")
        for i in range(len(leds) - 1):
            a_ref, a_rr = leds[i]
            b_ref, b_rr = leds[i + 1]
            dout, din2 = pnum(a_rr, "DOUT"), pnum(b_rr, "DIN")
            if dout and din2:
                add_net(f"{a_ref}.{dout}", f"{b_ref}.{din2}", f"LED chain {i}->{i + 1}")
        if len(wired) > n_before:
            wired.append(f"wired addressable-LED data chain ({len(leds)} LED{'s' if len(leds) != 1 else ''})")

    # ---- generic connector-required (host/bus header) ------------------------
    has_conn = any(re.search(cr["detect_part_footprint"], (p.get("footprint", "") or "") + " " + (p.get("mpn", "") or ""), re.I) for p in parts)
    if re.search(cr["detect_intent"], intent, re.I) and not has_conn and is_rp2040:
        hdr = f"J{next_ref+1}"
        parts.append({"name": hdr, "mpn": "2x4-2.54-Header", "footprint": "header_2x4", "kind": "connector"})
        # header 3V3 JOINS the MCU's 3V3 rail net (the rail pin is already taken
        # by the rail synthesis — joining is the correct, idempotent action)
        join_net(f"{hdr}.1", f"{mcu_ref}.{RP2040['v3v3_out']}", "host header 3V3")
        # a couple control/comms pins
        for i in range(3):
            g = take_gpio()
            if not g:
                break
            add_net(f"{hdr}.{i+2}", f"{mcu_ref}.{g}", f"host header signal {i}")
        wired.append(f"added host/bus header {hdr}")

    return wired


def _one_line(e):
    s = "%s: %s" % (type(e).__name__, e) if not isinstance(e, ValueError) else str(e)
    return " ".join(s.split())[:240] or type(e).__name__


USAGE = "usage: functional_wire.py <chipscale-spec.json> [design_rules.json] [intent]"


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print(USAGE, file=sys.stderr)
        return 2
    try:
        spec_path = argv[0]
        spec = load(spec_path)
        rules = load_rules(argv[1] if len(argv) > 1 else None)
        if len(argv) > 2:
            intent = argv[2]
        else:
            intent = str(spec.get("intent", "")) if isinstance(spec, dict) else ""
        wired = wire(spec, rules, intent)
        # written ONLY after the whole pass succeeded — an ERROR leaves the file as it was
        with open(spec_path, "w") as f:
            json.dump(spec, f, indent=1)
    except Exception as e:
        print(f"FUNCWIRE ERROR {_one_line(e)}")
        return 2
    print(f"FUNCTIONAL-WIRE — added {len(wired)} connections/parts:")
    for w in wired:
        print("  +", w)
    print(f"FUNCWIRE {len(wired)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
