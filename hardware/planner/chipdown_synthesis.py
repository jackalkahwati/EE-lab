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
import package_families as pfam  # noqa: E402
import datasheet_evidence as de  # noqa: E402

SYM_SHARE = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols"


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
    out = [{"number": num, "name": nm, "etype": et}
           for et, nm, num in sorted(pins, key=lambda x: int(x[2]))]
    return out, ("resolved via extends -> %s" % base if base else "direct")


# bus policy: name/etype -> net assignment intent
def _policy(pin, rails):
    nm = pin["name"].upper().replace("~", "").replace("{", "").replace("}", "")
    et = pin["etype"]
    if et == "power_in" and ("VDD" in nm or "VCC" in nm or "V+" in nm):
        return ("rail", rails.get("power", "+3V3"))
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
    # M4 guard: chips with DISTINCT power-domain names (VCCA/VCCB, VCC+VBAT)
    # must not silently merge onto one rail — that is the M6 multi-rail gap
    pwr_names = {p["name"].upper().split("/")[0] for p in pins
                 if p["etype"] == "power_in"
                 and not ("GND" in p["name"].upper()
                          or p["name"].upper() == "VSS")}
    if len(pwr_names) > 1:
        return {"state": "blocked",
                "gate": "multi-rail power domains",
                "reason": "distinct power pins %s would silently merge onto "
                          "one rail — blocked until multi-rail synthesis "
                          "(M6)" % sorted(pwr_names)}
    pmap, straps, pullups, ios, power_pins = {}, [], [], [], []
    for p in pins:
        kind, net = _policy(p, rails)
        if kind == "rail":
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
    return {"state": "synthesized_review_required",
            "support_value_provenance": prov,
            "symbol": "%s:%s (%s)" % (symbol_lib, symbol_name, how),
            "footprint": [footprint_lib, footprint_name],
            "package": cls["family"], "pitch_mm": geo["pitch_mm"],
            "ref": ref, "pmap": pmap,
            "decouple_count": max(1, len(power_pins)),
            "pullups": pullups, "straps": straps,
            "exposed_io": ios,
            "evidence": {"pins_parsed": len(pins),
                         "footprint_pads": geo["pad_count"],
                         "mapping": mp["state"]},
            "blocked_claims": ["physically_validated", "production_ready",
                               "functional_verification (no firmware or "
                               "physical evidence)"],
            "honesty": "generic synthesis, review-required; library truth "
                       "only; no hand block written"}
