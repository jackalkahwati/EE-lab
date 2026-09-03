"""Real Elmer FEM acoustic eigenanalysis of the enclosure air cavity.

Meshes the enclosure's internal free volume (ElmerGrid) and solves the wave
equation eigenproblem (ElmerSolver, WaveSolver + eigen analysis) for the
cavity's acoustic resonances — the real upgrade over the sealed-box scaling
estimate in run_sim.py's `acoustic()`.

The FEM result is cross-checked against the analytic first mode of the
idealized box (f = c/2L); the deviation is reported on the row, so the solve
verifies itself instead of asking to be trusted.

Honesty contract (matches run_sim.py):
  - ElmerSolver absent -> gated row with the install path, never a fake number
  - cavity idealized as the inner envelope box (walls - 2 mm); internals are
    ignored — stated on the row
  - a failed solve raises -> the row shows the error, not a guess
"""
from __future__ import annotations

import glob
import os
import re
import shutil
import subprocess
import tempfile

ELMER_TIMEOUT_S = 90
SOUND_C = 343.0     # m/s, air 20 °C
WALL_MM = 2.0       # assumed shell wall when inferring the internal cavity

GRD = """#####  ElmerGrid input file  ######
Version = 210903
Coordinate System = Cartesian 3D
Subcell Divisions in 3D = 1 1 1
Subcell Limits 1 = 0 %(lx)g
Subcell Limits 2 = 0 %(ly)g
Subcell Limits 3 = 0 %(lz)g
Material Structure in 3D
  1
End
Materials Interval = 1 1
Boundary Definitions
# type     out      int
  1        -1        1        1
End
Numbering = Horizontal
Element Degree = 1
Element Innernodes = False
Triangles = False
Element Divisions 1 = %(nx)d
Element Divisions 2 = %(ny)d
Element Divisions 3 = %(nz)d
"""

SIF = """
Header
  Mesh DB "." "cavity"
End

Simulation
  Max Output Level = 3
  Coordinate System = Cartesian
  Simulation Type = Steady State
  Steady State Max Iterations = 1
End

Body 1
  Name = "air"
  Equation = 1
  Material = 1
End

Material 1
  Density = 1.205
  Sound Speed = %(c)g
End

Equation 1
  Active Solvers(1) = 1
End

Solver 1
  Equation = "WaveEq"
  Variable = "Potential"
  Procedure = "WaveSolver" "WaveSolver"
  Steady State Convergence Tolerance = 1e-9
  Linear System Solver = "Direct"
  Linear System Direct Method = UMFPACK
  Linear System Scaling = Logical False
  Eigen System Select = smallest magnitude
  Eigen Analysis = True
  Eigen System Values = %(nev)d
  Eigen System Convergence Tolerance = Real 1.0e-6
End

Solver 2
  Equation = "SaveScalars"
  Procedure = File "SaveData" "SaveScalars"
  Save Eigenvalues = True
  Filename = eigenvalues.dat
End

! No boundary conditions: the natural BC of the wave equation is a rigid
! wall (dp/dn = 0) — exactly a sealed enclosure cavity.
"""


def elmer_bin():
    p = shutil.which("ElmerSolver")
    if p:
        return p
    home = os.path.expanduser("~/.local/elmer/bin/ElmerSolver")
    return home if os.path.exists(home) else None


def _elmer_env(binp):
    home = os.path.dirname(os.path.dirname(binp))
    env = dict(os.environ)
    env["ELMER_HOME"] = home
    env["PATH"] = os.path.join(home, "bin") + ":" + env.get("PATH", "")
    return env


def _parse_eigenvalues(workdir):
    """SaveScalars writes one row of scalars; eigenvalues are ω² (rad/s)²
    (complex modes come out as value pairs — take the real parts)."""
    vals = []
    for path in sorted(glob.glob(os.path.join(workdir, "eigenvalues.dat*"))):
        if path.endswith(".names"):
            continue
        for line in open(path, errors="replace"):
            for tok in line.split():
                try:
                    vals.append(float(tok))
                except ValueError:
                    pass
        if vals:
            break
    return vals


