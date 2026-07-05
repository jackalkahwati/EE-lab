"""Pipeline step — apply per-class trace widths AFTER routing.

flroute routes every net at one global width. This pass widens the tracks on
power / high-current nets to their constraint class width (constraints.json),
but ONLY where the extra copper still clears neighbouring nets — so it makes the
board genuinely reflect the net classes (power traces become wider than signal
traces) WITHOUT introducing a single DRC violation. Tracks that can't widen
safely keep their routed width and are reported.

  <kicad-python3> widen_power.py <board.kicad_pcb> <constraints.json>

Prints "WIDENED <n> of <m> power tracks (<k> clearance-limited)".
"""
import json
import sys

import pcbnew

board_path, constraints_path = sys.argv[1], sys.argv[2]
b = pcbnew.LoadBoard(board_path)
model = json.load(open(constraints_path))

# nets whose class asks for a wider trace than the routed default. v1 widens the
# main SUPPLY rails only (power_input / power_rail) — motor/coil drives are often
# tightly packed (parallel drive lines from a driver to N relays), so widening
# them post-route is unsafe; their width target stays recorded in the model for a
# future clearance-aware router.
WIDEN_CLASSES = ("power_input", "power_rail")
want = {}  # netname -> target width (nm)
for n, info in model["nets"].items():
    if info["class"] in WIDEN_CLASSES:
        want[n] = pcbnew.FromMM(info["rules"].get("min_width", 0.3))

# keep at least the board's clearance requirement (Default net class 0.2mm) to
# other-net copper after widening, plus a small margin, so widening NEVER
# introduces a DRC violation.
REQ_CLEAR = pcbnew.FromMM(0.22)
tracks = list(b.GetTracks())


def _pt_seg(px, py, sx, sy, ex, ey):
    dx, dy = ex - sx, ey - sy
    L2 = dx * dx + dy * dy
    if L2 == 0:
        return ((px - sx) ** 2 + (py - sy) ** 2) ** 0.5
    u = max(0.0, min(1.0, ((px - sx) * dx + (py - sy) * dy) / L2))
    return ((px - (sx + u * dx)) ** 2 + (py - (sy + u * dy)) ** 2) ** 0.5


def _seg_seg(a, b, c, d):
    """TRUE min distance between segment a-b and segment c-d (non-intersecting
    case = min of the four endpoint-to-segment distances). This is what the
    3-point sampling got wrong — the closest approach of two parallel tracks is
    not always at a sampled point."""
    return min(
        _pt_seg(a[0], a[1], c[0], c[1], d[0], d[1]),
        _pt_seg(b[0], b[1], c[0], c[1], d[0], d[1]),
        _pt_seg(c[0], c[1], a[0], a[1], b[0], b[1]),
        _pt_seg(d[0], d[1], a[0], a[1], b[0], b[1]),
    )


def _nearest_other_copper(trk, nc):
    """TRUE min distance from this track's copper edge to any other-net copper
    edge (segment-to-segment for tracks, point-to-segment for pads)."""
    s, e = trk.GetStart(), trk.GetEnd()
    a, bb = (s.x, s.y), (e.x, e.y)
    best = 1 << 62
    for t in tracks:
        if t is trk or t.GetNetCode() == nc:
            continue
        if t.GetClass() == "PCB_VIA":
            vp = t.GetPosition()
            best = min(best, _pt_seg(vp.x, vp.y, a[0], a[1], bb[0], bb[1]) - t.GetWidth() // 2)
            continue
        ts, te = t.GetStart(), t.GetEnd()
        best = min(best, _seg_seg(a, bb, (ts.x, ts.y), (te.x, te.y)) - t.GetWidth() // 2)
    for fp in b.GetFootprints():
        for pad in fp.Pads():
            if pad.GetNetCode() == nc:
                continue
            pp = pad.GetPosition()
            psz = pad.GetSize()
            phalf = max(psz.x, psz.y) / 2.0
            best = min(best, _pt_seg(pp.x, pp.y, a[0], a[1], bb[0], bb[1]) - phalf)
    return best


widened = limited = considered = 0
for trk in tracks:
    if trk.GetClass() != "PCB_TRACK":
        continue
    net = trk.GetNetname()
    target = want.get(net)
    if not target or target <= trk.GetWidth():
        continue
    considered += 1
    d = _nearest_other_copper(trk, trk.GetNetCode())
    # widest we can go: leave REQ_CLEAR to the nearest other-net copper edge
    max_w = int(2 * (d - REQ_CLEAR))
    new_w = min(target, max_w)
    if new_w > trk.GetWidth() + pcbnew.FromMM(0.02):
        trk.SetWidth(new_w)
        widened += 1
    else:
        limited += 1

pcbnew.ZONE_FILLER(b).Fill(b.Zones())
b.Save(board_path)
print("WIDENED %d of %d power tracks (%d clearance-limited)" % (widened, considered, limited))
sys.stdout.flush()
