#!/usr/bin/env python3
"""Multi-board KIT BUILDER for FirstLight Compose.

Finishes the auto-partition feature. `auto_partition.py` splits a dense
netlist into two sub-boards (board_a / board_b) plus an interconnect map.
This tool takes that partition and, for EACH half:

  1. builds a run_board payload from its parts/nets/gnd,
  2. ROUTES it (tools/tscircuit/run_board.mjs — freerouting + real KiCad DRC),
  3. writes the returned .kicad_pcb,
  4. exports a fab package (scripts/export_fab.py — gerbers/drill/P&P/STEP/zip),
  5. records DRC error count + board size + fab zip + part MPNs,

then assembles a 2-board kit descriptor (kit.json) carrying both board
records, the full interconnect, and the mating pin map.

Usage:  python3 build_kit.py <partition_dir>
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
TSCIRCUIT_DIR = os.path.join(REPO, "tools", "tscircuit")
RUN_BOARD = os.path.join(TSCIRCUIT_DIR, "run_board.mjs")
FAB_SCRIPTS_DIR = os.path.join(
    REPO, "software", "prompt-to-pcb-ui", "scripts")
EXPORT_FAB = os.path.join(FAB_SCRIPTS_DIR, "export_fab.py")

ROUTE_TIMEOUT_S = 480


def log(msg):
    print(msg, flush=True)


# run_board.mjs only accepts qfn4..qfn64 or 0NNN passive footprints natively.
# Everything else (headers/connectors) must arrive with an explicit kicadMod
# giving real pad geometry. Synthesize a 2.54mm-pitch SMD pad grid so the
# router can place and route the connector like any other component.
_SUPPORTED_FP = re.compile(r"^(qfn(\d+)|0\d{3})$")
_HEADER_DIMS = re.compile(r"(\d+)x(\d+)")
PITCH_MM = 2.54
PAD_MM = 1.7


def _pins_referenced(part_name, spec):
    """Highest pin number referenced for a part across nets + gnd."""
    hi = 0
    prefix = part_name + "."
    refs = list(spec.get("gnd", []))
    for net in spec.get("nets", []):
        refs.extend(net)
    for r in refs:
        if isinstance(r, str) and r.startswith(prefix):
            try:
                hi = max(hi, int(r[len(prefix):]))
            except ValueError:
                pass
    return hi


def _header_kicad_mod(n_pins, cols):
    """A .kicad_mod string of n_pins SMD rect pads on a 2.54mm grid.
    Pads named 1..n_pins so net refs (Jxx.k) resolve to pin 'k'."""
    rows = (n_pins + cols - 1) // cols
    pads = []
    pin = 1
    for row in range(rows):
        for col in range(cols):
            if pin > n_pins:
                break
            x = col * PITCH_MM
            y = row * PITCH_MM
            pads.append(
                '(pad "{n}" smd rect (at {x:.3f} {y:.3f}) (size {w} {h}) '
                '(layers "F.Cu" "F.Paste" "F.Mask"))'.format(
                    n=pin, x=x, y=y, w=PAD_MM, h=PAD_MM))
            pin += 1
    return "(footprint header\n  " + "\n  ".join(pads) + "\n)"


def enrich_connectors(spec):
    """Attach a kicadMod to every part whose footprint the router can't build
    natively (headers/connectors), sized to cover its referenced pins."""
    for p in spec.get("parts", []):
        fp = str(p.get("footprint", ""))
        if _SUPPORTED_FP.match(fp) or p.get("kicadMod"):
            continue
        m = _HEADER_DIMS.search(fp)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            cols, per = (a, b) if a <= b else (b, a)
            n_pins = a * b
        else:
            cols, per = 1, 0
            n_pins = 0
        need = _pins_referenced(p["name"], spec)
        n_pins = max(n_pins, need)
        if n_pins <= 0:
            n_pins = 2
        # rows across the shorter dimension; keep at least the referenced pins
        row_cols = max(1, min(cols, n_pins))
        p["kicadMod"] = _header_kicad_mod(n_pins, row_cols)
        log("  enriched {} ({}) -> kicadMod {} pads".format(
            p["name"], fp or "?", n_pins))


def route_board(name, spec, out_dir):
    """Spawn run_board.mjs, feed the payload on stdin, return the parsed
    result dict (last stdout JSON line) or None on failure."""
    os.makedirs(out_dir, exist_ok=True)
    svg_path = os.path.join(out_dir, "chipscale.svg")
    enrich_connectors(spec)
    payload = {
        "parts": spec.get("parts", []),
        "nets": spec.get("nets", []),
        "gnd": spec.get("gnd", []),
        "boardShape": {"type": "rect"},
        "mountingHoles": {"count": 4, "holeDiaMm": 2.2},
        "svgPath": svg_path,
    }
    log("[{}] routing {} parts, {} nets, {} gnd pins (timeout {}s)...".format(
        name, len(payload["parts"]), len(payload["nets"]),
        len(payload["gnd"]), ROUTE_TIMEOUT_S))
    try:
        proc = subprocess.run(
            ["node", RUN_BOARD],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            cwd=TSCIRCUIT_DIR,
            timeout=ROUTE_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        log("[{}] ROUTE TIMED OUT after {}s".format(name, ROUTE_TIMEOUT_S))
        return None

    # forward router progress (stderr) tail for visibility
    if proc.stderr:
        tail = proc.stderr.strip().splitlines()[-3:]
        for ln in tail:
            log("[{}] router: {}".format(name, ln))

    # the result is the LAST non-empty stdout line as JSON
    result = None
    for ln in reversed((proc.stdout or "").splitlines()):
        ln = ln.strip()
        if not ln:
            continue
        try:
            result = json.loads(ln)
            break
        except json.JSONDecodeError:
            continue
    if result is None:
        log("[{}] no JSON result on stdout (rc={})".format(
            name, proc.returncode))
    return result


def export_fab(name, kicad_pcb_path, fab_dir):
    """Run export_fab.py from its scripts dir. Return the fab-zip path
    (parsed from FAB_ZIP:<path>) or None."""
    os.makedirs(fab_dir, exist_ok=True)
    log("[{}] exporting fab package -> {}".format(name, fab_dir))
    try:
        proc = subprocess.run(
            ["python3", EXPORT_FAB, kicad_pcb_path, fab_dir],
            capture_output=True,
            text=True,
            cwd=FAB_SCRIPTS_DIR,
            timeout=600,
        )
    except subprocess.TimeoutExpired:
        log("[{}] fab export TIMED OUT".format(name))
        return None
    zip_path = None
    for ln in (proc.stdout or "").splitlines():
        log("[{}] {}".format(name, ln.rstrip()))
        if ln.startswith("FAB_ZIP:"):
            zip_path = ln[len("FAB_ZIP:"):].strip()
    if zip_path is None and proc.stderr.strip():
        log("[{}] fab stderr: {}".format(
            name, proc.stderr.strip().splitlines()[-1]))
    return zip_path


def build_board(name, partition_dir):
    """Route + fab one sub-board. Return its kit record."""
    spec_path = os.path.join(partition_dir, "{}.chipscale-spec.json".format(name))
    with open(spec_path) as f:
        spec = json.load(f)
    out_dir = os.path.join(partition_dir, name)

    mpns = [p.get("mpn") for p in spec.get("parts", []) if p.get("mpn")]

    rec = {
        "name": name,
        "drc_errors": None,
        "boardMm": None,
        "fab_zip": None,
        "parts": mpns,
        "routed": False,
    }

    result = route_board(name, spec, out_dir)
    if result is None:
        rec["error"] = "router produced no result"
        return rec

    drc = result.get("drc") or {}
    rec["boardMm"] = result.get("boardMm")
    rec["ok"] = result.get("ok", False)
    rec["layers"] = result.get("layers")
    if drc.get("available"):
        rec["drc_errors"] = drc.get("errors")
        rec["drc_errorTypes"] = drc.get("errorTypes")
    else:
        rec["drc_errors"] = None
        rec["drc_unavailable_reason"] = drc.get("reason")

    kicad_pcb = result.get("kicadPcb")
    if not kicad_pcb:
        log("[{}] router returned no kicadPcb — cannot export fab".format(name))
        rec["error"] = "no kicadPcb from router"
        return rec

    pcb_path = os.path.join(out_dir, "chipscale.kicad_pcb")
    with open(pcb_path, "w") as f:
        f.write(kicad_pcb)
    rec["kicad_pcb"] = pcb_path
    rec["routed"] = True

    fab_dir = os.path.join(out_dir, "fab")
    zip_path = export_fab(name, pcb_path, fab_dir)
    rec["fab_zip"] = zip_path
    return rec


def main():
    if len(sys.argv) < 2:
        log("usage: python3 build_kit.py <partition_dir>")
        sys.exit(2)
    partition_dir = os.path.abspath(sys.argv[1])
    if not os.path.isdir(partition_dir):
        log("not a directory: {}".format(partition_dir))
        sys.exit(2)

    boards = []
    for name in ("board_a", "board_b"):
        log("\n=== {} ===".format(name))
        rec = build_board(name, partition_dir)
        boards.append(rec)

    interconnect = {}
    ic_path = os.path.join(partition_dir, "interconnect.json")
    if os.path.exists(ic_path):
        with open(ic_path) as f:
            interconnect = json.load(f)

    kit = {
        "boards": boards,
        "interconnect": interconnect,
        "mating": interconnect.get("map", []),
    }
    kit_path = os.path.join(partition_dir, "kit.json")
    with open(kit_path, "w") as f:
        json.dump(kit, f, indent=2)

    def errstr(rec):
        e = rec.get("drc_errors")
        return str(e) if e is not None else "n/a"

    log("\n" + "=" * 48)
    log("KIT board_a={}err board_b={}err".format(
        errstr(boards[0]), errstr(boards[1])))
    log("kit.json: {}".format(kit_path))
    for rec in boards:
        log("  {} fab-zip: {}".format(rec["name"], rec.get("fab_zip") or "(none)"))


if __name__ == "__main__":
    main()
