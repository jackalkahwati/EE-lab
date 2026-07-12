#!/usr/bin/env python3
"""Generic lumped-physics simulation runner (open-source: numpy + scipy).

Reads a sim request JSON on stdin (product/board/selected-design parameters),
runs the applicable REAL lumped-parameter simulations, and prints a JSON list of
results. These are genuine physics (thermal RC network solved with scipy, drop
impact, sealed-box acoustics, BLE link budget) at 'lumped'/'analytic' fidelity —
NOT full 3D FEA/FDTD. High-fidelity solvers (Elmer/CalculiX/openEMS/OpenFOAM)
are the install-gated upgrade; this never fabricates a number it can't compute.

Usage:  python3 run_sim.py  < request.json
"""
from __future__ import annotations
import json
import sys

import numpy as np

try:
    from scipy.integrate import solve_ivp
    HAVE_SCIPY = True
except Exception:
    HAVE_SCIPY = False


def _num(d, k, default=None):
    v = d.get(k)
    return float(v) if isinstance(v, (int, float)) else default


def thermal(req):
    """Lumped RC thermal model: junction -> case -> ambient. scipy transient."""
    active_mw = _num(req, "activeMw")
    area_mm2 = _num(req, "boardAreaMm2")
    env = req.get("envelopeMm") or {}
    if active_mw is None:
        return None
    P = active_mw / 1000.0  # W dissipated
    # enclosure surface area (m^2) from envelope, else from board area
    if env.get("x") and env.get("y") and env.get("z"):
        x, y, z = env["x"] / 1e3, env["y"] / 1e3, env["z"] / 1e3
        A = 2 * (x * y + y * z + x * z)
    elif area_mm2:
        s = (area_mm2 ** 0.5) / 1e3
        A = 6 * s * s
    else:
        A = 6 * (0.012 ** 2)
    h = 10.0  # natural convection W/m^2K
    R_amb = 1.0 / max(h * A, 1e-6)   # case -> ambient
    R_jc = 8.0                        # junction -> case (small package, K/W)
    C = 0.6                           # lumped heat capacity J/K
    Tamb = 22.0
    dT_ss = P * R_amb                 # steady case rise
    Tj_ss = Tamb + P * (R_amb + R_jc)
    settle = None
    if HAVE_SCIPY:
        def f(t, T):
            return [(P - (T[0] - Tamb) / R_amb) / C]
        sol = solve_ivp(f, [0, 3600], [Tamb], t_eval=np.linspace(0, 3600, 200))
        Tcase = sol.y[0]
        target = Tamb + 0.95 * dT_ss
        idx = np.argmax(Tcase >= target) if np.any(Tcase >= target) else -1
        settle = float(sol.t[idx]) if idx >= 0 else None
    skin_limit = 43.0  # IEC 60950 touch temp for wearables
    Tcase_ss = Tamb + dT_ss
    return {
        "sim": "thermal", "physics": "lumped RC (scipy)" if HAVE_SCIPY else "lumped RC",
        "metric": "case temp", "value": round(Tcase_ss, 1), "unit": "°C",
        "limit": skin_limit, "pass": Tcase_ss <= skin_limit,
        "fidelity": "lumped", "tool": "scipy.integrate" if HAVE_SCIPY else "numpy",
        "detail": {"junctionTempC": round(Tj_ss, 1), "riseC": round(dT_ss, 2),
                    "R_amb_KperW": round(R_amb, 1), "settleSec": round(settle) if settle else None,
                    "powerW": round(P, 3)},
        "note": "junction->case->ambient lumped network; not a 3D CFD/FEA thermal sim",
    }


def drop(req):
    """Free-fall drop impact: velocity, energy, peak-G (assumed contact time)."""
    mass_g = _num(req, "massG")
    if mass_g is None:
        return None
    m = mass_g / 1000.0
    h = 1.5  # typical waist/ear height drop, m
    g = 9.81
    v = (2 * g * h) ** 0.5
    E = 0.5 * m * v * v
    dt = 1.0e-3  # rigid-ish contact time
    peak_g = (v / dt) / g
    limit_g = 5000.0  # small SMD/BGA solder-joint survivability ballpark
    return {
        "sim": "drop", "physics": "impulse-momentum",
        "metric": "peak decel", "value": round(peak_g), "unit": "g",
        "limit": limit_g, "pass": peak_g <= limit_g,
        "fidelity": "analytic", "tool": "numpy",
        "detail": {"dropHeightM": h, "impactVelMs": round(v, 2), "impactEnergyJ": round(E, 4)},
        "note": "rigid-contact estimate; a real drop needs explicit-dynamics FEA (CalculiX)",
    }


