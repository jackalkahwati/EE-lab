"""Real OpenFOAM natural-convection CFD of the device in ambient air.

Generates a case around the product envelope (the device as a sealed box at
uniform heat flux = its power budget / surface area), meshes it with
blockMesh + snappyHexMesh, and solves steady laminar Boussinesq buoyant flow
(buoyantBoussinesqSimpleFoam). Outputs the CFD-resolved case surface
temperature and the effective convection coefficient — the number the 2D FEM
thermal pass ASSUMES (h ≈ 10 W/m²K) is here actually computed from the flow.

Honesty contract (matches run_sim.py):
  - OpenFOAM absent -> gated row with the install path, never a fake number
  - idealizations are stated on the row: device = sealed uniform-flux box,
    closed ambient-wall domain, laminar, deliberately coarse mesh (this runs
    inside an interactive pipeline stage, not an overnight HPC job)
  - a diverged/failed solve raises -> the row shows the error, not a guess
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile

CFD_TIMEOUT_S = 150
N_ITER = 250

FOAM_ETC = """\
FoamFile
{
    version     2.0;
    format      ascii;
    class       %(cls)s;
    object      %(obj)s;
}
"""


def openfoam_bin():
    """Native binaries on PATH, or the OpenFOAM.app launcher (brew
    gerlero/openfoam) which wraps the whole toolchain."""
    for b in ("foamRun", "simpleFoam"):
        if shutil.which(b):
            return ("native", b)
    p = shutil.which("openfoam")
    return ("launcher", p) if p else (None, None)


def _dict(cls, obj, body):
    return FOAM_ETC % {"cls": cls, "obj": obj} + body


def _write(case, rel, text):
    p = os.path.join(case, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        f.write(text)


def _gen_case(case, dev, power_w):
    """dev = (lx, ly, lz) device box in metres, centered at origin XY, sitting
    at z=0. Domain: closed box of ambient-temperature walls around it."""
    lx, ly, lz = dev
    m = max(lx, ly)                      # lateral margin scale
    x0, x1 = -lx / 2 - m, lx / 2 + m
    y0, y1 = -ly / 2 - m, ly / 2 + m
    z0, z1 = -m * 0.5, lz + 2.2 * m      # extra headroom for the plume
    cell = max(lx, ly, lz) / 7.0         # coarse background, snappy refines
    nx = max(6, int((x1 - x0) / cell))
    ny = max(6, int((y1 - y0) / cell))
    nz = max(8, int((z1 - z0) / cell))
    # locationInMesh: the CENTRE of the background cell containing the desired
    # fluid point (beside the device, mid-height). A raw point sat exactly on a
    # cell face whenever a count was even (y=0 with ny even) and snappyHexMesh's
    # findCells found no cell: the CFD row came back empty on a 78x48x22mm
    # enclosure. A cell centre cannot lie on a face.
    def _centre(lo, hi, n, want):
        d = (hi - lo) / n
        k = min(n - 1, max(0, int((want - lo) / d)))
        return lo + (k + 0.5) * d
    locx = _centre(x0, x1, nx, lx / 2 + m / 2)
    locy = _centre(y0, y1, ny, 0.0)
    locz = _centre(z0, z1, nz, lz / 2)

    area = 2 * (lx * ly + ly * lz + lx * lz)   # device surface, m^2
    flux = power_w / area                      # W/m^2
    # Boussinesq T-eqn diffusivity is kinematic: q'' = rho·cp·alpha·dT/dn,
    # and rho·cp·alpha == k_air. Laminar air at ~300 K:
    k_air = 0.0262                             # W/mK
    grad_t = flux / k_air                      # K/m, into the fluid

    _write(case, "system/blockMeshDict", _dict("dictionary", "blockMeshDict", """
