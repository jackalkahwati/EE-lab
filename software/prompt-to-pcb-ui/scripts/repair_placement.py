"""Placement repair: move keepout-violating footprints toward board center
until edge/hole clearances are satisfied without creating courtyard overlaps.

  <kicad-python3> repair_placement.py <board.kicad_pcb>

Prints "REPAIRED <n>" sentinel (teardown segfault tolerated by callers).
Bounded: 0.5mm steps, max 12mm per part. placement_score.py re-verifies.
"""
import sys

import pcbnew

EDGE_KEEPOUT_MM = 3.0
HOLE_KEEPOUT_MM = 3.5
STEP_MM = 0.5
MAX_MM = 12.0
MARGIN_MM = 0.15  # push slightly past the limit

board_path = sys.argv[1]
b = pcbnew.LoadBoard(board_path)
fps = list(b.GetFootprints())


def courtyard_bbox(fp):
    try:
        shape = fp.GetCourtyard(pcbnew.F_CrtYd)
        bb = shape.BBox()
        if bb.GetWidth() > 0:
            return bb
    except Exception:
        pass
    return fp.GetBoundingBox(False, False)


edges = [d for d in b.GetDrawings() if d.GetLayer() == pcbnew.Edge_Cuts
         and d.GetShape() == pcbnew.SHAPE_T_RECT]
holes = [d.GetCenter() for d in b.GetDrawings() if d.GetLayer() == pcbnew.Edge_Cuts
         and d.GetShape() == pcbnew.SHAPE_T_CIRCLE]
if not edges:
    print("REPAIRED 0 (no board outline)")
    sys.exit(0)
o = edges[0].GetBoundingBox()
cx, cy = (o.GetLeft() + o.GetRight()) // 2, (o.GetTop() + o.GetBottom()) // 2


def bb_shift(bb, dx, dy):
    nb = pcbnew.BOX2I(bb.GetPosition(), bb.GetSize())
    nb.Move(pcbnew.VECTOR2I(int(dx), int(dy)))
    return nb


def keepout_ok(bb):
    d_edge = min(bb.GetLeft() - o.GetLeft(), o.GetRight() - bb.GetRight(),
                 bb.GetTop() - o.GetTop(), o.GetBottom() - bb.GetBottom())
    if d_edge < pcbnew.FromMM(EDGE_KEEPOUT_MM + MARGIN_MM):
        return False
    for c in holes:
        dx = max(bb.GetLeft() - c.x, 0, c.x - bb.GetRight())
        dy = max(bb.GetTop() - c.y, 0, c.y - bb.GetBottom())
        if (dx * dx + dy * dy) ** 0.5 < pcbnew.FromMM(HOLE_KEEPOUT_MM + MARGIN_MM):
            return False
    return True


def overlaps_any(bb, skip_ref, all_boxes):
    for ref, other in all_boxes:
        if ref == skip_ref:
            continue
        if bb.Intersects(other):
            inter = bb.Intersect(other)
            if (inter.GetWidth() > pcbnew.FromMM(0.05)
                    and inter.GetHeight() > pcbnew.FromMM(0.05)):
                return True
    return False


all_boxes = [(fp.GetReference(), courtyard_bbox(fp)) for fp in fps]
moves = []  # (fp, dx, dy, ref, dist_mm)

for idx, fp in enumerate(fps):
    ref = fp.GetReference()
    bb = all_boxes[idx][1]
    if keepout_ok(bb):
        continue
    pos = fp.GetPosition()
    vx, vy = cx - pos.x, cy - pos.y
    norm = (vx * vx + vy * vy) ** 0.5 or 1.0
    ux, uy = vx / norm, vy / norm
    placed = False
    d = STEP_MM
    while d <= MAX_MM:
        dx, dy = ux * pcbnew.FromMM(d), uy * pcbnew.FromMM(d)
        nb = bb_shift(bb, dx, dy)
        if keepout_ok(nb) and not overlaps_any(nb, ref, all_boxes):
            moves.append((fp, int(dx), int(dy), ref, d))
            all_boxes[idx] = (ref, nb)  # later parts see the new position
            placed = True
            break
        d += STEP_MM
    if not placed:
        print(f"  UNREPAIRABLE: {ref} (no clear spot within {MAX_MM}mm)")

for fp, dx, dy, ref, d in moves:
    p = fp.GetPosition()
    fp.SetPosition(pcbnew.VECTOR2I(p.x + dx, p.y + dy))
    print(f"  moved {ref} {d:.1f}mm toward center")

if moves:
    pcbnew.SaveBoard(board_path, b)
print(f"REPAIRED {len(moves)}")