def acoustic(req):
    """Sealed back-volume low-frequency behaviour (Helmholtz-ish estimate)."""
    env = req.get("envelopeMm") or {}
    area_mm2 = _num(req, "boardAreaMm2")
    if env.get("x") and env.get("y") and env.get("z"):
        Vb = (env["x"] * env["y"] * env["z"]) * 1e-9 * 0.4  # m^3, ~40% free
    elif area_mm2:
        Vb = area_mm2 * 4.0 * 1e-9 * 0.4
    else:
        return None
    # larger sealed volume -> lower system resonance -> more low-end extension
    f0 = 220.0 / max(Vb / 1e-6, 1.0) ** 0.33  # coarse scaling, Hz
    score = float(np.clip(100 - (f0 - 120) * 0.3, 0, 100))
    return {
        "sim": "acoustic", "physics": "sealed-box estimate",
        "metric": "system f0", "value": round(f0), "unit": "Hz",
        "limit": None, "pass": None,
        "fidelity": "analytic", "tool": "numpy",
        "detail": {"backVolumeMm3": round(Vb * 1e9), "lowEndScore": round(score, 1)},
        "note": "lumped sealed-box scaling; a real acoustic sim needs FEM (Elmer) + driver TS params",
    }


def rf(req):
    """BLE link budget with enclosure/antenna detuning penalty (surrogate)."""
    place = str(req.get("antennaPlacement", "")).lower()
    mat = str(req.get("enclosureMaterial", "")).lower()
    tx_dbm, rx_sens = 0.0, -95.0
    d, f = 10.0, 2.44e9
    fspl = 20 * np.log10(d) + 20 * np.log10(f) - 147.55  # dB
    ant_gain = -2.0
    if any(k in place for k in ("in-ear", "canal", "deep", "concha")):
        ant_gain -= 6.0
    if any(k in mat for k in ("alum", "metal", "steel", "titan")):
        ant_gain -= 10.0
    margin = tx_dbm + ant_gain - fspl - rx_sens
    return {
        "sim": "rf", "physics": "link budget",
        "metric": "BLE link margin @10m", "value": round(margin, 1), "unit": "dB",
        "limit": 0.0, "pass": margin >= 0.0,
        "fidelity": "surrogate", "tool": "numpy",
        "detail": {"fsplDb": round(fspl, 1), "antGainDbi": round(ant_gain, 1)},
        "note": "link-budget surrogate; a real antenna sim needs FDTD (openEMS) with a body phantom",
    }


def battery(req):
    mah = _num(req, "batteryMah")
    active_mw = _num(req, "activeMw")
    if not mah or not active_mw:
        return None
    hours = (mah * 3.7) / active_mw
    target = _num(req, "runtimeTargetHours", 12.0)
    return {
        "sim": "battery", "physics": "energy balance",
        "metric": "runtime", "value": round(hours, 1), "unit": "h",
        "limit": target, "pass": hours >= target,
        "fidelity": "analytic", "tool": "numpy",
        "detail": {"capacityMwh": round(mah * 3.7)},
        "note": "constant-load energy model; ignores duty cycle + derating",
    }


SIMS = [thermal, drop, acoustic, rf, battery]


def _json_default(o):
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.floating):
        return float(o)
    raise TypeError("not serializable: %r" % type(o))


def main():
    req = json.load(sys.stdin)
    results = []
    for fn in SIMS:
        try:
            r = fn(req)
            if r:
                results.append(r)
        except Exception as e:
            results.append({"sim": fn.__name__, "error": str(e)[:160]})
    print(json.dumps({"scipy": HAVE_SCIPY, "results": results}, default=_json_default))


if __name__ == "__main__":
    main()
