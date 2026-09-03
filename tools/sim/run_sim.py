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


# ---- thermal model constants -------------------------------------------------
SOLVER_AMBIENT_C = 22.0     # benign lab ambient the solver runs at. The result reports
                            # the RISE over it; the judge (lib/sim-judge.ts) re-bases that
                            # rise onto the application ambient. Overridable via req.ambientC.
DEFAULT_LIMIT_C = 85.0      # junction rating used only when the caller sends no limitC
SKIN_LIMIT_C = 43.0         # IEC 62368-1 touch temperature — reported as METADATA only
                            # (skinLimitC); the judge applies it for skin-contact products.
                            # It is never the solver's pass/fail limit.
MODEL_INVALID_PEAK_C = 200.0  # no board runs at 200 °C — above this the MODEL (power/area
                              # input) is wrong, not the design; flagged modelInvalid.
BOARD_DISSIPATION_FRACTION = 0.25  # share of the product's activeMw budget assumed to be
                                   # dissipated ON the board when no rail data exists (the
                                   # rest is motors/LEDs/radio/loads off-board). MUST match
                                   # BOARD_DISSIPATION_FRACTION in lib/sim-judge.ts.
EMISSIVITY = 0.8            # solder mask / plastic surfaces
SIGMA = 5.670e-8            # Stefan-Boltzmann, W/m^2K^4
H_CONV = 10.0               # natural convection, W/m^2K per face
R_JC_KPERW = 8.0            # junction -> case, small package (K/W)


def _h_rad(t_surf_c, t_amb_c):
    """Linearized radiative coefficient W/m^2K about the film temperature."""
    ts = min(t_surf_c, MODEL_INVALID_PEAK_C) + 273.15
    ta = t_amb_c + 273.15
    tf = (ts + ta) / 2.0
    return 4.0 * EMISSIVITY * SIGMA * tf ** 3


def _rail_voltage(name):
    """'+3V3' -> 3.3, '+5V' -> 5.0, 'VBAT' -> 3.7, '12V' -> 12.0; None if unparseable."""
    import re
    n = str(name).upper()
    m = re.search(r"(\d+)V(\d+)", n)
    if m:
        return float(m.group(1)) + float(m.group(2)) / 10.0 ** len(m.group(2))
    m = re.search(r"(\d+(?:\.\d+)?)\s*V", n)
    if m:
        return float(m.group(1))
    if "VBAT" in n or "BAT" in n:
        return 3.7
    return None


def _board_power(req):
    """On-board dissipated power (W) and where the number came from.

    Preference order:
      'rails'          — the run's power-budget.json (or a rails list): IC rail
                         currents x rail voltage + regulator loss. Real per-device
                         numbers; still an upper bound where a rail feeds
                         off-board loads (a motor driver's 1.5 A goes to the motor).
      'board_fraction' — no usable rail data: BOARD_DISSIPATION_FRACTION of the
                         product's activeMw budget, confidence 'low'.
    Never the full activeMw: that is the PRODUCT consumption budget (motors,
    LEDs, radio) and dumping it into a 25 mm^2 patch produced 700 °C "results".
    Returns (P_W, source, confidence, note) or None when nothing is known."""
    active_mw = _num(req, "activeMw")
    parts = []
    p = 0.0
    pb = req.get("powerBudget")
    if isinstance(pb, dict):
        for name, r in (pb.get("rails") or {}).items():
            ma = _num(r, "worst_ma") if isinstance(r, dict) else None
            v = _rail_voltage(name)
            if ma and v:
                p += ma / 1e3 * v
                parts.append("%s %.0f mA x %.1f V" % (name, ma, v))
        reg = pb.get("regulator") if isinstance(pb.get("regulator"), dict) else {}
        loss = _num(reg, "loss_worst_mw")
        if loss:
            p += loss / 1e3
            parts.append("regulator loss %.0f mW" % loss)
    if p <= 0:
        pdn = req.get("pdn") if isinstance(req.get("pdn"), dict) else {}
        rails = req.get("rails") or pdn.get("rails")
        if isinstance(rails, list):
            for r in rails:
                if not isinstance(r, dict):
                    continue
                ma = _num(r, "worstMa") or _num(r, "worst_ma")
                v = _num(r, "voltage") or _rail_voltage(r.get("name", ""))
                if ma and v:
                    p += ma / 1e3 * v
                    parts.append("%s %.0f mA x %.1f V" % (r.get("name"), ma, v))
    if p > 0:
        note = "board power from rail data: " + ", ".join(parts)
        if active_mw and p > active_mw / 1e3:
            p = active_mw / 1e3
            note += " (capped at the %d mW product budget)" % active_mw
        return p, "rails", "normal", note
    if active_mw is None:
        return None
    return (active_mw / 1e3 * BOARD_DISSIPATION_FRACTION, "board_fraction", "low",
            "no rail data — on-board dissipation ASSUMED %.0f%% of the %d mW product budget "
            "(the rest is off-board loads); low confidence" % (BOARD_DISSIPATION_FRACTION * 100, active_mw))


