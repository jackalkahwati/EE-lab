#!/usr/bin/env python3
"""Generic lumped-physics simulation runner (open-source: numpy + scipy).

Reads a sim request JSON on stdin (product/board/selected-design parameters),
runs the applicable REAL simulations, and prints a JSON list of results.
Fidelity tiers, each labeled on its result:
  - fem3d:    TRUE 3D FEA — gmsh C3D10 tet mesh + CalculiX modal solve, on the
              board slab and on the run's ACTUAL Onshape enclosure STEP.
  - fem:      2D FEM (scikit-fem) — thermal plate solve, Kirchhoff modal.
  - analytic/surrogate: genuine physics at lumped fidelity (acoustics, BLE
              link budget, battery). Remaining install-gated upgrades:
              Elmer (acoustic FEM), openEMS (FDTD), OpenFOAM (CFD).
This never fabricates a number it can't compute.

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

# Any FEM degradation this run (import failure or a solve that raised) is
# recorded here and surfaced top-level as femAvailable/femErrors so the UI
# can never silently advertise scikit-fem while serving a fallback.
FEM_ERRORS = []

try:
    import skfem  # real open-source FEM (github.com/kinnala/scikit-fem)
    import scipy.sparse.linalg as _sla
    HAVE_SKFEM = True
except Exception as _e:
    HAVE_SKFEM = False
    FEM_ERRORS.append("scikit-fem unavailable: %s" % str(_e)[:120])


def _num(d, k, default=None):
    v = d.get(k)
    return float(v) if isinstance(v, (int, float)) else default


def _plate_dims(req):
    """Board plate (Lx, Ly) in metres. Prefers the REAL board w x h when the
    caller sends it (boardMm), then the envelope aspect scaled to the board
    area, then the envelope itself, then the old square-of-area fallback."""
    bm = req.get("boardMm") or {}
    bw = _num(bm, "w") if isinstance(bm, dict) else None
    bh = _num(bm, "h") if isinstance(bm, dict) else None
    if bw and bh:
        return bw / 1e3, bh / 1e3
    env = req.get("envelopeMm") or {}
    ex = _num(env, "x") if isinstance(env, dict) else None
    ey = _num(env, "y") if isinstance(env, dict) else None
    area_mm2 = _num(req, "boardAreaMm2")
    if area_mm2 and ex and ey:
        # keep the real footprint aspect, scaled to the actual board area
        aspect = ex / ey
        ly = (area_mm2 / aspect) ** 0.5
        return aspect * ly / 1e3, ly / 1e3
    if area_mm2:
        s = (area_mm2 ** 0.5) / 1e3
        return s, s
    if ex and ey:
        return ex / 1e3, ey / 1e3
    return 0.025, 0.025


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
    layers_in = _num(req, "layerCount")
    layers = layers_in or 4
    layers_assumed = layers_in is None
    if active_mw is None:
        return None
    P = active_mw / 1000.0  # W dissipated
    fem_error = None
    # Real FEM path: solve the plate heat equation over the actual board footprint.
    if HAVE_SKFEM:
        try:
            Lx, Ly = _plate_dims(req)
            t_board = 1.6e-3
            # sheet thermal conductance kt = Σ k_i·t_i (copper planes ~35µm @ ~70%
            # coverage + FR4) — real material physics, scaled by layer count.
            kt = 385.0 * layers * 35e-6 * 0.7 + 0.3 * t_board
            h2 = 2 * 10.0                 # natural convection off both faces, W/m^2K
            a_mcu = 25e-6                 # ~5x5mm main-IC footprint, m^2
            r = _thermal_fem(P, Lx, Ly, kt, h2, 22.0, P / a_mcu, a_mcu, layers)
            r["detail"]["boardMm"] = [round(Lx * 1e3, 1), round(Ly * 1e3, 1)]
            if layers_assumed:
                r["detail"]["layersAssumed"] = True
                r.setdefault("assumptions", []).append("layerCount=4 assumed (not provided)")
                r["note"] += (" Layer count ASSUMED 4 (not provided) — copper sheet "
                              "conductance scales with layer count, so a 2-layer board "
                              "runs hotter than shown.")
            return r
        except Exception as e:
            # fall through to the lumped model, honestly labeled — and RECORD
            # that FEM was attempted and failed so the run can't overclaim FEM.
            fem_error = "thermal FEM failed: %s" % str(e)[:120]
            FEM_ERRORS.append(fem_error)
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
    note = "junction->case->ambient lumped network; not a 3D CFD/FEA thermal sim"
    detail = {"junctionTempC": round(Tj_ss, 1), "riseC": round(dT_ss, 2),
              "R_amb_KperW": round(R_amb, 1), "settleSec": round(settle) if settle else None,
              "powerW": round(P, 3)}
    if fem_error:
        detail["femDegraded"] = True
        note = ("FEM ATTEMPTED BUT FAILED this run (%s) — degraded to the lumped "
                "model: %s" % (fem_error, note))
    return {
        "sim": "thermal", "physics": "lumped RC (scipy)" if HAVE_SCIPY else "lumped RC",
        "metric": "case temp", "value": round(Tcase_ss, 1), "unit": "°C",
        "limit": skin_limit, "pass": Tcase_ss <= skin_limit,
        "fidelity": "lumped", "tool": "scipy.integrate" if HAVE_SCIPY else "numpy",
        "detail": detail,
        "note": note,
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
    frequency when available; else an analytic half-sine contact estimate."""
    mass_g = _num(req, "massG")
    if mass_g is None:
        return None
    fem_error = None
    if HAVE_SKFEM:
        try:
            Lx, Ly = _plate_dims(req)
            # FR4 laminate: in-plane modulus ~22 GPa, ν 0.15, ρ 1900, 1.6mm.
            f0, nodes, elems = _modal_fem(Lx, Ly, 1.6e-3, 22e9, 0.15, 1900.0)
            f_min = 500.0  # first mode well above drop/shock excitation → flex-robust
            note = ("real modal FEM (scikit-fem, Morley plate): the board's fundamental "
                    "frequency. BCs: ALL edges clamped (mounted-edge idealization — "
                    "freer mountings lower f0); bare-board mass only, component mass "
                    "loading (massG) NOT modeled, which also lowers the real f0. A full "
                    "transient drop (contact + explicit dynamics) is the next-fidelity "
                    "upgrade (CalculiX).")
            detail = {"nodes": nodes, "elements": elems,
                      "boardMm": [round(Lx * 1e3, 1), round(Ly * 1e3, 1)],
                      "bcs": "all edges clamped", "componentMassIncluded": False,
                      "note_criterion": "f0 above the shock band → low flex, low solder strain"}
            passed = f0 >= f_min
            if passed and f0 > 10 * f_min:
                # a 25x margin on a tiny stiff board means the criterion isn't
                # doing any real discriminating — say so, don't wear it as a badge.
                detail["marginRatio"] = round(f0 / f_min, 1)
                note += (" Limit passed by >10x — this check is not discriminating "
                         "for this board class; treat the green as 'no flex concern "
                         "flagged', not as a validated drop test.")
            return {
                "sim": "drop", "physics": "Kirchhoff-plate modal FEM (fundamental frequency)",
                "metric": "board f0", "value": round(f0), "unit": "Hz",
                "limit": f_min, "pass": passed,
                "fidelity": "fem", "tool": "scikit-fem",
                "detail": detail,
                "note": note,
            }
        except Exception as e:
            # fall through to the analytic estimate, honestly labeled — and RECORD
            # that FEM was attempted and failed so the run can't overclaim FEM.
            fem_error = "drop FEM failed: %s" % str(e)[:120]
            FEM_ERRORS.append(fem_error)
    # Analytic fallback: half-sine elastic contact, so the estimate actually USES
    # the device mass (and drop height when given) instead of returning a constant:
    # peak accel = v·√(k/m). The contact stiffness is an ASSUMED housing property.
    m = mass_g / 1000.0
    h_in = _num(req, "dropHeightM")
    h = h_in if (h_in and h_in > 0) else 1.5  # typical waist/ear height drop, m
    g = 9.81
    v = (2 * g * h) ** 0.5
    E = 0.5 * m * v * v
    k_contact = 5.0e5  # ASSUMED plastic-housing contact stiffness, N/m
    peak_g = v * (k_contact / m) ** 0.5 / g
    limit_g = 5000.0  # small SMD/BGA solder-joint survivability ballpark
    assumptions = ["contactStiffness=5e5 N/m assumed (plastic housing)"]
    if h_in is None:
        assumptions.append("dropHeight=1.5 m assumed (not in spec)")
    passed = peak_g <= limit_g
    note = ("half-sine contact estimate: peak decel = v·√(k/m) from device mass "
            "and drop height; contact stiffness is ASSUMED (result scales with "
            "√k — order-of-magnitude only). A real drop needs explicit-dynamics "
            "FEA (CalculiX).")
    detail = {"dropHeightM": h, "impactVelMs": round(v, 2), "impactEnergyJ": round(E, 4),
              "massG": mass_g, "contactStiffnessNperM": k_contact}
    if passed and peak_g > 0 and limit_g / peak_g > 10:
        detail["marginRatio"] = round(limit_g / peak_g, 1)
        note += (" Limit passed by >10x — this check is not discriminating for "
                 "this board class.")
    if fem_error:
        detail["femDegraded"] = True
        note = ("FEM ATTEMPTED BUT FAILED this run (%s) — degraded to the analytic "
                "estimate: %s" % (fem_error, note))
    return {
        "sim": "drop", "physics": "half-sine elastic contact",
        "metric": "peak decel", "value": round(peak_g), "unit": "g",
        "limit": limit_g, "pass": passed,
        "fidelity": "analytic", "tool": "numpy",
        "detail": detail,
        "assumptions": assumptions,
        "note": note,
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
    target = _num(req, "runtimeTargetHours", 12.0)
    sleep_uw = _num(req, "sleepUw")
    duty = _num(req, "dutyCycle")
    duty_assumed = bool(req.get("dutyCycleAssumed"))
    assumptions = []
    if sleep_uw is not None and duty is not None and 0.0 < duty <= 1.0:
        # Real duty-cycled sensor/wearable: MCU is active a small fraction of the
        # time and in deep sleep the rest. Average power, not peak, sets runtime.
        sleep_mw = sleep_uw / 1000.0
        avg_mw = active_mw * duty + sleep_mw * (1.0 - duty)
        hours = (mah * 3.7) / avg_mw
        detail = {"capacityMwh": round(mah * 3.7), "avgPowerMw": round(avg_mw, 4),
                  "dutyCycle": duty, "activeMw": round(active_mw, 3), "sleepUw": round(sleep_uw, 3)}
        if duty_assumed:
            # The duty cycle is an INJECTED DEFAULT, not a spec value — and it can
            # flip this check FAIL→PASS, so it must be loudly labeled as assumed.
            detail["dutyCycleAssumed"] = True
            assumptions.append("dutyCycle=%.4g assumed (not in spec)" % duty)
            note = ("duty-cycled @ ASSUMED {:.1%} active (no duty cycle in the spec — "
                    "this is a default, not a measured or specified value) @ {:.3g}mW, "
                    "{:.1%} sleep @ {:.3g}µW (avg {:.4g}mW). Runtime PASS/FAIL hinges on "
                    "this assumption — validate the real duty cycle in firmware. "
                    "Ignores battery derating.".format(
                        duty, active_mw, 1.0 - duty, sleep_uw, avg_mw))
        else:
            note = ("duty-cycled: {:.1%} active @ {:.3g}mW, {:.1%} sleep @ {:.3g}µW "
                    "(avg {:.4g}mW); ignores battery derating".format(
                        duty, active_mw, 1.0 - duty, sleep_uw, avg_mw))
    else:
        # No sleep/duty data — honest constant-load fallback.
        hours = (mah * 3.7) / active_mw
        detail = {"capacityMwh": round(mah * 3.7)}
        note = "constant-load energy model; ignores duty cycle + derating"
    r = {
        "sim": "battery", "physics": "energy balance",
        "metric": "runtime", "value": round(hours, 1), "unit": "h",
        "limit": target, "pass": hours >= target,
        "fidelity": "analytic", "tool": "numpy",
        "detail": detail,
        "note": note,
    }
    if assumptions:
        r["assumptions"] = assumptions
    return r


# --------------------------------------------------------------------------
# 3D FEA domains (gmsh + CalculiX). Install-gated: when the solver is absent
# the domain reports a 'gated' row with the install path — never a fake number.
# --------------------------------------------------------------------------
import glob as _glob
import os as _os
import re as _re
import shutil as _shutil
import subprocess as _sp
import tempfile as _tempfile


def _ccx_bin():
    p = _shutil.which("ccx")
    if p:
        return p
    cands = sorted(_glob.glob("/opt/homebrew/bin/ccx_*") + _glob.glob("/usr/local/bin/ccx_*"))
    return cands[-1] if cands else None


def solver_inventory():
    """Which high-fidelity solvers exist on this machine. Reported verbatim to
    the UI so the install-gate copy reflects reality, not a hardcoded list."""
    return {
        "gmsh": _shutil.which("gmsh") or ("python-gmsh" if _HAVE_GMSH_PY else None),
        "calculix": _ccx_bin(),
        "elmer": _shutil.which("ElmerSolver"),
        "openems": _shutil.which("openEMS"),
        "openfoam": _shutil.which("foamRun") or _shutil.which("simpleFoam"),
    }


try:
    import gmsh as _gmsh  # python API (pip gmsh) — meshing for the FEA domains
    _HAVE_GMSH_PY = True
except Exception:
    _HAVE_GMSH_PY = False


def _mesh_to_inp(out_inp, box=None, step=None, clmax=None):
    """Mesh a box (meters) or the largest solid of a STEP file to a 2nd-order
    tet mesh (C3D10), written as an Abaqus/CalculiX .inp with ELSET=PART.
    Returns (nodes, elements, pickedVolumeNote)."""
    _gmsh.initialize()
    try:
        _gmsh.option.setNumber("General.Terminal", 0)
        _gmsh.model.add("part")
        note = ""
        if box is not None:
            lx, ly, lz = box
            _gmsh.model.occ.addBox(0, 0, 0, lx, ly, lz)
            _gmsh.model.occ.synchronize()
            vols = _gmsh.model.getEntities(3)
        else:
            _gmsh.option.setNumber("Geometry.OCCScaling", 0.001)  # STEP mm -> m
            _gmsh.model.occ.importShapes(step)
            _gmsh.model.occ.synchronize()
            vols = _gmsh.model.getEntities(3)
            if not vols:
                raise RuntimeError("no solid volumes in STEP")
            if len(vols) > 1:
                # multi-body part (base + lid + features): analyze the LARGEST
                # body — disconnected bodies would add 6 rigid modes each.
                vols = [max(vols, key=lambda dt: _gmsh.model.occ.getMass(dt[0], dt[1]))]
                note = "multi-body STEP: largest body analyzed"
        _gmsh.model.addPhysicalGroup(3, [v[1] for v in vols], name="PART")
        if clmax:
            _gmsh.option.setNumber("Mesh.MeshSizeMax", clmax)
            _gmsh.option.setNumber("Mesh.MeshSizeMin", clmax / 5.0)
        _gmsh.option.setNumber("Mesh.ElementOrder", 2)  # C3D10
        # midside nodes on STRAIGHT edges: curving them onto cylindrical faces
        # at coarse sizes creates nonpositive-Jacobian tets that ccx rejects
        _gmsh.option.setNumber("Mesh.SecondOrderLinear", 1)
        _gmsh.model.mesh.generate(3)
        _gmsh.write(out_inp)
        n_nodes = len(_gmsh.model.mesh.getNodes()[0])
        n_elems = sum(len(t) for t in _gmsh.model.mesh.getElements(3)[1])
        return n_nodes, n_elems, note
    finally:
        _gmsh.finalize()


def _ccx_modal(workdir, mesh_inp, E, nu, rho, n_modes=12):
    """Free-free modal analysis in CalculiX; returns frequencies (Hz)."""
    deck = _os.path.join(workdir, "job.inp")
    with open(deck, "w") as f:
        f.write(
            "*INCLUDE, INPUT=%s\n"
            "*MATERIAL, NAME=MAT\n*ELASTIC\n%g, %g\n*DENSITY\n%g\n"
            "*SOLID SECTION, ELSET=PART, MATERIAL=MAT\n"
            "*STEP\n*FREQUENCY\n%d\n*END STEP\n"
            % (_os.path.basename(mesh_inp), E, nu, rho, n_modes))
    env = dict(_os.environ, OMP_NUM_THREADS="4")
    _sp.run([_ccx_bin(), "-i", "job"], cwd=workdir, env=env, timeout=120,
            stdout=_sp.DEVNULL, stderr=_sp.DEVNULL, check=False)
    dat = _os.path.join(workdir, "job.dat")
    if not _os.path.exists(dat):
        raise RuntimeError("ccx produced no .dat output")
    freqs = []
    in_table = False
    for line in open(dat, errors="replace"):
        if "E I G E N V A L U E" in line:
            in_table = True
            continue
        if in_table:
            nums = _re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", line)
            if len(nums) >= 4 and _re.match(r"\s*\d+\s", line):
                # columns: mode, eigenvalue, omega(rad/s), freq(Hz), [imag]
                freqs.append(float(nums[3]))
            elif freqs and not line.strip():
                break
    if not freqs:
        raise RuntimeError("no eigenvalue table in ccx output")
    return freqs


def _first_elastic(freqs):
    """First non-rigid frequency of a free-free solve. Rigid modes are ~0 Hz
    but come out of ARPACK as up to a few Hz of numerical noise; elastic modes
    of these small stiff parts are 100s-1000s of Hz, so 20 Hz separates them
    cleanly."""
    for f in freqs:
        if f > 20.0:
            return f
    return None


def _gated_row(sim, metric, solver_label, install_hint):
    return {
        "sim": sim, "physics": "3D FEA", "metric": metric,
        "value": None, "unit": "", "limit": None, "pass": None,
        "fidelity": "gated", "tool": solver_label,
        "note": "install-gated: %s" % install_hint,
    }


def structural3d(req):
    """Board 3D solid modal FEA (gmsh C3D10 mesh + CalculiX, free-free): the
    board's first elastic mode from TRUE 3D elasticity — the next-fidelity
    check above the 2D Kirchhoff plate in `drop`."""
    if not (_ccx_bin() and _HAVE_GMSH_PY):
        return _gated_row("structural 3D FEA", "board first elastic mode",
                          "CalculiX + gmsh (not installed)",
                          "brew install costerwi/calculix/calculix-ccx")
    Lx, Ly = _plate_dims(req)
    t = 0.0016  # standard 1.6 mm stackup
    with _tempfile.TemporaryDirectory() as wd:
        mesh = _os.path.join(wd, "mesh.inp")
        n_nodes, n_elems, _ = _mesh_to_inp(mesh, box=(Lx, Ly, t),
                                           clmax=max(Lx, Ly) / 10.0)
        freqs = _ccx_modal(wd, mesh, E=22e9, nu=0.13, rho=1850, n_modes=12)
    f1 = _first_elastic(freqs)
    if f1 is None:
        raise RuntimeError("no elastic mode found (all rigid)")
    return {
        "sim": "structural 3D FEA", "physics": "3D solid elasticity (modal)",
        "metric": "board first elastic mode", "value": round(f1, 1), "unit": "Hz",
        "limit": None, "pass": None,
        "fidelity": "fem3d", "tool": "gmsh + CalculiX %s" % _os.path.basename(_ccx_bin() or ""),
        "detail": {"modesHz": [round(f, 1) for f in freqs if f > 1.0][:5],
                   "nodes": n_nodes, "elementsC3D10": n_elems,
                   "boardMm": [round(Lx * 1e3, 1), round(Ly * 1e3, 1), t * 1e3]},
        "note": ("REAL 3D FEA: gmsh C3D10 tets solved in CalculiX, free-free. "
                 "ASSUMED FR4 E=22 GPa, nu=0.13, rho=1850 (bare laminate; "
                 "components add mass -> real f1 is somewhat lower). Higher "
                 "f1 = stiffer board = better shock/vibration margin."),
    }


def enclosure_fea(req):
    """Enclosure 3D modal FEA on the REAL Onshape CAD (STEP) — meshes the
    actual generated geometry, not an idealization. Skipped (None) when the
    run has no enclosure yet; gated when the solver is missing."""
    step = req.get("enclosureStep")
    if not (isinstance(step, str) and _os.path.exists(step)):
        return None  # no enclosure built for this run yet — nothing to claim
    if not (_ccx_bin() and _HAVE_GMSH_PY):
        return _gated_row("enclosure 3D FEA", "shell first elastic mode",
                          "CalculiX + gmsh (not installed)",
                          "brew install costerwi/calculix/calculix-ccx")
    with _tempfile.TemporaryDirectory() as wd:
        mesh = _os.path.join(wd, "mesh.inp")
        n_nodes, n_elems, body_note = _mesh_to_inp(mesh, step=step, clmax=0.003)
        freqs = _ccx_modal(wd, mesh, E=2.3e9, nu=0.37, rho=1120, n_modes=12)
    f1 = _first_elastic(freqs)
    if f1 is None:
        raise RuntimeError("no elastic mode found (all rigid)")
    return {
        "sim": "enclosure 3D FEA", "physics": "3D solid elasticity (modal)",
        "metric": "shell first elastic mode", "value": round(f1, 1), "unit": "Hz",
        "limit": None, "pass": None,
        "fidelity": "fem3d", "tool": "gmsh + CalculiX %s" % _os.path.basename(_ccx_bin() or ""),
        "detail": {"modesHz": [round(f, 1) for f in freqs if f > 1.0][:5],
                   "nodes": n_nodes, "elementsC3D10": n_elems,
                   **({"body": body_note} if body_note else {})},
        "note": ("REAL 3D FEA on the run's actual Onshape STEP (gmsh C3D10 + "
                 "CalculiX, free-free%s). ASSUMED PC/ABS E=2.3 GPa, nu=0.37, "
                 "rho=1120. A stiff shell (higher f1) resists drop flex and "
                 "rattling; drive material/ribs from this, not from guesses."
                 % ((", " + body_note) if body_note else "")),
    }


SIMS = [thermal, drop, structural3d, enclosure_fea, acoustic, rf, battery]


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
    # femAvailable: the advertised scikit-fem path was importable AND no FEM
    # solve failed this run. Any import failure or per-sim FEM exception lands
    # in femErrors (and the affected result's note says it degraded), so a
    # degraded run is visibly degraded, never silently relabeled.
    print(json.dumps({"scipy": HAVE_SCIPY,
                      "femAvailable": HAVE_SKFEM and not FEM_ERRORS,
                      "femErrors": FEM_ERRORS,
                      "solvers": solver_inventory(),
                      "results": results}, default=_json_default))


if __name__ == "__main__":
    main()