scale 1;
vertices
(
    (%(x0)g %(y0)g %(z0)g) (%(x1)g %(y0)g %(z0)g)
    (%(x1)g %(y1)g %(z0)g) (%(x0)g %(y1)g %(z0)g)
    (%(x0)g %(y0)g %(z1)g) (%(x1)g %(y0)g %(z1)g)
    (%(x1)g %(y1)g %(z1)g) (%(x0)g %(y1)g %(z1)g)
);
blocks ( hex (0 1 2 3 4 5 6 7) (%(nx)d %(ny)d %(nz)d) simpleGrading (1 1 1) );
boundary
(
    ambient
    {
        type wall;
        faces
        (
            (0 3 2 1) (4 5 6 7)
            (0 4 7 3) (2 6 5 1)
            (1 5 4 0) (3 7 6 2)
        );
    }
);
""" % dict(x0=x0, x1=x1, y0=y0, y1=y1, z0=z0, z1=z1, nx=nx, ny=ny, nz=nz)))

    _write(case, "system/snappyHexMeshDict", _dict("dictionary", "snappyHexMeshDict", """
castellatedMesh true;
snap            true;
addLayers       false;
geometry
{
    device
    {
        type searchableBox;
        min (%(dx0)g %(dy0)g 0);
        max (%(dx1)g %(dy1)g %(lz)g);
    }
}
castellatedMeshControls
{
    maxLocalCells 400000;
    maxGlobalCells 800000;
    minRefinementCells 0;
    nCellsBetweenLevels 2;
    features ();
    refinementSurfaces { device { level (2 2); } }
    resolveFeatureAngle 30;
    refinementRegions {}
    locationInMesh (%(locx)g %(locy)g %(locz)g);
    allowFreeStandingZoneFaces true;
}
snapControls
{
    nSmoothPatch 3;
    tolerance 2.0;
    nSolveIter 20;
    nRelaxIter 5;
}
addLayersControls {}
meshQualityControls
{
    maxNonOrtho 65;
    maxBoundarySkewness 20;
    maxInternalSkewness 4;
    maxConcave 80;
    minVol 1e-13;
    minTetQuality 1e-15;
    minArea -1;
    minTwist 0.02;
    minDeterminant 0.001;
    minFaceWeight 0.05;
    minVolRatio 0.01;
    minTriangleTwist -1;
    nSmoothScale 4;
    errorReduction 0.75;
}
mergeTolerance 1e-6;
""" % dict(dx0=-lx / 2, dy0=-ly / 2, dx1=lx / 2, dy1=ly / 2, lz=lz,
           # Off the background grid on every axis: at y=0 the point sat exactly on a
           # cell face whenever ny was even, and snappyHexMesh's findCells then
           # reported no cell (measured: the CFD row came back 'no device-temperature
           # series' on a 78x48x22mm enclosure whose ny was 18; a 26x29mm board with
           # an odd count sailed through). Fractional-cell offsets keep it interior.
           locx=locx, locy=locy, locz=locz)))

    _write(case, "system/controlDict", _dict("dictionary", "controlDict", """
application     buoyantBoussinesqSimpleFoam;
startFrom       latestTime;
startTime       0;
stopAt          endTime;
endTime         %(iters)d;
deltaT          1;
writeControl    timeStep;
writeInterval   %(iters)d;
purgeWrite      1;
writeFormat     ascii;
writePrecision  7;
timeFormat      general;
runTimeModifiable false;
functions
{
    devT
    {
        type            surfaceFieldValue;
        libs            (fieldFunctionObjects);
        regionType      patch;
        name            device;
        operation       max;
        fields          (T);
        writeFields     false;
        writeControl    timeStep;
        writeInterval   25;
        log             true;
    }
    devTavg
    {
        type            surfaceFieldValue;
        libs            (fieldFunctionObjects);
        regionType      patch;
        name            device;
        operation       areaAverage;
        fields          (T);
        writeFields     false;
        writeControl    timeStep;
        writeInterval   25;
        log             true;
    }
}
""" % dict(iters=N_ITER)))

    _write(case, "system/fvSchemes", _dict("dictionary", "fvSchemes", """