def run(req):
    """Cavity acoustic FEM row, gated row, or None (no envelope)."""
    env_mm = req.get("envelopeMm") or {}
    dims = [env_mm.get(k) for k in ("x", "y", "z")]
    if not all(isinstance(v, (int, float)) and v > 0 for v in dims):
        return None
    # internal free cavity = envelope minus the shell walls
    cav = [max((v - 2 * WALL_MM) / 1e3, 5e-3) for v in dims]
    binp = elmer_bin()
    if not binp:
        return {
            "sim": "cavity acoustic FEM", "physics": "wave-equation eigenanalysis",
            "metric": "first cavity resonance",
            "value": None, "unit": "", "limit": None, "pass": None,
            "fidelity": "gated", "tool": "Elmer (not installed)",
            "note": "install-gated: build ElmerSolver (github.com/ElmerCSC/elmerfem)",
        }
    lx, ly, lz = cav
    # ~14 elements along the longest edge, scaled per-axis, floor of 4
    nmax = 14
    longest = max(cav)
    nx, ny, nz = (max(4, int(round(nmax * d / longest))) for d in cav)
    with tempfile.TemporaryDirectory() as wd:
        open(os.path.join(wd, "cavity.grd"), "w").write(
            GRD % dict(lx=lx, ly=ly, lz=lz, nx=nx, ny=ny, nz=nz))
        open(os.path.join(wd, "case.sif"), "w").write(
            SIF % dict(c=SOUND_C, nev=6))
        open(os.path.join(wd, "ELMERSOLVER_STARTINFO"), "w").write("case.sif\n")
        env = _elmer_env(binp)
        grid = os.path.join(os.path.dirname(binp), "ElmerGrid")
        log = ""
        for argv in ([grid, "1", "2", "cavity.grd"], [binp]):
            p = subprocess.run(argv, cwd=wd, env=env, capture_output=True,
                               text=True, timeout=ELMER_TIMEOUT_S)
            log = (p.stdout or "") + (p.stderr or "")
        eig = _parse_eigenvalues(wd)
    if not eig:
        raise RuntimeError("ElmerSolver produced no eigenvalues: %s"
                           % log[-200:].replace("\n", " "))
    # ω² -> f, drop the ~0 constant-pressure mode, first real mode is f1
    freqs = sorted(max(v, 0.0) ** 0.5 / (2 * 3.141592653589793) for v in eig)
    modes = [f for f in freqs if f > 20.0]
    if not modes:
        raise RuntimeError("no non-trivial cavity mode in eigen set: %s" % freqs)
    f1 = modes[0]
    f1_analytic = SOUND_C / (2 * max(cav))
    dev_pct = abs(f1 - f1_analytic) / f1_analytic * 100.0
    n_nodes = (nx + 1) * (ny + 1) * (nz + 1)
    return {
        "sim": "cavity acoustic FEM",
        "physics": "wave-equation eigenanalysis (rigid-wall cavity)",
        "metric": "first cavity resonance",
        "value": round(f1), "unit": "Hz",
        "limit": None, "pass": None,
        "fidelity": "fem-acoustic", "tool": "Elmer (WaveSolver)",
        "detail": {"modesHz": [round(f) for f in modes[:4]],
                   "cavityMm": [round(v * 1e3, 1) for v in cav],
                   "nodes": n_nodes,
                   "analyticF1Hz": round(f1_analytic),
                   "femVsAnalyticPct": round(dev_pct, 1)},
        "note": ("REAL acoustic FEM: ElmerSolver wave-equation eigenanalysis of "
                 "the enclosure's internal air volume (rigid walls = sealed "
                 "cavity). Cavity idealized as the inner envelope box (walls "
                 "-%g mm); board/components ignored — the real f1 sits somewhat "
                 "higher. Self-check: analytic box mode %d Hz, FEM within "
                 "%.1f%%." % (2 * WALL_MM, round(f1_analytic), dev_pct)),
    }
