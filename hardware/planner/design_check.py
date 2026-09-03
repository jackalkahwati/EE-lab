#!/usr/bin/env python3
"""Design-correctness gate.

Runs a board's NETLIST against design_rules.json. Catches the class of error that
DRC (manufacturability) and the physics sims cannot: a design that is buildable
and routes clean but is functionally WRONG or INCOMPLETE — an IC with only power
connected, an MCU with no flash to boot from, a mux whose output never reaches the
ADC, a reference whose output goes nowhere, a board that needs a connector and
has none.

Usage:  python3 design_check.py <chipscale-spec.json> [rules.json] [intent_text]
Prints  a findings report and ONE verdict line last:
    GATE PASS            exit 0   no fail-severity findings
    GATE FAIL <n>        exit 1   n fail-severity findings (an EMPTY parts list is
                                  FAIL 1 "no parts" — nothing to check is not a pass)
    GATE ERROR <reason>  exit 2   the gate could not run: unreadable/malformed spec
                                  (missing 'parts', null 'gnd', nameless part),
                                  broken rules DB, or any uncaught exception.
                                  Callers treat exit 2 as "gate not run", never as
                                  pass or fail. No traceback is ever the output.
MPN -> rule lookup is rule_match.match_rule (shared with functional_wire /
functional_sim so all three agree on which parts are known).
"""
import json
import os
import re
import sys

from rule_match import load_rules, match_rule, validate_spec


def _req(d, key, ctx):
    if not isinstance(d, dict) or key not in d:
        raise ValueError("rules DB missing '%s.%s'" % (ctx, key))
    return d[key]


