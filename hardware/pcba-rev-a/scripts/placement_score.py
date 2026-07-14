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
            w = pcbnew.ToMM(inter.GetWidth())
            h = pcbnew.ToMM(inter.GetHeight())
            # Real overlap = meaningfully two-dimensional OR a long knife-edge
            # sliver by area. The old both-dims > 0.05mm test let a
            # 10mm x 0.04mm edge-on overlap pass; the area term catches it
            # while still tolerating rounding-level courtyard abutment.
            if (w > 0.05 and h > 0.05) or w * h > 0.25:
                overlaps.append((ra, rb))

# --- gate 2: inside board outline ----------------------------------------------
edges = [d for d in b.GetDrawings() if d.GetLayer() == pcbnew.Edge_Cuts
         and d.GetShape() == pcbnew.SHAPE_T_RECT]
outside = []
if edges:
    o = edges[0].GetBoundingBox()
    # the whole COURTYARD must sit inside the outline — checking only the
    # footprint origin let a half-off-board part pass.
    for ref, bb in boxes:
        if (bb.GetLeft() < o.GetLeft() or bb.GetRight() > o.GetRight()
                or bb.GetTop() < o.GetTop() or bb.GetBottom() > o.GetBottom()):
            outside.append(ref)

# --- gate 3: edge clearance + mounting-hole keepout ------------------------------
# Defects in this class previously escaped to kicad-cli DRC (J7 pads 0.03mm
# from a mounting-hole circle). Every downstream defect class becomes an
# upstream gate check.
EDGE_KEEPOUT_MM = 3.0   # courtyard-to-board-edge (DFM conveyor rail)
HOLE_KEEPOUT_MM = 3.5   # courtyard-to-hole-center radial (M3 head + washer)

# Hole centers come from BOTH sources: bare Edge.Cuts circles (the hand
# rev-a layout) AND mounting-hole FOOTPRINTS (what the generated boards emit
# — the circle-only detection made this check dead code on them, so a screw
# head crushing a neighboring part passed every gate).
hole_centers = [d.GetCenter() for d in b.GetDrawings()
                if d.GetLayer() == pcbnew.Edge_Cuts
                and d.GetShape() == pcbnew.SHAPE_T_CIRCLE]


def is_hole_fp(fp):
    if "MountingHole" in str(fp.GetFPID().GetLibItemName()):
        return True
    if "MountingHole" in str(fp.GetFPID().GetLibNickname()):
        return True
    return any(p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH for p in fp.Pads())


hole_refs = set()
for fp in fps:
    if is_hole_fp(fp):
        hole_refs.add(fp.GetReference())
        hole_centers.append(fp.GetPosition())

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
        if ref in hole_refs:
            continue  # a hole is not crushed by its own (or a sibling's) screw
        for c in hole_centers:
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