def _thermal_result(metric, peak, Tamb, P, psrc, conf, pnote, limit_c, physics, fidelity, tool, detail, note):
    """Common thermal result shape. `pass` is judged against the CALLER's limitC
    (the application's junction rating), never the 43 °C skin number. The judge
    downstream works from riseC/powerW, so a solver ambient of 22 °C is fine."""
    rise = peak - Tamb
    invalid = peak > MODEL_INVALID_PEAK_C
    detail = dict(detail)
    detail["powerW"] = round(P, 3)
    detail["powerNote"] = pnote
    if invalid:
        note = ("MODEL INVALID: peak %.0f °C is not a physical board temperature — the "
                "power/area input is wrong for this model (%s). Not a design verdict. " % (peak, pnote)) + note
    return {
        "sim": "thermal", "physics": physics,
        "metric": metric, "value": round(peak, 1), "unit": "°C",
        "limit": limit_c, "limitC": limit_c,
        "pass": None if invalid else bool(peak <= limit_c),
        "peakC": round(peak, 1), "riseC": round(rise, 2), "solverAmbientC": Tamb,
        "powerW": round(P, 3), "powerSource": psrc, "confidence": conf,
        "rjcKperW": R_JC_KPERW, "skinLimitC": SKIN_LIMIT_C, "modelInvalid": invalid,
        "fidelity": fidelity, "tool": tool,
        "detail": detail, "note": note,
    }


def _thermal_fem_solve(Lx, Ly, kt, h2, Tamb, q_density, a_mcu):
    """REAL 2D finite-element steady-state heat solve of the board as a conductive
    plate: k*t·∇²T - h2·(T-Tamb) + q'' = 0, with the IC power as a distributed
    areal source over its footprint and convection+radiation off BOTH surfaces
    (h2 = 2·(h_conv + h_rad)). Returns (Tmax, Tmean, Tedge, nodes, elements)."""
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
    return float(T.max()), float(T.mean()), float(T.min()), int(basis.N), int(m.t.shape[1])


def _thermal_fem(P, Lx, Ly, kt, Tamb, a_mcu, layers):
    """Two-pass FEM: solve with h_rad linearized at an initial guess, then
    re-linearize at the resulting film temperature and solve again."""
    h_rad = _h_rad(Tamb + 20.0, Tamb)
    Tmax = Tmean = Tedge = Tamb
    nodes = elems = 0
    for _ in range(2):
        h2 = 2.0 * (H_CONV + h_rad)
        Tmax, Tmean, Tedge, nodes, elems = _thermal_fem_solve(Lx, Ly, kt, h2, Tamb, P / a_mcu, a_mcu)
        h_rad = _h_rad(Tmax, Tamb)
    return Tmax, Tmean, Tedge, nodes, elems, h2