def check(spec, rules, intent_text=None):
    """Run the gate. Returns {"findings": [(sev, ref, msg)], "ics_checked": n,
    "parts": n, "nets": n}. Raises ValueError on a malformed spec / rules DB."""
    parts, nets, gnd = validate_spec(spec)
    if intent_text is None:
        intent_text = str(spec.get("intent", "")) + " " + str(spec.get("product", ""))
    ic_rules = _req(rules, "ics", "rules")
    generic = _req(rules, "generic", "rules")

    findings = []

    def report(sev, ref, msg):
        findings.append((sev, ref, msg))

    if not parts:
        report("fail", "-", "no parts in spec — nothing to check (an empty design is not a passing design)")
        return {"findings": findings, "ics_checked": 0, "parts": 0, "nets": len(nets)}

    # ---- connectivity model --------------------------------------------------
    signal_pins = set()          # "U4.15"
    for net in nets:
        for p in net:
            signal_pins.add(p)
    gnd_pins = set(gnd)

    # union-find over signal nets for reachability (mux COM -> ADC AIN, cap on a rail)
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        parent[find(a)] = find(b)

    for net in nets:
        for i in range(len(net) - 1):
            union(net[i], net[i + 1])

    ref_mpn = {p["name"]: (p.get("mpn") or "") for p in parts}
    ref_fp = {p["name"]: (p.get("footprint") or "") for p in parts}

    def pin(ref, num):
        return f"{ref}.{num}"

    def sig_connected(ref, num):
        return pin(ref, num) in signal_pins

    def net_of(ref, num):
        p = pin(ref, num)
        return find(p) if p in signal_pins else None

    def cap_on_net(root):
        """is there a capacitor pin on this net root?"""
        if root is None:
            return False
        for p in signal_pins:
            if find(p) == root and re.match(r"C\d", p.split(".")[0]):
                return True
        return False

    # ---- per-IC rules --------------------------------------------------------
    present_classes = {}   # class -> [(ref, rule)]
    g = _req(generic, "ic_function_min_signal_pins", "generic")
    for part in parts:
        ref, mpn = part["name"], (part.get("mpn") or "")
        r = match_rule(mpn, ic_rules)
        if not r:
            continue
        present_classes.setdefault(r.get("class"), []).append((ref, r))
        role2num = {v: k for k, v in (r.get("pins") or {}).items()}
        sig_count = sum(1 for n in (r.get("pins") or {}) if sig_connected(ref, n))
        if not r.get("pins"):
            # no pin map (e.g. MCU) — count any connected pins on the ref
            sig_count = len({p for p in signal_pins if p.split(".")[0] == ref})

        # requires_support (MCU flash/crystal etc.). A MODULE (e.g. Pico) carries its
        # flash/crystal/USB onboard, so those external-support requirements are already
        # met — skip them when the part is flagged module:true.
        is_module = bool(part.get("module"))
        for req in r.get("requires_support", []):
            if is_module and req.get("kind") in ("external_flash", "crystal"):
                continue
            rx_m = re.compile(req.get("detect_mpn", "$^"), re.I)
            rx_f = re.compile(req.get("detect_footprint", "$^"), re.I)
            ok = any(rx_m.search(ref_mpn.get(p["name"], "") or "") or rx_f.search(ref_fp.get(p["name"], "") or "") for p in parts)
            if not ok:
                report(req["severity"], ref, f"[{mpn}] {req['msg']}")

        # min signal pins. A MODULE (Pico) hides QSPI/USB/crystal internally and only
        # exposes GPIO + power, so the raw-chip minimum (which counts those internal
        # nets) doesn't apply — a module with I2C + a few control lines + power IS a
        # complete, working MCU section.
        min_pins = 6 if is_module else r.get("min_signal_pins")
        if min_pins and sig_count < min_pins:
            msg = "module MCU has almost nothing connected" if is_module else r.get("min_signal_pins_msg", "too few pins connected")
            report("fail", ref, f"[{mpn}] {msg} (only {sig_count} signal pins)")

        # named-pin rules
        for rule in r.get("rules", []):
            chk = rule["check"]

            def num(role):
                return role2num.get(role)

            def rc(role):  # role connected?
                n = num(role)
                return n is not None and sig_connected(ref, n)

            ok = True
            if chk == "connected":
                ok = all(rc(x) for x in rule["pins"])
            elif chk == "all_of":
                ok = all(rc(x) for x in rule["pins"])
            elif chk == "at_least_one_of":
                ok = any(rc(x) for x in rule["pins"])
            elif chk == "at_least_n_of":
                ok = sum(1 for x in rule["pins"] if rc(x)) >= rule.get("n", 1)
            elif chk == "signal_pin_count_min":
                ok = sig_count >= rule["min"]
            elif chk == "decoupling_near":
                ok = cap_on_net(net_of(ref, num(rule["pin"]))) if num(rule["pin"]) else True
            elif chk == "decoupling_present":
                ok = any(re.match(r"C\d", rp.split(".")[0]) and find(rp) in {net_of(ref, n) for n in (r.get("pins") or {})} for rp in signal_pins)
            if not ok:
                report(rule["severity"], ref, f"[{mpn}] {rule['msg']}")

        # generic: an IC with almost nothing connected
        if r.get("class") not in ("passive",) and sig_count < g["min"] and "min_signal_pins" not in r:
            report(g["severity"], ref, f"[{mpn}] {g['msg']} ({sig_count} signal pins)")

    # ---- signal-chain rules (cross-IC) ---------------------------------------
    for sc in generic.get("signal_chain", []):
        if not all(c in present_classes for c in sc["when_classes"]):
            continue
        if sc["check"] == "mux_com_reaches_adc_input":
            mux_ref, mux_r = present_classes["mux"][0]
            adc_ref, adc_r = present_classes["adc"][0]
            mux_com = {k for k, v in (mux_r.get("pins") or {}).items() if v == "COM"}
            com_net = net_of(mux_ref, next(iter(mux_com))) if mux_com else None
            adc_ains = [k for k, v in (adc_r.get("pins") or {}).items() if str(v).startswith("AIN")]
            reaches = com_net is not None and any(net_of(adc_ref, a) == com_net for a in adc_ains)
            if not reaches:
                report(sc["severity"], f"{mux_ref}->{adc_ref}", sc["msg"])

    # ---- connector-required --------------------------------------------------
    cr = _req(generic, "connector_required_if_intent", "generic")
    if re.search(cr["detect_intent"], intent_text, re.I):
        has_conn = any(re.search(cr["detect_part_footprint"], (ref_fp.get(p["name"], "") or "") + " " + (ref_mpn.get(p["name"], "") or ""), re.I) for p in parts)
        if not has_conn:
            report(cr["severity"], "-", cr["msg"])

    return {
        "findings": findings,
        "ics_checked": sum(len(v) for v in present_classes.values()),
        "parts": len(parts),
        "nets": len(nets),
    }


def _one_line(e):
    s = "%s: %s" % (type(e).__name__, e) if not isinstance(e, ValueError) else str(e)
    return " ".join(s.split())[:240] or type(e).__name__


USAGE = "usage: design_check.py <chipscale-spec.json> [rules.json] [intent_text]"


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print(USAGE, file=sys.stderr)
        return 2
    try:
        spec_path = argv[0]
        with open(spec_path) as f:
            spec = json.load(f)
        rules = load_rules(argv[1] if len(argv) > 1 else None)
        intent_text = argv[2] if len(argv) > 2 else None
        res = check(spec, rules, intent_text)
    except Exception as e:  # any failure to RUN the gate is ERROR, never a verdict
        print(f"GATE ERROR {_one_line(e)}")
        return 2

    findings = res["findings"]
    fails = [f for f in findings if f[0] == "fail"]
    warns = [f for f in findings if f[0] == "warn"]
    print(f"DESIGN-CORRECTNESS CHECK — {os.path.basename(os.path.dirname(os.path.abspath(spec_path)))}")
    print(f"parts: {res['parts']} | ICs checked: {res['ics_checked']} | signal nets: {res['nets']}")
    for sev, ref, msg in fails:
        print(f"  ✗ FAIL  {ref}: {msg}")
    for sev, ref, msg in warns:
        print(f"  ⚠ WARN  {ref}: {msg}")
    if not findings:
        print("  ✓ no findings")
    print(f"GATE {'FAIL ' + str(len(fails)) if fails else 'PASS'}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
