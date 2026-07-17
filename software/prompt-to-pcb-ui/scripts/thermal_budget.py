#!/usr/bin/env python3
"""
Thermal budget (Rec #2) — the first extension of Compose's engineering
intelligence beyond electronics.

It does for HEAT what the electronics stack already does for routing: compute a
real first-order answer AND state plainly what it did not verify. This is the
lumped steady-state model an engineer actually uses to size a product before any
CFD — not a fake, not a full simulation.

Model (sealed or vented enclosure, steady state):
  1. All internal power P must leave through the outer surface to ambient.
  2. Surface->ambient by natural convection + radiation:
        T_surface - T_ambient = P / ((h_conv + h_rad) * A_outer)
     h_rad depends on EMISSIVITY — bare aluminum (~0.09) radiates far worse than
     anodized/painted (~0.8); this routinely dominates and is a real design lever.
  3. Internal air sits above the (near-isothermal metal) wall by an internal dT.
  4. Each component junction: T_j = T_internal_air + P_component * theta_JA_local.
  5. Margin = part limit - T_j, per part.

Honesty: 1-node lumped, natural convection assumed, generic theta/emissivity
unless given, no CFD, no transient. Every number carries that caveat, and the
result is explicitly REVIEW-REQUIRED until measured (Rec #3 closes that loop).

Usage: thermal_budget.py <spec.json> [--out budget.json]
"""
from __future__ import annotations
import argparse, json, sys, math

SIGMA = 5.670e-8  # Stefan-Boltzmann W/m^2K^4

# generic junction-to-local-air resistance by package class (C/W), used only when
# a component gives no theta. Deliberately conservative (worse-case-ish).
THETA_DEFAULT = {"bga": 12, "qfn": 25, "soic": 60, "to220": 3, "module": 8, "generic": 40}

def h_radiation(emissivity, t_surf_c, t_amb_c):
    """Linearized radiative coefficient W/m^2K about the film temperature."""
    ts = t_surf_c + 273.15; ta = t_amb_c + 273.15
    tf = (ts + ta) / 2
    return 4 * emissivity * SIGMA * tf**3

def budget(spec):
    amb = float(spec.get("ambientC", 25))
    enc = spec.get("enclosure", {})
    area_mm2 = float(enc.get("surfaceAreaMm2", 0)) or 0.0
    A = area_mm2 / 1e6  # m^2
    emis = float(enc.get("emissivity", 0.09 if "alumin" in str(enc.get("material","")).lower()
                                             and "anod" not in str(enc.get("material","")).lower() else 0.8))
    h_conv = float(enc.get("hConv", 6.0))  # W/m^2K natural convection, still air
    vented = bool(enc.get("vented", False))
    internal_dT = float(enc.get("internalAirRiseC", 8.0))  # air above wall (sealed)
    if vented:
        internal_dT = float(enc.get("internalAirRiseC", 3.0))
        h_conv = float(enc.get("hConv", 12.0))

    comps = spec.get("components", [])
    P = sum(float(c.get("powerW", 0)) for c in comps)

    # solve surface temp iteratively (h_rad depends on it)
    t_surf = amb + 10
    for _ in range(50):
        h = h_conv + h_radiation(emis, t_surf, amb)
        dT = P / (h * A) if (h * A) > 0 else float("inf")
        t_surf_new = amb + dT
        if abs(t_surf_new - t_surf) < 0.01:
            t_surf = t_surf_new; break
        t_surf = t_surf_new
    h_final = h_conv + h_radiation(emis, t_surf, amb)
    t_air = t_surf + internal_dT

    parts = []
    worst_margin = math.inf
    for c in comps:
        p = float(c.get("powerW", 0))
        theta = c.get("thetaJA")
        if theta is None:
            theta = THETA_DEFAULT.get(str(c.get("package", "generic")).lower(), THETA_DEFAULT["generic"])
        tj = t_air + p * float(theta)
        limit = float(c.get("maxTempC", 85))
        margin = limit - tj
        worst_margin = min(worst_margin, margin)
        parts.append({
            "name": c.get("name"), "powerW": p, "thetaJA_CperW": float(theta),
            "junctionC": round(tj, 1), "limitC": limit, "marginC": round(margin, 1),
            "status": "PASS" if margin >= 10 else ("TIGHT" if margin >= 0 else "FAIL"),
        })
    parts.sort(key=lambda x: x["marginC"])

    verdict = "PASS" if worst_margin >= 10 else ("TIGHT" if worst_margin >= 0 else "FAIL")
    # engineering rationale, electronics-artifact style
    levers = []
    if emis < 0.3:
        levers.append(f"emissivity is {emis} (bare metal) — anodize/paint to ~0.8 to roughly "
                      f"double radiative loss; this is the cheapest fix")
    if verdict != "PASS" and not vented:
        levers.append("add venting or a fan (forced convection h~25-50) to drop internal air rise")
    if verdict != "PASS":
        levers.append("heatsink the worst part(s) to cut theta_JA, or spread heat to the wall")

    return {
        "source": "thermal-budget-v1",
        "model": "1-node lumped steady-state (convection+radiation), no CFD",
        "powerW": round(P, 2),
        "ambientC": amb,
        "enclosure": {"areaMm2": area_mm2, "emissivity": emis, "hConvWm2K": h_conv,
                      "vented": vented, "surfaceRiseC": round(t_surf - amb, 1),
                      "internalAirC": round(t_air, 1), "effectiveHWm2K": round(h_final, 2)},
        "parts": parts,
        "verdict": verdict,
        "worstMarginC": round(worst_margin, 1) if worst_margin != math.inf else None,
        "designLevers": levers,
        "honesty": "REVIEW-REQUIRED: lumped 1-node model; natural convection + generic "
                   "theta_JA/emissivity assumed unless supplied; no CFD, no transient, no "
                   "internal air-flow map. Sizing-grade only — confirm by measurement (Rec #3).",
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    ap.add_argument("--out")
    a = ap.parse_args()
    spec = json.load(open(a.spec)) if a.spec != "-" else json.load(sys.stdin)
    res = budget(spec)
    out = json.dumps(res, indent=1)
    if a.out:
        open(a.out, "w").write(out)
        print(f"wrote {a.out}: verdict {res['verdict']}, worst margin {res['worstMarginC']}C")
        for p in res["parts"][:3]:
            print(f"  {p['name']:22} {p['junctionC']}C / {p['limitC']}C  margin {p['marginC']}C  {p['status']}")
    else:
        print(out)

if __name__ == "__main__":
    main()