def thermal(req):
    """Board thermal. Real 2D FEM (scikit-fem) when available; else lumped RC.
    Emits the RISE over the solver ambient + the on-board power and its source;
    pass/fail is against the caller's limitC (application junction rating)."""
    area_mm2 = _num(req, "boardAreaMm2")
    env = req.get("envelopeMm") or {}
    layers_in = _num(req, "layerCount")
    layers = layers_in or 4
    layers_assumed = layers_in is None
    pw = _board_power(req)
    if pw is None:
        return None
    P, psrc, conf, pnote = pw
    Tamb = _num(req, "ambientC") or SOLVER_AMBIENT_C
    limit_c = _num(req, "limitC") or DEFAULT_LIMIT_C
    fem_error = None
    # Real FEM path: solve the plate heat equation over the actual board footprint.
    if HAVE_SKFEM:
        try:
            Lx, Ly = _plate_dims(req)
            t_board = 1.6e-3
            # sheet thermal conductance kt = Σ k_i·t_i (copper planes ~35µm @ ~70%
            # coverage + FR4) — real material physics, scaled by layer count.
            kt = 385.0 * layers * 35e-6 * 0.7 + 0.3 * t_board
            a_mcu = 25e-6                 # ~5x5mm main-IC footprint, m^2
            Tmax, Tmean, Tedge, nodes, elems, h2 = _thermal_fem(P, Lx, Ly, kt, Tamb, a_mcu, layers)
            detail = {"meanTempC": round(Tmean, 1), "edgeTempC": round(Tedge, 1),
                      "gradientC": round(Tmax - Tedge, 1),
                      "sheetConductanceWperK": round(kt, 4), "convectionWperm2K": round(h2, 1),
                      "nodes": nodes, "elements": elems, "layers": int(layers),
                      "boardMm": [round(Lx * 1e3, 1), round(Ly * 1e3, 1)]}
            note = ("real 2D FEM (scikit-fem): plate heat equation, distributed IC source, "
                    "convection + linearized radiation off both surfaces — a spatially-resolved "
                    "field, not a lumped node. Peak is the board surface under the IC; add "
                    "P x Rjc for the junction. Full 3D CFD (OpenFOAM) is the next-fidelity upgrade.")
            r = _thermal_result("peak temp", Tmax, Tamb, P, psrc, conf, pnote, limit_c,
                                "2D FEM steady-state heat conduction (plate + two-surface convection + radiation)",
                                "fem", "scikit-fem", detail, note)
            if conf == "low":
                r.setdefault("assumptions", []).append(pnote)
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
    # convection + linearized radiation, re-linearized once at the solved surface temp
    h = H_CONV + _h_rad(Tamb + 20.0, Tamb)
    for _ in range(2):
        R_amb = 1.0 / max(h * A, 1e-6)   # case -> ambient
        dT_ss = P * R_amb                 # steady case rise
        h = H_CONV + _h_rad(Tamb + dT_ss, Tamb)
    R_amb = 1.0 / max(h * A, 1e-6)
    dT_ss = P * R_amb
    R_jc = R_JC_KPERW                 # junction -> case (small package, K/W)
    C = 0.6                           # lumped heat capacity J/K
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
    Tcase_ss = Tamb + dT_ss
    note = ("junction->case->ambient lumped network (convection + linearized radiation "
            "off the enclosure surface); not a 3D CFD/FEA thermal sim. Peak/riseC are the "
            "CASE; junctionTempC adds P x Rjc.")
    detail = {"junctionTempC": round(Tj_ss, 1), "riseC": round(dT_ss, 2),
              "R_amb_KperW": round(R_amb, 1), "R_jc_KperW": R_jc,
              "hTotalWperm2K": round(h, 1), "surfaceAreaM2": round(A, 5),
              "settleSec": round(settle) if settle else None}
    if fem_error:
        detail["femDegraded"] = True
        note = ("FEM ATTEMPTED BUT FAILED this run (%s) — degraded to the lumped "
                "model: %s" % (fem_error, note))
    r = _thermal_result("case temp", Tcase_ss, Tamb, P, psrc, conf, pnote, limit_c,
                        "lumped RC (scipy)" if HAVE_SCIPY else "lumped RC",
                        "lumped", "scipy.integrate" if HAVE_SCIPY else "numpy", detail, note)
    if conf == "low":
        r.setdefault("assumptions", []).append(pnote)
    return r


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
import threading as _threading

# gmsh's python API is a process-global singleton (initialize/finalize) —
# concurrent meshing from the parallel sim executor would corrupt it.
_GMSH_LOCK = _threading.Lock()


def _ccx_bin():
    p = _shutil.which("ccx")
    if p:
        return p
    cands = sorted(_glob.glob("/opt/homebrew/bin/ccx_*") + _glob.glob("/usr/local/bin/ccx_*"))
    return cands[-1] if cands else None


