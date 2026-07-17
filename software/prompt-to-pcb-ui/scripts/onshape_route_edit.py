#!/usr/bin/env python3
"""
Edit router (Stage 3 front half): natural-language prompt -> scoped edit PLAN.

Turns "the E-Stop bezel will melt, make it heat-resistant" or "add 50 mm of X
travel" or "fix the clash on the cable trunk" into a concrete, part-scoped plan
that onshape_edit.apply_edits() can execute on an isolated branch. The plan is
always returned for approval first — nothing is applied here.

It routes against the REAL editable surface of the design:
  * the analysis findings (thermal-flagged parts, clash pairs)  [Stage 2]
  * the Part Studio's named design variables (X_travel, frame_L, ...)
  * per-part materials + the material library

Deterministic handlers cover the common intents; anything else is returned as
`intent: "unrouted"` with the editable surface attached, so an LLM caller (the
Compose app, which already has model access) can finish the mapping.
"""
from __future__ import annotations

import json
import re
import sys

# higher-temp swap suggestions for a flagged low-temp material
MATERIAL_UPGRADE = {
    "rubber / tpu": "Silicone (high-temp)",
    "pla": "PETG or ASA",
    "abs / pc": "Polycarbonate (glass-filled)",
    "abs": "ASA or Polycarbonate",
    "petg": "ASA",
    "nylon": "Nylon (glass-filled)",
}

THERMAL_WORDS = ("melt", "hot", "heat", "thermal", "temperature", "heat-resistant", "heat resistant", "warm")
CLASH_WORDS = ("interfere", "interference", "clash", "collide", "collision", "overlap", "hitting", "hits", "conflict")
GROW_WORDS = ("longer", "bigger", "larger", "wider", "taller", "increase", "extend", "more travel", "grow", "add", "more")
SHRINK_WORDS = ("shorter", "smaller", "narrower", "reduce", "decrease", "shrink", "less travel")


def _find_part(prompt, parts):
    """Best part-name match mentioned in the prompt (longest name that appears)."""
    pl = prompt.lower()
    best = None
    for p in parts:
        nm = (p.get("name") or "").lower()
        if nm and nm in pl and (best is None or len(nm) > len(best.get("name", ""))):
            best = p
    return best


def _find_variable(prompt, variables):
    pl = prompt.lower()
    # explicit variable name, or a keyword -> variable heuristic
    for v in variables:
        if v["name"].lower() in pl:
            return v
    for key, vname in (("x travel", "X_travel"), ("y travel", "Y_travel"), ("z travel", "Z_travel"),
                       ("travel", "X_travel"), ("frame length", "frame_L"), ("frame width", "frame_W")):
        if key in pl:
            return next((v for v in variables if v["name"] == vname), None)
    return None


def _mm_in(prompt):
    m = re.search(r"(\d+(?:\.\d+)?)\s*(mm|millimet|cm|centimet|in|inch)", prompt.lower())
    if not m:
        return None
    val = float(m.group(1))
    unit = m.group(2)
    if unit.startswith("cm") or unit.startswith("centimet"):
        val *= 10
    elif unit.startswith("in"):
        val *= 25.4
    return val


def route(prompt, state, analysis, variables):
    parts = state["parts"]
    pl = prompt.lower()
    named = _find_part(prompt, parts)

    # --- thermal intent -> material upgrade on a flagged part ---
    if any(w in pl for w in THERMAL_WORDS):
        flagged = {f["partId"]: f for f in analysis.get("thermal", {}).get("flagged", [])}
        target = named if (named and named["partId"] in flagged) else None
        if target is None and flagged:
            # no part named: take the lowest-softening flagged part
            target_pid = min(flagged, key=lambda k: flagged[k]["softeningC"])
            target = next((p for p in parts if p["partId"] == target_pid), None)
        if target:
            cur = (target.get("material") or "").lower()
            upgrade = next((v for k, v in MATERIAL_UPGRADE.items() if k in cur), "Polycarbonate")
            return {
                "intent": "thermal-material-upgrade",
                "targetPart": target["name"], "partId": target["partId"],
                "rationale": f"{target['name']} is {target.get('material')} "
                             f"(softens ~{flagged.get(target['partId'],{}).get('softeningC','?')} C); "
                             f"upgrade the material so it survives the heat.",
                "edits": [{"kind": "material", "part": target["name"],
                           "partId": target["partId"], "material": upgrade}],
                "needsApproval": True,
            }

    # --- clash intent -> shrink/adjust one part in the top pair ---
    if any(w in pl for w in CLASH_WORDS):
        pairs = analysis.get("clash", {}).get("top", [])
        pick = None
        if named:
            pick = next((c for c in pairs if named["name"] in (c["a"], c["b"])), None)
        pick = pick or (pairs[0] if pairs else None)
        if pick:
            # prefer to edit the smaller/less structural of the two
            return {
                "intent": "clash-fix",
                "targetPart": pick["b"], "partId": pick["bPartId"],
                "against": pick["a"],
                "rationale": f"{pick['a']} and {pick['b']} interpenetrate "
                             f"~{pick['penetrationMm']} mm. Trim/relieve {pick['b']} "
                             f"so it clears {pick['a']} (confirm narrow-phase first).",
                "edits": [{"kind": "parameter", "part": pick["b"], "partId": pick["bPartId"],
                           "feature": "TODO: relief feature on " + pick["b"],
                           "paramId": "depth", "value": f"-{pick['penetrationMm']} mm"}],
                "needsApproval": True, "confirmNarrowPhase": True,
            }

    # --- dimension intent -> change a design variable ---
    if any(w in pl for w in GROW_WORDS + SHRINK_WORDS):
        var = _find_variable(prompt, variables)
        delta = _mm_in(prompt)
        if var:
            sign = -1 if any(w in pl for w in SHRINK_WORDS) else 1
            newexpr = (f"{var['expression']} {'+' if sign > 0 else '-'} {abs(delta):g} mm"
                       if delta else f"{var['expression']} (adjust)")
            return {
                "intent": "variable-change",
                "targetVariable": var["name"], "current": var["expression"],
                "rationale": f"Change design variable {var['name']} "
                             f"({var['expression']}) by {sign*delta if delta else '?'} mm; "
                             f"the parametric model re-derives every dependent part.",
                "edits": [{"kind": "parameter", "feature": var["name"],
                           "paramId": "value", "value": newexpr}],
                "needsApproval": True,
            }

    # --- unrouted: hand the editable surface to an LLM caller ---
    return {
        "intent": "unrouted",
        "note": "no deterministic route; an LLM caller should map this prompt to an edit "
                "using the editable surface below.",
        "editableSurface": {
            "namedPart": named["name"] if named else None,
            "variables": [v["name"] for v in variables],
            "thermalFlagged": [f["part"] for f in analysis.get("thermal", {}).get("flagged", [])][:10],
            "clashPairs": [f"{c['a']} × {c['b']}" for c in analysis.get("clash", {}).get("top", [])][:5],
        },
        "needsApproval": True,
    }


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("prompt")
    ap.add_argument("--state", required=True)
    ap.add_argument("--analysis", required=True)
    ap.add_argument("--variables", help="JSON list of {name,expression}; else []")
    a = ap.parse_args()
    state = json.load(open(a.state))
    analysis = json.load(open(a.analysis))
    variables = json.load(open(a.variables)) if a.variables else []
    print(json.dumps(route(a.prompt, state, analysis, variables), indent=1))


if __name__ == "__main__":
    main()
