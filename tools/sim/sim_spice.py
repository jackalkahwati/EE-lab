"""Real ngspice PDN (power distribution network) check for the composed board.

Builds the rail decoupling network from the run's ACTUAL netlist (which caps
sit on which rail) and the ACTUAL per-rail load current from the power budget,
then runs a REAL ngspice AC impedance sweep of the network as seen by the
loads. The check: rail impedance must stay under the target impedance
Z_target = ripple_budget / transient_current across the MCU's demand band.

Honesty contract (same as the rest of run_sim.py):
  - ngspice absent            -> gated row, never a fake number
  - cap values not in the BOM -> ASSUMED standard values, loudly labeled
    (the composed BOM leaves 0402 decoupling as "choose value + voltage")
  - parasitics (ESL/ESR, mounting inductance) are typical figures, labeled
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile

NGSPICE_TIMEOUT_S = 20

# Typical 0402 X7R MLCC parasitics + via/mount inductance (labeled as assumed)
CAP_DEFAULTS = {
    "assumedCapF": 100e-9,   # 100 nF decoupling default for generic 0402 caps
    "esrOhm": 0.03,
    "eslH": 0.6e-9,          # cap body ESL
    "mountH": 1.2e-9,        # pad + via + spreading inductance per cap
}
# Bulk source side: regulator output impedance behind plane spreading L.
SRC_DEFAULTS = {"srcLH": 5e-9, "srcRohm": 0.02}


def ngspice_bin():
    return shutil.which("ngspice")


def _rail_caps(pdn, rail):
    """Count decoupling caps the netlist actually places on this rail."""
    caps = []
    for c in pdn.get("railCaps", []):
        if c.get("rail") == rail:
            caps.append(c)
    return caps


def build_deck(rail, caps, f_lo=1e3, f_hi=1e9):
    """One-port AC deck: 1 A AC current injected at the load node; V(load)
    then IS the network impedance in ohms."""
    lines = [
        "* Compose PDN impedance scan — rail %s" % rail,
        "I1 0 load AC 1",
        # source/regulator side: bulk behind plane spreading inductance
        "Lsrc load vreg %g" % SRC_DEFAULTS["srcLH"],
        "Rsrc vreg 0 %g" % SRC_DEFAULTS["srcRohm"],
    ]
    for i, c in enumerate(caps):
        capf = c.get("valueF") or CAP_DEFAULTS["assumedCapF"]
        lines += [
            "Lm%d load n%da %g" % (i, i, CAP_DEFAULTS["mountH"]),
            "Le%d n%da n%db %g" % (i, i, i, CAP_DEFAULTS["eslH"]),
            "Re%d n%db n%dc %g" % (i, i, i, CAP_DEFAULTS["esrOhm"]),
            "C%d n%dc 0 %g" % (i, i, capf),
        ]
    lines += [
        ".control",
        "ac dec 20 %g %g" % (f_lo, f_hi),
        "print vm(load)",   # |Z| in ohms (1 A source)
        ".endc",
        ".end",
    ]
    return "\n".join(lines) + "\n"


def parse_zmax(text):
    """Pull (freq, |Z|) rows from ngspice's `print vm(load)` table; return the
    worst impedance in the band and the full curve extrema."""
    rows = []
    for line in text.splitlines():
        m = re.match(r"\s*\d+\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)", line)
        if m:
            try:
                rows.append((float(m.group(1)), float(m.group(2))))
            except ValueError:
                pass
    return rows


def run(req):
    """Returns a result row (or None when the run carries no PDN data)."""
    pdn = req.get("pdn") or {}
    rails = pdn.get("rails") or []
    if not rails:
        return None
    binp = ngspice_bin()
    if not binp:
        return {
            "sim": "pdn", "physics": "AC impedance scan", "metric": "rail impedance",
            "value": None, "unit": "", "limit": None, "pass": None,
            "fidelity": "gated", "tool": "ngspice (not installed)",
            "note": "install-gated: brew install ngspice",
        }
    # Analyze the mostly-loaded rail (highest transient demand).
    rail = max(rails, key=lambda r: r.get("worstMa") or 0.0)
    name = rail.get("name") or "?"
    caps = _rail_caps(pdn, name)
    worst_ma = float(rail.get("worstMa") or 0.0)
    if worst_ma <= 0 or not caps:
        return {
            "sim": "pdn", "physics": "AC impedance scan", "metric": "rail impedance",
            "value": None, "unit": "", "limit": None, "pass": None,
            "fidelity": "skipped", "tool": "ngspice %s" % _version(binp),
            "note": ("no decoupling caps found on the loaded rail (%s) — nothing "
                     "to scan; that itself is a design flag" % name)
            if worst_ma > 0 else
            "no rail load current in the power budget — impedance target undefined",
        }
    # Target impedance: 3%% ripple on the rail at a 50%% load transient.
    vrail = 3.3 if "3" in name else (5.0 if "5" in name else 3.3)
    i_tran = max(worst_ma / 1e3 * 0.5, 1e-4)
    z_target = vrail * 0.03 / i_tran
    # MCU demand band: DC-side transients ~100 kHz to ~100 MHz (edge rates).
    f_lo, f_hi = 1e4, 2e8
    deck = build_deck(name, caps)
    with tempfile.TemporaryDirectory() as wd:
        deckp = os.path.join(wd, "pdn.cir")
        open(deckp, "w").write(deck)
        p = subprocess.run([binp, "-b", deckp], capture_output=True, text=True,
                           timeout=NGSPICE_TIMEOUT_S)
        rows = parse_zmax(p.stdout)
    if not rows:
        raise RuntimeError("ngspice returned no AC table: %s"
                           % (p.stderr or p.stdout)[:160])
    band = [(f, z) for f, z in rows if f_lo <= f <= f_hi]
    zmax_f, zmax = max(band, key=lambda t: t[1]) if band else max(rows, key=lambda t: t[1])
    assumed = [c for c in caps if not c.get("valueF")]
    note = ("REAL ngspice AC sweep of the %s decoupling network as built from "
            "the run's netlist (%d cap%s) against Z_target = 3%% ripple / 50%% "
            "load step (%.0f mA budget). Cap parasitics (ESR/ESL/mount L) are "
            "typical 0402 figures." % (name, len(caps), "s" if len(caps) != 1 else "",
                                       worst_ma))
    if assumed:
        note += (" %d cap value%s ASSUMED 100 nF — the BOM leaves generic 0402 "
                 "caps as 'choose value'; re-run after value selection."
                 % (len(assumed), "s" if len(assumed) != 1 else ""))
    return {
        "sim": "pdn", "physics": "rail decoupling AC impedance (SPICE)",
        "metric": "worst |Z| %s, 10 kHz–200 MHz" % name,
        "value": round(zmax, 3), "unit": "Ω",
        "limit": round(z_target, 3), "pass": zmax <= z_target,
        "fidelity": "spice", "tool": "ngspice %s" % _version(binp),
        "detail": {"rail": name, "caps": len(caps), "assumedValues": len(assumed),
                   "zWorstAtHz": round(zmax_f), "zTargetOhm": round(z_target, 3),
                   "railLoadMa": worst_ma, "points": len(rows)},
        "note": note,
    }


def _version(binp):
    try:
        out = subprocess.run([binp, "--version"], capture_output=True, text=True,
                             timeout=5).stdout
        m = re.search(r"ngspice-([\w.]+)", out)
        return m.group(1) if m else ""
    except Exception:
        return ""