def _openems_py():
    try:
        import openEMS as _o  # python bindings are the integration surface
        return "python-openEMS"
    except Exception:
        return None


def solver_inventory():
    """Which high-fidelity solvers exist on this machine. Reported verbatim to
    the UI so the install-gate copy reflects reality, not a hardcoded list."""
    return {
        "gmsh": _shutil.which("gmsh") or ("python-gmsh" if _HAVE_GMSH_PY else None),
        "calculix": _ccx_bin(),
        "ngspice": _shutil.which("ngspice"),
        "elmer": (_shutil.which("ElmerSolver")
                  or (_os.path.expanduser("~/.local/elmer/bin/ElmerSolver")
                      if _os.path.exists(_os.path.expanduser("~/.local/elmer/bin/ElmerSolver"))
                      else None)),
        "openems": _shutil.which("openEMS") or _openems_py(),
        # native binaries on PATH, or the OpenFOAM.app launcher (brew
        # gerlero/openfoam) which wraps the whole toolchain
        "openfoam": (_shutil.which("foamRun") or _shutil.which("simpleFoam")
                     or _shutil.which("openfoam")),
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
    _GMSH_LOCK.acquire()
    # interruptible=False: skip gmsh's SIGINT handler — illegal off the main
    # thread, and these meshing calls run inside the parallel sim executor.
    _gmsh.initialize(interruptible=False)
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
        _GMSH_LOCK.release()


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
    # OMP_NUM_THREADS=1 is deliberate: multithreaded ccx has a race that
    # intermittently corrupts the free-free eigen solve (rigid-mode junk in
    # place of elastic modes) — single-thread is deterministic AND faster
    # on these small decks (0.7s vs 1.9s measured).
    env = dict(_os.environ, OMP_NUM_THREADS="1")
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
    # Large thin boards meshed coarsely give high-aspect tets whose eigen
    # solve intermittently returns only rigid-mode junk — retry finer once.
    f1 = None
    for clmax in (max(Lx, Ly) / 10.0, max(Lx, Ly) / 16.0):
        with _tempfile.TemporaryDirectory() as wd:
            mesh = _os.path.join(wd, "mesh.inp")
            n_nodes, n_elems, _ = _mesh_to_inp(mesh, box=(Lx, Ly, t), clmax=clmax)
            freqs = _ccx_modal(wd, mesh, E=22e9, nu=0.13, rho=1850, n_modes=12)
        f1 = _first_elastic(freqs)
        if f1 is not None:
            break
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


def pdn(req):
    """Rail decoupling AC impedance — REAL ngspice sweep of the network built
    from the run's actual netlist + power budget (see sim_spice.py)."""
    import sim_spice
    return sim_spice.run(req)


def cfd_thermal(req):
    """Natural-convection CFD — REAL OpenFOAM buoyant solve of the device in
    ambient air; computes the convection the 2D FEM assumes (see sim_cfd.py)."""
    import sim_cfd
    return sim_cfd.run(req)


def cavity_acoustic(req):
    """Cavity acoustic FEM — REAL Elmer wave-equation eigenanalysis of the
    enclosure's internal air volume (see sim_acoustic.py)."""
    import sim_acoustic
    return sim_acoustic.run(req)


def antenna_fdtd(req):
    """Antenna FDTD — REAL openEMS full-wave solve of a reference 2.4 GHz
    monopole against the run's actual board outline (see sim_em.py)."""
    import sim_em
    return sim_em.run(req)


SIMS = [thermal, drop, structural3d, enclosure_fea, pdn, cfd_thermal,
        cavity_acoustic, antenna_fdtd, acoustic, rf, battery]


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

    # The high-fidelity passes are subprocess-bound (ccx, ngspice, OpenFOAM,
    # docker solvers) — run them concurrently so the stage's wall time is the
    # slowest solver, not the sum. Result order stays SIMS order.
    from concurrent.futures import ThreadPoolExecutor

    def _guarded(fn):
        try:
            return fn(req)
        except Exception as e:
            return {"sim": fn.__name__, "error": str(e)[:160]}

    with ThreadPoolExecutor(max_workers=4) as ex:
        results = [r for r in ex.map(_guarded, SIMS) if r]
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
