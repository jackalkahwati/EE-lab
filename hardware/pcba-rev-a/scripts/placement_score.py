"""Placement quality gate + score. Run BEFORE the router — placements that
fail the gate or score badly never reach freerouting.

Score: total half-perimeter wirelength (HPWL) over all nets — the standard
placement-quality estimator. Gate: courtyard overlaps and off-board parts
(the defects that made earlier routing runs trial-and-error).

Usage (KiCad bundled python):
  .../python3 scripts/placement_score.py [board.kicad_pcb]
"""
import sys

import pcbnew

BOARD = sys.argv[1] if len(sys.argv) > 1 else "elec/layout/rev-a-routed.kicad_pcb"

b = pcbnew.LoadBoard(BOARD)
fps = list(b.GetFootprints())

# --- gate 1: courtyard overlaps ------------------------------------------------
def courtyard_bbox(fp):
    try:
        shape = fp.GetCourtyard(pcbnew.F_CrtYd)
        bb = shape.BBox()
        if bb.GetWidth() > 0:
            return bb
    except Exception:
        pass
    return fp.GetBoundingBox(False, False)

boxes = [(fp.GetReference(), courtyard_bbox(fp)) for fp in fps]
overlaps = []
for i, (ra, ba) in enumerate(boxes):
    for rb, bb2 in boxes[i + 1:]:
        if ba.Intersects(bb2):
            inter = ba.Intersect(bb2)
            if inter.GetWidth() > pcbnew.FromMM(0.05) and inter.GetHeight() > pcbnew.FromMM(0.05):
                overlaps.append((ra, rb))

# --- gate 2: inside board outline ----------------------------------------------
edges = [d for d in b.GetDrawings() if d.GetLayer() == pcbnew.Edge_Cuts
         and d.GetShape() == pcbnew.SHAPE_T_RECT]
outside = []
if edges:
    o = edges[0].GetBoundingBox()
    for fp in fps:
        if not o.Contains(fp.GetPosition()):
            outside.append(fp.GetReference())

# --- score: HPWL ------------------------------------------------------------------
net_pads = {}
for fp in fps:
    for pad in fp.Pads():
        code = pad.GetNetCode()
        if code <= 0:
            continue
        net_pads.setdefault(code, []).append(pad.GetPosition())
hpwl = 0
for code, pts in net_pads.items():
    if len(pts) < 2:
        continue
    xs = [p.x for p in pts]
    ys = [p.y for p in pts]
    hpwl += (max(xs) - min(xs)) + (max(ys) - min(ys))
hpwl_mm = pcbnew.ToMM(hpwl)

print("PLACEMENT GATE:", "PASS" if not overlaps and not outside else "FAIL")
for a, bb_ in overlaps[:12]:
    print("  overlap:", a, "<->", bb_)
for r in outside[:6]:
    print("  off-board:", r)
print("nets: {} | HPWL: {:.0f} mm".format(len(net_pads), hpwl_mm))
sys.exit(0 if not overlaps and not outside else 1)
