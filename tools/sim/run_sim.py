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

try:
    import skfem  # real open-source FEM (github.com/kinnala/scikit-fem)
    import scipy.sparse.linalg as _sla
    HAVE_SKFEM = True
except Exception:
    HAVE_SKFEM = False


def _num(d, k, default=None):
    v = d.get(k)
    return float(v) if isinstance(v, (int, float)) else default


def _thermal_fem(P, Lx, Ly, kt, h2, Tamb, q_density, a_mcu, layers):
    """REAL 2D finite-element steady-state heat solve of the board as a conductive
    plate: k*t·∇²T - 2h·(T-Tamb) + q'' = 0, with the MCU power as a distributed
    areal source over its footprint and convection off BOTH surfaces. Genuine
    spatially-resolved field (peak/edge/gradient), not a single lumped node."""
    from skfem import MeshTri, Basis, ElementTriP1, BilinearForm, LinearForm
    from skfem.helpers import dot, grad
    nx = max(24, min(120, int(Lx * 1e3 / 1.2)))
    ny = max(24, min(120, int(Ly * 1e3 / 1.2)))
    m = MeshTri.init_tensor(np.linspace(0, Lx, nx), np.linspace(0, Ly, ny))
    basis = Basis(m, ElementTriP1())
    cx, cy, hw = Lx / 2, Ly / 2, (a_mcu ** 0.5) / 2

    @BilinearForm
    def bil(u, v, w):
        return kt * dot(grad(u), grad(v)) + h2 * u * v

    @LinearForm
    def lin(v, w):
        x, y = w.x
        q = np.where((np.abs(x - cx) <= hw) & (np.abs(y - cy) <= hw), q_density, 0.0)
        return (q + h2 * Tamb) * v

    T = _sla.spsolve(bil.assemble(basis), lin.assemble(basis))
    Tmax, Tmean, Tedge = float(T.max()), float(T.mean()), float(T.min())
    skin_limit = 43.0  # IEC touch-temp for a worn/handled device
    return {
        "sim": "thermal", "physics": "2D FEM steady-state heat conduction (plate + two-surface convection)",
        "metric": "peak temp", "value": round(Tmax, 1), "unit": "°C",
        "limit": skin_limit, "pass": Tmax <= skin_limit,
        "fidelity": "fem", "tool": "scikit-fem",
        "detail": {"meanTempC": round(Tmean, 1), "edgeTempC": round(Tedge, 1),
                   "gradientC": round(Tmax - Tedge, 1),
                   "sheetConductanceWperK": round(kt, 4), "convectionWperm2K": round(h2, 1),
                   "nodes": int(basis.N), "elements": int(m.t.shape[1]),
                   "powerW": round(P, 3), "layers": int(layers)},
        "note": "real 2D FEM (scikit-fem): plate heat equation, distributed MCU source, "
                "convection off both surfaces — a spatially-resolved field, not a lumped node. "
                "Full 3D CFD (OpenFOAM) is the next-fidelity upgrade.",
    }


def thermal(req):
    """Board thermal. Real 2D FEM (scikit-fem) when available; else lumped RC."""
    active_mw = _num(req, "activeMw")
    area_mm2 = _num(req, "boardAreaMm2")
    env = req.get("envelopeMm") or {}
    layers = _num(req, "layerCount", 4) or 4
    if active_mw is None:
        return None
    P = active_mw / 1000.0  # W dissipated
    # Real FEM path: solve the plate heat equation over the actual board footprint.
    if HAVE_SKFEM:
        try:
            if area_mm2:
                Lx = Ly = (area_mm2 ** 0.5) / 1e3
            elif env.get("x") and env.get("y"):
                Lx, Ly = env["x"] / 1e3, env["y"] / 1e3
            else:
                Lx = Ly = 0.025
            t_board = 1.6e-3
            # sheet thermal conductance kt = Σ k_i·t_i (copper planes ~35µm @ ~70%
            # coverage + FR4) — real material physics, scaled by layer count.
            kt = 385.0 * layers * 35e-6 * 0.7 + 0.3 * t_board
            h2 = 2 * 10.0                 # natural convection off both faces, W/m^2K
            a_mcu = 25e-6                 # ~5x5mm main-IC footprint, m^2
            return _thermal_fem(P, Lx, Ly, kt, h2, 22.0, P / a_mcu, a_mcu, layers)
        except Exception:
            pass  # fall through to the lumped model, honestly labeled
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