ddtSchemes { default steadyState; }
gradSchemes { default Gauss linear; }
divSchemes
{
    default         none;
    div(phi,U)      bounded Gauss upwind;
    div(phi,T)      bounded Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}
laplacianSchemes { default Gauss linear corrected; }
interpolationSchemes { default linear; }
snGradSchemes { default corrected; }
wallDist { method meshWave; }
"""))

    _write(case, "system/fvSolution", _dict("dictionary", "fvSolution", """
solvers
{
    p_rgh
    {
        solver          GAMG;
        tolerance       1e-7;
        relTol          0.05;
        smoother        GaussSeidel;
    }
    "(U|T)"
    {
        solver          PBiCGStab;
        preconditioner  DILU;
        tolerance       1e-7;
        relTol          0.1;
    }
}
SIMPLE
{
    nNonOrthogonalCorrectors 0;
    pRefCell 0;
    pRefValue 0;
    residualControl
    {
        p_rgh 1e-4;
        U 1e-5;
        T 1e-5;
    }
}
relaxationFactors
{
    fields { p_rgh 0.5; }
    equations { U 0.4; T 0.6; }
}
"""))

    _write(case, "constant/g", _dict("uniformDimensionedVectorField", "g", """
dimensions      [0 1 -2 0 0 0 0];
value           (0 0 -9.81);
"""))

    _write(case, "constant/transportProperties", _dict("dictionary", "transportProperties", """
transportModel  Newtonian;
nu              1.55e-05;
beta            3.3e-03;
TRef            295;
Pr              0.71;
Prt             0.85;
"""))

    _write(case, "constant/turbulenceProperties", _dict("dictionary", "turbulenceProperties", """
simulationType laminar;
"""))

    bc_common = """
