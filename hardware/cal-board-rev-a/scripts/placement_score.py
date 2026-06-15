"""Placement quality gate + HPWL score — FL-1 cal board Rev A.

Same gates as pcba-rev-a placement_score.py:
  Gate 1: no courtyard overlaps
  Gate 2: all components inside board outline
  Gate 3: courtyard >= 3.0 mm from edge, >= 3.5 mm from mounting holes

Usage (KiCad bundled python):
  <kicad-python3> scripts/placement_score.py [board.kicad_pcb]
"""
import sys
import pcbnew

BOARD = sys.argv[1] if len(sys.argv) > 1 else "elec/layout/cal-rev-a.kicad_pcb"

b   = pcbnew.LoadBoard(BOARD)
fps = list(b.GetFootprints())

EDGE_KEEPOUT_MM = 3.0
HOLE_KEEPOUT_MM = 3.5


def courtyard_bbox(fp):
    try:
        shape = fp.GetCourtyard(pcbnew.F_CrtYd)
        bb    = shape.BBox()
        if bb.GetWidth() > 0:
            return bb
    except Exception:
        pass
    return fp.GetBoundingBox(False, False)


boxes    = [(fp.GetReference(), courtyard_bbox(fp)) for fp in fps]
overlaps = []
for i, (ra, ba) in enumerate(boxes):
    for rb, bb2 in boxes[i + 1:]:
        if ba.Intersects(bb2):
            inter = ba.Intersect(bb2)
            if inter.GetWidth() > pcbnew.FromMM(0.05) and inter.GetHeight() > pcbnew.FromMM(0.05):
                overlaps.append((ra, rb))

edges   = [d for d in b.GetDrawings()
           if d.GetLayer() == pcbnew.Edge_Cuts and d.GetShape() == pcbnew.SHAPE_T_RECT]
holes   = [d for d in b.GetDrawings()
           if d.GetLayer() == pcbnew.Edge_Cuts and d.GetShape() == pcbnew.SHAPE_T_CIRCLE]
outside = []
keepout_fails = []

if edges:
    o = edges[0].GetBoundingBox()
    for fp in fps:
        if not o.Contains(fp.GetPosition()):
            outside.append(fp.GetReference())
    for ref, bb in boxes:
        d_edge = min(
            pcbnew.ToMM(bb.GetLeft()   - o.GetLeft()),
            pcbnew.ToMM(o.GetRight()   - bb.GetRight()),
            pcbnew.ToMM(bb.GetTop()    - o.GetTop()),
            pcbnew.ToMM(o.GetBottom()  - bb.GetBottom()),
        )
        if d_edge < EDGE_KEEPOUT_MM:
            keepout_fails.append((ref, "edge", d_edge))
        for h in holes:
            c  = h.GetCenter()
            dx = max(bb.GetLeft() - c.x, 0, c.x - bb.GetRight())
            dy = max(bb.GetTop()  - c.y, 0, c.y - bb.GetBottom())
            d  = pcbnew.ToMM(int((dx * dx + dy * dy) ** 0.5))
            if d < HOLE_KEEPOUT_MM:
                keepout_fails.append((ref, "hole", d))

net_pads = {}
for fp in fps:
    for pad in fp.Pads():
        code = pad.GetNetCode()
        if code <= 0:
            continue
        net_pads.setdefault(code, []).append(pad.GetPosition())
hpwl = sum(
    (max(p.x for p in pts) - min(p.x for p in pts)) +
    (max(p.y for p in pts) - min(p.y for p in pts))
    for pts in net_pads.values() if len(pts) >= 2
)
hpwl_mm = pcbnew.ToMM(hpwl)

gate_pass = not overlaps and not outside and not keepout_fails
print("PLACEMENT GATE:", "PASS" if gate_pass else "FAIL")
for a, b_ in overlaps[:12]:
    print("  overlap:", a, "<->", b_)
for r in outside[:6]:
    print("  off-board:", r)
for ref, kind, d in keepout_fails[:12]:
    need = EDGE_KEEPOUT_MM if kind == "edge" else HOLE_KEEPOUT_MM
    print(f"  keepout: {ref} {d:.2f} mm from {kind} (need {need:.1f} mm)")
print(f"nets: {len(net_pads)} | HPWL: {hpwl_mm:.0f} mm")
sys.exit(0 if gate_pass else 1)
