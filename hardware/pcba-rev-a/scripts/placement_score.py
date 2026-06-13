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

# --- gate 3: edge clearance + mounting-hole keepout ------------------------------
# Defects in this class previously escaped to kicad-cli DRC (J7 pads 0.03mm
# from a mounting-hole circle). Every downstream defect class becomes an
# upstream gate check.
EDGE_KEEPOUT_MM = 3.0   # courtyard-to-board-edge (DFM conveyor rail)
HOLE_KEEPOUT_MM = 3.5   # courtyard-to-hole-center radial (M3 head + washer)

holes = [d for d in b.GetDrawings() if d.GetLayer() == pcbnew.Edge_Cuts
         and d.GetShape() == pcbnew.SHAPE_T_CIRCLE]
keepout_fails = []
if edges:
    o = edges[0].GetBoundingBox()
    for (ref, bb) in boxes:
        d_edge = min(
            pcbnew.ToMM(bb.GetLeft() - o.GetLeft()),
            pcbnew.ToMM(o.GetRight() - bb.GetRight()),
            pcbnew.ToMM(bb.GetTop() - o.GetTop()),
            pcbnew.ToMM(o.GetBottom() - bb.GetBottom()),
        )
        if d_edge < EDGE_KEEPOUT_MM:
            keepout_fails.append((ref, "edge", d_edge))
        for h in holes:
            c = h.GetCenter()
            dx = max(bb.GetLeft() - c.x, 0, c.x - bb.GetRight())
            dy = max(bb.GetTop() - c.y, 0, c.y - bb.GetBottom())
            d_hole = pcbnew.ToMM(int((dx * dx + dy * dy) ** 0.5))
            if d_hole < HOLE_KEEPOUT_MM:
                keepout_fails.append((ref, "hole", d_hole))

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

gate_pass = not overlaps and not outside and not keepout_fails
print("PLACEMENT GATE:", "PASS" if gate_pass else "FAIL")
for a, bb_ in overlaps[:12]:
    print("  overlap:", a, "<->", bb_)
for r in outside[:6]:
    print("  off-board:", r)
for ref, kind, d in keepout_fails[:12]:
    need = EDGE_KEEPOUT_MM if kind == "edge" else HOLE_KEEPOUT_MM
    print("  keepout: {} {:.2f}mm from {} (need {:.1f}mm)".format(ref, d, kind, need))
print("nets: {} | HPWL: {:.0f} mm".format(len(net_pads), hpwl_mm))
sys.exit(0 if gate_pass else 1)