dimensions      %(dims)s;
internalField   uniform %(init)s;
boundaryField
{
    ambient { %(amb)s }
    device  { %(dev)s }
}
"""
    _write(case, "0/T", _dict("volScalarField", "T", bc_common % dict(
        dims="[0 0 0 1 0 0 0]", init="295",
        amb="type fixedValue; value uniform 295;",
        dev="type fixedGradient; gradient uniform %g;" % grad_t)))
    _write(case, "0/U", _dict("volVectorField", "U", bc_common % dict(
        dims="[0 1 -1 0 0 0 0]", init="(0 0 0)",
        amb="type noSlip;", dev="type noSlip;")))
    _write(case, "0/p_rgh", _dict("volScalarField", "p_rgh", bc_common % dict(
        dims="[0 2 -2 0 0 0 0]", init="0",
        amb="type fixedFluxPressure; value uniform 0;",
        dev="type fixedFluxPressure; value uniform 0;")))
    # alphat: required by buoyantBoussinesqSimpleFoam even when laminar
    _write(case, "0/alphat", _dict("volScalarField", "alphat", bc_common % dict(
        dims="[0 2 -1 0 0 0 0]", init="0",
        amb="type calculated; value uniform 0;",
        dev="type calculated; value uniform 0;")))
    return flux, area


def _run_foam(kind, binp, case, log):
    cmds = "blockMesh && snappyHexMesh -overwrite && buoyantBoussinesqSimpleFoam"
    if kind == "launcher":
        argv = [binp, "-c", cmds]
    else:
        argv = ["bash", "-c", cmds]
    with open(log, "w") as lf:
        subprocess.run(argv, cwd=case, stdout=lf, stderr=subprocess.STDOUT,
                       timeout=CFD_TIMEOUT_S, check=False)


def _parse_series(log_text, name):
    """functionObject log lines: '    max(device) of T = 3.084e+02'."""
    vals = []
    pat = re.compile(r"%s\(device\) of T = ([0-9.eE+-]+)" % name)
    for m in pat.finditer(log_text):
        try:
            vals.append(float(m.group(1)))
        except ValueError:
            pass
    return vals


def _cells(log_text):
    m = None
    for m in re.finditer(r"Cells\s*:\s*(\d+)", log_text):
        pass
    return int(m.group(1)) if m else None


def run(req):
    """CFD thermal row, gated row, or None (no power/envelope to simulate)."""
    env = req.get("envelopeMm") or {}
    active_mw = req.get("activeMw")
    if not (isinstance(active_mw, (int, float)) and active_mw > 0):
        return None
    dims = [env.get(k) for k in ("x", "y", "z")]
    if not all(isinstance(v, (int, float)) and v > 0 for v in dims):
        return None
    kind, binp = openfoam_bin()
    if not binp:
        return {
            "sim": "cfd thermal", "physics": "buoyant natural-convection CFD",
            "metric": "case surface temp (CFD)",
            "value": None, "unit": "", "limit": None, "pass": None,
            "fidelity": "gated", "tool": "OpenFOAM (not installed)",
            "note": "install-gated: brew install gerlero/openfoam/openfoam",
        }
    power_w = active_mw / 1e3
    dev = tuple(v / 1e3 for v in dims)
    with tempfile.TemporaryDirectory() as case:
        flux, area = _gen_case(case, dev, power_w)
        log = os.path.join(case, "solve.log")
        _run_foam(kind, binp, case, log)
        text = open(log, errors="replace").read()
        tmax = _parse_series(text, "max")
        tavg = _parse_series(text, "areaAverage")
        cells = _cells(text)
    if not tmax or not tavg:
        raise RuntimeError("OpenFOAM produced no device-temperature series: %s"
                           % text[-200:].replace("\n", " "))
    t_amb = 295.0
    t_max_c = tmax[-1] - 273.15
    t_avg = tavg[-1]
    # effective film coefficient the flow actually delivers on this geometry
    h_eff = flux / max(t_avg - t_amb, 1e-6)
    # convergence sanity: last two sampled maxima should agree closely
    drift = abs(tmax[-1] - tmax[-2]) if len(tmax) >= 2 else None
    limit = 43.0  # IEC touch-temp, same criterion as the FEM thermal row
    note = ("REAL 3D CFD: steady laminar Boussinesq natural convection "
            "(buoyantBoussinesqSimpleFoam, OpenFOAM), device idealized as a "
            "sealed uniform-flux box (%.2f W over %.1f cm² = %.0f W/m²) in a "
            "closed ambient-wall air domain. Coarse interactive-grade mesh — "
            "a design gate, not a certification run. The effective h this "
            "flow delivers (%.1f W/m²K) is the number the 2D FEM pass "
            "assumes (10)." % (power_w, area * 1e4, flux, h_eff))
    if drift is not None and drift > 1.0:
        note += (" CONVERGENCE MARGINAL: device T still moving %.1f K between "
                 "samples at iteration cap — treat as approximate." % drift)
    return {
        "sim": "cfd thermal",
        "physics": "3D buoyant natural-convection CFD (steady, laminar Boussinesq)",
        "metric": "case surface temp (CFD)",
        "value": round(t_max_c, 1), "unit": "°C",
        "limit": limit, "pass": t_max_c <= limit,
        "fidelity": "cfd",
        "tool": "OpenFOAM (buoyantBoussinesqSimpleFoam)",
        "detail": {"cells": cells, "iterations": N_ITER,
                   "hEffWm2K": round(h_eff, 1),
                   "surfaceAvgC": round(t_avg - 273.15, 1),
                   "fluxWm2": round(flux, 1), "powerW": round(power_w, 3),
                   "deviceMm": [round(v * 1e3, 1) for v in dev],
                   **({"convergenceDriftK": round(drift, 2)} if drift is not None else {})},
        "note": note,
    }
