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


def synthesize(part_id, pins, roles, interface_name, refresh=False):
    """Cached LLM pin-role binding for a part. Returns
    {"binding": {role: [pins]}, "provenance": {...}} or raises with the
    verification problems (the caller falls back / reports honestly)."""
    import registry
    if not refresh:
        cached = registry.get_binding(part_id, interface_name)
        if cached:
            return cached
    proposal = _llm(pins, roles, str(part_id))
    ok, problems = verify(proposal, pins, roles)
    if not ok:
        raise RuntimeError("contract synthesis failed verification: %s"
                           % "; ".join(problems[:4]))
    provenance = {"source": "llm-datasheet-binding", "verified": "mechanical-checks",
                  "review": "required", "model": "openai/anthropic chain (llm_json)"}
    registry.save_binding(part_id, interface_name, proposal, provenance)
    return {"binding": proposal, "provenance": provenance}
