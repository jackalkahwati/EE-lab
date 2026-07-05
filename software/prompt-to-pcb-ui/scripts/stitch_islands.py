"""Via-stitch isolated outer-layer zone islands to their plane.

stitch_to_plane.py closes the pad case (an SMD power/gnd pad with no via to
its plane). This closes the remaining case KiCad DRC reports as
"Missing connection between items / Zone [GND] on F.Cu": the outer-layer pour
fractures into multiple islands around routing, and an island with no
through-via touching it has no path to the inner plane, so the two islands of
the same net never join.

For every filled island of a plane-net zone on an outer copper layer that does
not already contain a same-net through-via or PTH pad, this places one
through-via inside the island (clear of other-net copper), then refills zones.

  <kicad-python3> stitch_islands.py <board.kicad_pcb>

Prints "STITCHED_ISLANDS <n>". The KiCad 10.0.1 standalone swig interpreter may
segfault at teardown AFTER a clean save, so callers must key on the sentinel.
"""
import sys

import pcbnew

board_path = sys.argv[1]
b = pcbnew.LoadBoard(board_path)

# refill first so island geometry is current
pcbnew.ZONE_FILLER(b).Fill(b.Zones())

OUTER = (pcbnew.F_Cu, pcbnew.B_Cu)

dsn = b.GetDesignSettings()
via_d = int(dsn.GetCurrentViaSize() or pcbnew.FromMM(0.6))
via_k = int(dsn.GetCurrentViaDrill() or pcbnew.FromMM(0.3))
MARGIN = int(via_d / 2 + pcbnew.FromMM(0.20))  # ring clearance for candidates


def outline_points(chain):
    return [(chain.CPoint(i).x, chain.CPoint(i).y) for i in range(chain.PointCount())]


def point_in_poly(x, y, pts):
    """Ray cast; pts = [(x,y), ...] closed implicitly."""
    inside = False
    n = len(pts)
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def in_island(x, y, outline, holes):
    if not point_in_poly(x, y, outline):
        return False
    for hpts in holes:
        if point_in_poly(x, y, hpts):
            return False
    return True


def in_island_with_margin(x, y, outline, holes, m):
    for dx, dy in ((0, 0), (m, 0), (-m, 0), (0, m), (0, -m), (m, m), (-m, -m), (m, -m), (-m, m)):
        if not in_island(x + dx, y + dy, outline, holes):
            return False
    return True


# same-net through-connections: vias + PTH pads, by net
through = {}  # netcode -> [(x, y)]
for t in b.GetTracks():
    if t.GetClass() == 'PCB_VIA':
        through.setdefault(t.GetNetCode(), []).append((t.GetPosition().x, t.GetPosition().y))
for fp in b.GetFootprints():
    for pad in fp.Pads():
        if pad.GetAttribute() == pcbnew.PAD_ATTRIB_PTH:
            through.setdefault(pad.GetNetCode(), []).append((pad.GetPosition().x, pad.GetPosition().y))

# obstacles: other-net copper to keep the new via away from
def blocked(x, y, netcode):
    m = MARGIN + pcbnew.FromMM(0.05)
    for t in b.GetTracks():
        if t.GetNetCode() == netcode:
            continue
        bb = t.GetBoundingBox()
        if (bb.GetLeft() - m <= x <= bb.GetRight() + m and
                bb.GetTop() - m <= y <= bb.GetBottom() + m):
            return True
    for fp in b.GetFootprints():
        for pad in fp.Pads():
            if pad.GetNetCode() == netcode:
                continue
            bb = pad.GetBoundingBox()
            if (bb.GetLeft() - m <= x <= bb.GetRight() + m and
                    bb.GetTop() - m <= y <= bb.GetBottom() + m):
                return True
    return False


# nets that have a plane to land on: zone on some non-outer layer, or any
# second zone layer distinct from the island's own layer
zone_layers = {}  # netcode -> set(layers)
for z in b.Zones():
    if z.GetNetCode() <= 0:
        continue
    for ly in list(OUTER) + [pcbnew.In1_Cu, pcbnew.In2_Cu, pcbnew.In3_Cu, pcbnew.In4_Cu]:
        try:
            if z.IsOnLayer(ly):
                zone_layers.setdefault(z.GetNetCode(), set()).add(ly)
        except Exception:
            pass

placed = 0
for z in b.Zones():
    net = z.GetNetCode()
    if net <= 0:
        continue
    for layer in OUTER:
        if not z.IsOnLayer(layer):
            continue
        # only stitch if the net has copper on some OTHER layer to reach
        if not (zone_layers.get(net, set()) - {layer}):
            continue
        polys = z.GetFilledPolysList(layer)
        for i in range(polys.OutlineCount()):
            outline = outline_points(polys.Outline(i))
            if len(outline) < 3:
                continue
            holes = [outline_points(polys.Hole(i, j)) for j in range(polys.HoleCount(i))]
            # already tied through? (any same-net via/PTH pad inside island)
            tied = any(in_island(x, y, outline, holes) for x, y in through.get(net, []))
            if tied:
                continue
            # find a spot: centroid first, then a coarse grid over the bbox
            cx = sum(p[0] for p in outline) // len(outline)
            cy = sum(p[1] for p in outline) // len(outline)
            xs = [p[0] for p in outline]
            ys = [p[1] for p in outline]
            step = pcbnew.FromMM(1.0)
            candidates = [(cx, cy)]
            gx = min(xs) + MARGIN
            while gx <= max(xs) - MARGIN:
                gy = min(ys) + MARGIN
                while gy <= max(ys) - MARGIN:
                    candidates.append((gx, gy))
                    gy += step
                gx += step
            spot = None
            for x, y in candidates:
                if in_island_with_margin(x, y, outline, holes, MARGIN) and not blocked(x, y, net):
                    spot = (x, y)
                    break
            if spot is None:
                print("island skipped (no clear via spot): net %d layer %d" % (net, layer))
                continue
            via = pcbnew.PCB_VIA(b)
            via.SetPosition(pcbnew.VECTOR2I(int(spot[0]), int(spot[1])))
            via.SetViaType(pcbnew.VIATYPE_THROUGH)
            via.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
            via.SetWidth(via_d)
            via.SetDrill(via_k)
            via.SetNetCode(net)
            b.Add(via)
            through.setdefault(net, []).append(spot)
            placed += 1

if placed:
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
pcbnew.SaveBoard(board_path, b)
print("STITCHED_ISLANDS %d" % placed)
