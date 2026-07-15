"""Real openEMS FDTD antenna simulation on the composed board's ground plane.

Simulates a reference 2.4 GHz quarter-wave PCB monopole fed against the REAL
board outline (the run's actual w x h ground plane) with a full-wave FDTD
solve (openEMS) and reports S11. This is a ground-plane feasibility gate: a
board that is too small (or an antenna keep-out that starves the counterpoise)
detunes the reference antenna and fails here honestly — before layout.

It is NOT a simulation of the routed antenna geometry; the row says so.

Honesty contract (matches run_sim.py):
  - openEMS absent -> gated row with the install path, never a fake number
  - the antenna is a canonical reference monopole, loudly labeled
  - a failed/diverged solve raises -> the row shows the error, not a guess
"""
from __future__ import annotations

import os
import tempfile

EM_TIMEOUT_NOTE = "bounded by NrTS + end criteria inside the engine"
F0 = 2.45e9      # excitation center
FC = 1.0e9       # 20 dB corner
BAND = (2.40e9, 2.48e9)   # BLE / 802.15.4 band we grade against
C0_MM = 299792458.0 * 1e3  # mm/s


def have_openems():
    try:
        import openEMS  # noqa: F401
        import CSXCAD   # noqa: F401
        return True
    except Exception:
        return False


def _monopole_len_mm():
    # quarter-wave at F0 with ~5% end-effect shortening
    return 0.95 * C0_MM / F0 / 4.0


def run(req):
    """Reference-antenna FDTD row, gated row, or None (no antenna on product)."""
    place = req.get("antennaPlacement")
    if not place:
        return None  # product has no antenna — nothing to simulate
    bm = req.get("boardMm") or {}
    w, h = bm.get("w"), bm.get("h")
    if not (isinstance(w, (int, float)) and isinstance(h, (int, float))
            and w > 0 and h > 0):
        return None
    if not have_openems():
        return {
            "sim": "antenna FDTD", "physics": "full-wave FDTD (reference monopole)",
            "metric": "S11 in 2.4 GHz band",
            "value": None, "unit": "", "limit": None, "pass": None,
            "fidelity": "gated", "tool": "openEMS (not installed)",
            "note": "install-gated: build openEMS + python bindings "
                    "(github.com/thliebig/openEMS-Project)",
        }

    import numpy as np
    from CSXCAD import ContinuousStructure
    from openEMS import openEMS

    L = _monopole_len_mm()          # ~29 mm
    gap = 1.0                       # feed gap, mm
    margin = 32.0                   # ~lambda/4 air margin, mm
    trace_hw = 0.5                  # monopole half-width, mm

    fdtd = openEMS(NrTS=24000, EndCriteria=1e-3)
    fdtd.SetGaussExcite(F0, FC)
    fdtd.SetBoundaryCond(['MUR'] * 6)

    csx = ContinuousStructure()
    fdtd.SetCSX(csx)
    mesh = csx.GetGrid()
    mesh.SetDeltaUnit(1e-3)
    mesh_res = C0_MM / (F0 + FC) / 20.0   # ~lambda_min/20 in mm

    # air box: board plus margins; monopole sticks out +y off the top edge
    mesh.AddLine('x', [-w / 2 - margin, w / 2 + margin])
    mesh.AddLine('y', [-h / 2 - margin, h / 2 + gap + L + margin])
    mesh.AddLine('z', [-margin, margin])

    # ground plane = the REAL board outline (PEC sheet at z=0)
    gnd = csx.AddMetal('gnd')
    gnd.AddBox(priority=10, start=[-w / 2, -h / 2, 0], stop=[w / 2, h / 2, 0])
    fdtd.AddEdges2Grid(dirs='xy', properties=gnd)

    # reference quarter-wave monopole off the top board edge
    ant = csx.AddMetal('monopole')
    ant.AddBox(priority=10, start=[-trace_hw, h / 2 + gap, 0],
               stop=[trace_hw, h / 2 + gap + L, 0])
    fdtd.AddEdges2Grid(dirs='xy', properties=ant, metal_edge_res=mesh_res / 2)

    # 50-ohm lumped feed across the gap
    port = fdtd.AddLumpedPort(1, 50.0, [0, h / 2, 0], [0, h / 2 + gap, 0],
                              'y', 1.0, priority=5, edges2grid='xy')

    mesh.SmoothMeshLines('all', mesh_res, 1.4)

    with tempfile.TemporaryDirectory() as wd:
        sim_path = os.path.join(wd, 'ant')
        fdtd.Run(sim_path, cleanup=True)
        f = np.linspace(1.8e9, 3.2e9, 401)
        port.CalcPort(sim_path, f)
        s11 = port.uf_ref / port.uf_inc
        s11_db = 20.0 * np.log10(np.maximum(np.abs(s11), 1e-12))

    in_band = (f >= BAND[0]) & (f <= BAND[1])
    s11_band = float(np.min(s11_db[in_band]))
    i_min = int(np.argmin(s11_db))
    f_res, s11_min = float(f[i_min]), float(s11_db[i_min])
    limit = -10.0  # standard "matched" threshold
    passed = s11_band <= limit
    ncells = "%.0fk" % (np.prod([len(mesh.GetLines(d)) for d in 'xyz']) / 1e3)
    note = ("REAL full-wave FDTD (openEMS): a reference quarter-wave 2.4 GHz "
            "monopole fed against the run's ACTUAL %.0f x %.0f mm board as its "
            "ground plane. This grades the board as a counterpoise, NOT the "
            "routed antenna (none is routed yet). Best match %.1f dB at "
            "%.2f GHz." % (w, h, s11_min, f_res / 1e9))
    if not passed:
        note += (" S11 in the 2.4 GHz band never reaches -10 dB — the board/"
                 "ground plane detunes a textbook antenna; expect real matching "
                 "work (or a bigger board / antenna keep-out).")
    return {
        "sim": "antenna FDTD",
        "physics": "full-wave FDTD, reference monopole on real board outline",
        "metric": "S11 in 2.4 GHz band",
        "value": round(s11_band, 1), "unit": "dB",
        "limit": limit, "pass": passed,
        "fidelity": "fdtd", "tool": "openEMS",
        "detail": {"bestS11Db": round(s11_min, 1),
                   "bestS11AtGHz": round(f_res / 1e9, 3),
                   "boardMm": [round(w, 1), round(h, 1)],
                   "monopoleMm": round(L, 1),
                   "meshLines": ncells,
                   "antennaPlacement": str(place)},
        "note": note,
    }
