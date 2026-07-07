"""Export a Specctra DSN from a board, inset the routable boundary, and
report zone-served nets.

  <kicad-python3> export_dsn.py <board.kicad_pcb> <out.dsn> [inset_mm]

flroute routes track centerlines right up to the DSN boundary bbox with no
inset, so copper + width/2 spills into the board-edge clearance border
(17/24 of run-6's DRC violations were tracks <0.5mm from the edge). We
shrink ONLY the DSN boundary the router sees; the real Edge.Cuts in the
.kicad_pcb is untouched, so the board outline stays correct. Inset =
edge_clearance + track_width/2 + guard so all routed copper clears 0.5mm.
"""
import os
import re
import sys

import pcbnew

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fine_pitch_fanout  # noqa: E402

board_path, dsn_path = sys.argv[1], sys.argv[2]
inset_mm = float(sys.argv[3]) if len(sys.argv) > 3 else 0.65

# Phase 16.5: fine-pitch pre-escape fanout. Solves multi-escape fine-pitch rows
# in EXACT geometry (stubs + breakout pads) BEFORE the grid router runs; the
# original fine pins are then removed from the DSN net lists so flroute routes
# from the breakouts. Final DRC + unconnected check verifies the whole chain —
# a broken/shorted stub fails honestly, nothing is faked.
fanout_entries = fine_pitch_fanout.fanout(board_path)
if fanout_entries:
    print("FANOUT: %d fine-pitch escape(s) pre-fanned (%s)" %
          (len(fanout_entries), ",".join(e["pin_token"] for e in fanout_entries)))

b = pcbnew.LoadBoard(board_path)
zone_nets = sorted({str(z.GetNetname()) for z in b.Zones() if z.GetNetCode() > 0})
ok = pcbnew.ExportSpecctraDSN(b, dsn_path)
if not ok:
    print("DSN export FAILED")
    sys.exit(1)

# strip the fanned-out ORIGINAL pins from the DSN net pin lists (the breakout
# pads carry the net for the router; the stub copper carries connectivity)
if fanout_entries:
    _txt = open(dsn_path).read()
    for _e in fanout_entries:
        _txt = re.sub(r'(?<=[\s(])' + re.escape(_e["pin_token"]) + r'(?=[\s)])', '', _txt)
    open(dsn_path, "w").write(_txt)


def inset_boundary(path, inset_um):
    """Shrink the rectangular (boundary (path pcb 0 x0 y0 ...)) toward its
    centroid by inset_um. flroute only bbox-es these coords, so a clean
    inset rectangle is sufficient and robust."""
    txt = open(path).read()
    m = re.search(r"\(boundary\s*\(path\s+pcb\s+\d+\s+([0-9.eE+\s-]+?)\)", txt)
    if not m:
        return False, "no boundary path"
    nums = [float(v) for v in m.group(1).split()]
    xs, ys = nums[0::2], nums[1::2]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    nx0, nx1 = x0 + inset_um, x1 - inset_um
    ny0, ny1 = y0 + inset_um, y1 - inset_um
    # rebuild as closed inset rectangle (same winding start as KiCad export)
    new_path = (f"(path pcb 0  {nx1:.0f} {ny0:.0f}  {nx0:.0f} {ny0:.0f}  "
                f"{nx0:.0f} {ny1:.0f}  {nx1:.0f} {ny1:.0f}  {nx1:.0f} {ny0:.0f})")
    txt = txt[:m.start()] + "(boundary\n      " + new_path + txt[m.end():]
    open(path, "w").write(txt)
    return True, f"{(x1-x0)/1000:.1f}x{(y0-y1)/-1000:.1f}mm -> inset {inset_um/1000:.2f}mm"


done, msg = inset_boundary(dsn_path, inset_mm * 1000.0)
print(f"DSN export OK -> {dsn_path}")
print(f"boundary inset: {msg}" if done else f"boundary inset SKIPPED: {msg}")
print("ZONE_NETS:" + ",".join(zone_nets))
