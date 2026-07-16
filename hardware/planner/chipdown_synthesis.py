"""Milestone: Chip-Down Component Synthesis v1.

Generalizes the bare-RP2040 pattern: given a symbol-verified chip (with
KiCad `extends` inheritance resolved), synthesize its chip-down support —
pin map from library truth, package strategy from the family system,
decoupling per power pin, straps, pull-ups — WITHOUT a hand-written block
per chip. Gates: mapping_blocked refuses layout; every synthesized chip-down
is review-required; nothing is physically validated by generation.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "blocks"))
import package_families as pfam  # noqa: E402
import datasheet_evidence as de  # noqa: E402
import multirail  # noqa: E402
import toolchain  # noqa: E402

SYM_SHARE = toolchain.kicad_symbols()


def _extract_block(text, name):
    i = text.find('(symbol "%s"' % name)
    if i < 0:
        return None
    # depth scan must ignore parentheses INSIDE quoted strings — description
    # properties contain things like "(quasi-bidirectional)" and a naive scan
    # overruns into the NEXT symbol, silently stealing its pins
    depth, j, in_str = 0, i, False
    while True:
        c = text[j]
        if c == '"' and text[j - 1] != "\\":
            in_str = not in_str
        elif not in_str:
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth == 0:
                    break
        j += 1
    return text[i:j + 1]


def parse_symbol(lib, name, _depth=0):
    """Parse pins from a KiCad symbol, RESOLVING `extends` inheritance (a
    real acquisition lesson: PCF8574T carries no pins — its base TCA9534
    does)."""
    if _depth > 3:
        return None, "extends chain too deep"
    text = open(os.path.join(SYM_SHARE, lib + ".kicad_sym")).read()
    blk = _extract_block(text, name)
    if blk is None:
        return None, "symbol %s not found in %s" % (name, lib)
    m = re.search(r'\(extends "([^"]+)"', blk[:200])
    base = m.group(1) if m else None
    pins = re.findall(
        r'\(pin\s+(\w+)\s+\w+[\s\S]*?\(name\s+"([^"]+)"[\s\S]*?\(number\s+"([^"]+)"',
        blk)
    if not pins and base:
        rp, rhow = parse_symbol(lib, base, _depth + 1)
        if rp is None:
            return None, rhow
        return rp, "resolved via extends -> %s (%s)" % (base, rhow)
    if not pins:
        return None, "no pins parsed (and no extends base)"
    def _pin_key(x):
        # numeric pins sort numerically; BGA ball names (A1..K11) sort by
        # row letter then column number
        num = x[2]
        if num.isdigit():
            return (0, 0, int(num))
        m = re.match(r"([A-Z]+)(\d+)$", num)
        if m:
            return (1, ord(m.group(1)[0]), int(m.group(2)))
        return (2, 0, 0)

    out = [{"number": num, "name": nm, "etype": et}
           for et, nm, num in sorted(pins, key=_pin_key)]
    return out, ("resolved via extends -> %s" % base if base else "direct")


# bus policy: name/etype -> net assignment intent
def _policy(pin, rails):
    nm = pin["name"].upper().replace("~", "").replace("{", "").replace("}", "")
    et = pin["etype"]
    if et == "power_in" and ("VDD" in nm or "VCC" in nm or "V+" in nm
                             or "VBAT" in nm or "VIN" == nm):
        return ("rail", None)  # resolved from the M6 domain plan
    if et == "power_in" and "GND" in nm or nm == "GND" or nm == "VSS":
        return ("rail", "GND")
    if nm in ("SDA", "SDI"):
        return ("bus", "I2C_SDA")
    if nm in ("SCL", "SCK", "SCLK") and et != "bidirectional":
        return ("bus", "I2C_SCL")
    if re.fullmatch(r"A[0-9]", nm):
        return ("strap", "GND")          # address straps low: base address
    if "INT" in nm or et == "open_collector":
        return ("pullup", "EXP_INT")
    if nm in ("NC",) or et == "no_connect":
        return ("nc", None)
    return ("io", None)                   # exposed IO: header/TP candidates


def synthesize_chipdown(symbol_lib, symbol_name, footprint_lib, footprint_name,
                        ref, rails=None):
    """Full chain: parse symbol (extends-resolved) -> classify package ->
    verify footprint geometry -> verify mapping -> emit the compose chipdown
    entry, or REFUSE with the exact gate."""
    rails = rails or {"power": "+3V3"}
    pins, how = parse_symbol(symbol_lib, symbol_name)
    if pins is None:
        return {"state": "blocked", "reason": how}
    fp_path = os.path.join(pfam.FP_SHARE, footprint_lib + ".pretty",
                           footprint_name + ".kicad_mod")
    geo = pfam.parse_footprint(fp_path)
    cls = pfam.classify(footprint_name, geo)
    fv = pfam.verify_footprint_v2(fp_path, expected_pads=len(pins),
                                  family=cls["family"])
    if fv["state"] == "blocked":
        return {"state": "blocked", "reason": fv["problems"],
                "gate": "footprint verification"}
    mp = pfam.verify_mapping(pins, [str(i + 1) for i in range(geo["pad_count"])])
    if mp["state"] == "mapping_blocked":
        return {"state": "blocked", "reason": mp["problems"] + mp["high_risk"],
                "gate": "symbol-footprint mapping"}
    if cls.get("advanced_gate"):
        return {"state": "architecture_only",
                "reason": "tier-3 package family %s" % cls["family"]}
    # M6: domain-aware rail planning — every distinct domain gets its OWN
    # net (never merged); unknown domains still block with no guess
    domains, why = multirail.plan_rails(pins, (rails or {}).get("overrides"))
    if domains is None:
        return {"state": "blocked", "gate": "multi-rail power domains",
                "reason": why}
    pin_rail = {}
    for dom, info in domains.items():
        for num in info["pins"]:
            pin_rail[num] = info["net"]
    pmap, straps, pullups, ios, power_pins = {}, [], [], [], []
    for p in pins:
        kind, net = _policy(p, rails)
        if kind == "rail":
            net = pin_rail.get(p["number"], net or "GND")
            pmap[p["number"]] = net
            if net != "GND":
                power_pins.append(p["number"])
        elif kind == "bus":
            pmap[p["number"]] = net
        elif kind == "strap":
            pmap[p["number"]] = net
            straps.append(p["number"])
        elif kind == "pullup":
            pmap[p["number"]] = net
            pullups.append(net)
        elif kind == "io":
            ios.append({"pin": p["number"], "name": p["name"]})
    prov = de.provenance_report(symbol_name,
                                keys=("decoupling_nF", "pullup_kohm_range"))
    dig_io, ana_io = multirail.split_analog(ios)
    return {"state": "synthesized_review_required",
            "rails": {d: {"net": i["net"], "pins": i["pins"],
                          "review": i["review"]}
                      for d, i in domains.items()},
            "analog_pins_requiring_afe": ana_io,
            "mixed_signal_blocked_claims": (
                multirail.BLOCKED_MIXED_SIGNAL if ana_io else []),
            "support_value_provenance": prov,
            "symbol": "%s:%s (%s)" % (symbol_lib, symbol_name, how),
            "footprint": [footprint_lib, footprint_name],
            "package": cls["family"], "pitch_mm": geo["pitch_mm"],
            "ref": ref, "pmap": pmap,
            "decouple_count": max(1, len(power_pins)),
            "decouple_rails": sorted({pin_rail.get(n, "+3V3")
                                      for n in power_pins}) or ["+3V3"],
            "pullups": pullups, "straps": straps,
            "exposed_io": dig_io,
            "evidence": {"pins_parsed": len(pins),
                         "footprint_pads": geo["pad_count"],
                         "mapping": mp["state"]},
            "blocked_claims": ["physically_validated", "production_ready",
                               "functional_verification (no firmware or "
                               "physical evidence)"],
            "honesty": "generic synthesis, review-required; library truth "
                       "only; no hand block written"}
