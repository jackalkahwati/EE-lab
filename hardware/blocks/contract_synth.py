"""Contract synthesis — bind ANY part's datasheet pins to ANY role set.

The 8 hand-written CONTRACTS in resolve_part.py cover 8 part classes; this is
the escape hatch for everything else (audio amps, display drivers, ADCs, RF
modules, ...). Given the part's REAL pins (datasheet_to_spec output: number +
name + function text) and the roles the caller needs connected, a frontier
model proposes {role: [pin numbers]} — and the proposal is then MECHANICALLY
verified here: every mapped pin must exist, no pin may serve two roles, every
required role must be covered. The model proposes; the code disposes.

Results are cached in the shared registry's `bindings` table with provenance
"llm-datasheet-binding (review-required)" — an LLM reading of a datasheet is
labeled as exactly that, never as a verified fact.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(os.path.dirname(_HERE))
sys.path.insert(0, os.path.join(_REPO, "software", "prompt-to-pcb-ui", "scripts"))
sys.path.insert(0, os.path.join(_REPO, "tools", "parts"))

SYS = (
    "You are an expert electronics engineer. Map component pins to circuit "
    "roles. Use ONLY pin numbers that appear in the provided pin table. "
    "Output ONLY one JSON object mapping each role name to a list of pin "
    "number strings. A role you cannot map maps to []. Never guess a pin "
    "that is not in the table."
)


def _llm(pins, roles, part_label):
    # provider chain (OpenAI -> Anthropic) lives in llm_json — synthesis must
    # survive one provider's key running out of quota
    from llm_json import complete_json
    pin_table = "\n".join(
        "  pin %s: %s — %s" % (p.get("number"), p.get("name"), p.get("function", ""))
        for p in pins)
    role_table = "\n".join(
        "  %s: %s%s" % (r, spec.get("desc", ""), " (REQUIRED)" if spec.get("required") else "")
        for r, spec in roles.items())
    user = (
        "Part: %s\n\nPin table (authoritative):\n%s\n\nRoles to map:\n%s\n\n"
        "Return JSON: {\"<role>\": [\"<pin number>\", ...], ...} with every role "
        "present. Power/ground roles may take several pins; signal roles take "
        "exactly one." % (part_label, pin_table, role_table))
    return complete_json(SYS, user)


def verify(binding, pins, roles):
    """Mechanical checks on the model's proposal. Returns (ok, problems)."""
    problems = []
    valid = {str(p.get("number")) for p in pins}
    seen = {}
    for role, nums in binding.items():
        if role not in roles:
            problems.append("unknown role '%s' in proposal" % role)
            continue
        if not isinstance(nums, list):
            problems.append("role '%s' is not a list" % role)
            continue
        for n in nums:
            n = str(n)
            if n not in valid:
                problems.append("role '%s' maps nonexistent pin %s" % (role, n))
            elif n in seen and seen[n] != role:
                problems.append("pin %s claimed by both '%s' and '%s'" % (n, seen[n], role))
            seen[n] = role
        if roles[role].get("mode", "one") == "one" and len(nums) > 1:
            problems.append("role '%s' wants one pin, got %d" % (role, len(nums)))
    for role, spec in roles.items():
        if spec.get("required") and not binding.get(role):
            problems.append("required role '%s' unmapped" % role)
    return (not problems), problems


_SUPPLY_TOKENS = ("VDD", "VCC", "V+", "VS", "VBAT", "VIN", "3V3", "5V",
                  "SUPPLY", "POWER", "PVDD", "AVDD", "DVDD", "VDDIO")
_GROUND_TOKENS = ("GND", "VSS", "GROUND", "EPAD", "AGND", "DGND", "PGND",
                  "THERMAL PAD")


def erc_check(binding, pins, roles):
    """Electrical sanity beyond structural verify(): a power role must land on
    supply-named pins and a ground role on ground-named pins — the two binding
    mistakes that destroy hardware. Uses the datasheet's own pin names +
    function text. Returns a list of problems (empty = clean)."""
    problems = []
    pin_text = {str(p.get("number")):
                ("%s %s" % (p.get("name", ""), p.get("function", ""))).upper()
                for p in pins}
    for role, nums in binding.items():
        rl = role.lower()
        desc = (roles.get(role) or {}).get("desc", "").lower()
        want = None
        kind = None
        if rl in ("power", "vcc", "vdd", "vin") or "supply" in desc or "power" in desc:
            want, kind = _SUPPLY_TOKENS, "supply"
        elif rl in ("gnd", "ground") or "ground" in desc:
            want, kind = _GROUND_TOKENS, "ground"
        if not want:
            continue
        for x in nums:
            txt = pin_text.get(str(x), "")
            if not any(t in txt for t in want):
                problems.append("role '%s' bound to pin %s which is not %s-named (%s)"
                                % (role, x, kind, txt[:40] or "unnamed"))
    return problems


def _normalize(binding):
    return {r: sorted(str(x) for x in v) for r, v in binding.items()}


def synthesize(part_id, pins, roles, interface_name, refresh=False):
    """Cached LLM pin-role binding for a part, produced by the VERIFICATION
    LADDER: two independent extractions must agree (double-extraction), the
    agreed binding must pass structural verify() AND electrical erc_check().
    Returns {"binding": ..., "provenance": {..., "level": ...}} or raises
    (the caller tries the next candidate / reports honestly)."""
    import registry
    if not refresh:
        cached = registry.get_binding(part_id, interface_name)
        if cached:
            return cached
    # two independent samples — a hallucinated pin map is unlikely to be
    # hallucinated the same way twice; disagreement fails the candidate
    a = _llm(pins, roles, str(part_id))
    b = _llm(pins, roles, str(part_id))
    if _normalize(a) != _normalize(b):
        raise RuntimeError("double-extraction disagreement for %s (%s) — binding rejected"
                           % (part_id, interface_name))
    ok, problems = verify(a, pins, roles)
    if not ok:
        raise RuntimeError("contract synthesis failed verification: %s"
                           % "; ".join(problems[:4]))
    erc = erc_check(a, pins, roles)
    if erc:
        raise RuntimeError("binding failed electrical sanity (ERC): %s"
                           % "; ".join(erc[:3]))
    provenance = {"source": "llm-datasheet-binding",
                  "level": "double-extracted",
                  "verified": "double-extraction agree + mechanical + ERC",
                  "review": "recommended before fab",
                  "model": "openai/anthropic chain (llm_json), 2 samples"}
    registry.save_binding(part_id, interface_name, a, provenance)
    return {"binding": a, "provenance": provenance}