def _modal_fem(Lx, Ly, t, E, nu, rho):
    """REAL Kirchhoff-plate modal FEM (scikit-fem, Morley element): solve the
    biharmonic eigenproblem D∇⁴w = ρ_A ω²w for the board's fundamental frequency.
    The first mode governs board flex under shock — a higher f0 (stiffer board)
    means less deflection and lower solder-joint strain in a drop."""
    from skfem import MeshTri, Basis, ElementTriMorley, BilinearForm
    from skfem.helpers import dd, ddot, trace, eye
    ar = max(1, int(round(20 * Ly / Lx)))
    m = MeshTri.init_tensor(np.linspace(0, Lx, 20), np.linspace(0, Ly, ar))
    ib = Basis(m, ElementTriMorley())
    D = E * t ** 3 / (12 * (1 - nu ** 2))
    rhoA = rho * t

    def Cc(M):
        return D * ((1 - nu) * M + nu * eye(trace(M), 2))

    @BilinearForm
    def stiff(u, v, w):
        return ddot(Cc(dd(u)), dd(v))

    @BilinearForm
    def mass(u, v, w):
        return rhoA * u * v

    K = stiff.assemble(ib)
    M = mass.assemble(ib)
    bdofs = ib.get_dofs().all()                       # clamp the mounted edges
    keep = np.setdiff1d(np.arange(K.shape[0]), bdofs)
    ev, _ = _sla.eigsh(K[keep][:, keep].tocsc(), k=1, M=M[keep][:, keep].tocsc(),
                       sigma=0, which='LM')
    f0 = float(np.sqrt(abs(ev[0])) / (2 * np.pi))
    return f0, int(ib.N), int(m.t.shape[1])


def drop(req):
    """Board mechanical robustness. Real modal FEM (scikit-fem) for the fundamental
    frequency when available; else the analytic drop-impulse estimate."""
    mass_g = _num(req, "massG")
    area_mm2 = _num(req, "boardAreaMm2")
    env = req.get("envelopeMm") or {}
    if mass_g is None:
        return None
    if HAVE_SKFEM:
        try:
            if area_mm2:
                Lx = Ly = (area_mm2 ** 0.5) / 1e3
            elif env.get("x") and env.get("y"):
                Lx, Ly = env["x"] / 1e3, env["y"] / 1e3
            else:
                Lx = Ly = 0.025
            # FR4 laminate: in-plane modulus ~22 GPa, ν 0.15, ρ 1900, 1.6mm.
            f0, nodes, elems = _modal_fem(Lx, Ly, 1.6e-3, 22e9, 0.15, 1900.0)
            f_min = 500.0  # first mode well above drop/shock excitation → flex-robust
            return {
                "sim": "drop", "physics": "Kirchhoff-plate modal FEM (fundamental frequency)",
                "metric": "board f0", "value": round(f0), "unit": "Hz",
                "limit": f_min, "pass": f0 >= f_min,
                "fidelity": "fem", "tool": "scikit-fem",
                "detail": {"nodes": nodes, "elements": elems, "boardMm": [round(Lx * 1e3), round(Ly * 1e3)],
                           "note_criterion": "f0 above the shock band → low flex, low solder strain"},
                "note": "real modal FEM (scikit-fem, Morley plate): the board's fundamental "
                        "frequency. A full transient drop (contact + explicit dynamics) is the "
                        "next-fidelity upgrade (CalculiX).",
            }
        except Exception:
            pass  # fall through to the analytic estimate, honestly labeled
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
