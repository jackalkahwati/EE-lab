"""RF pass: controlled-impedance widths + ground via fence for RF nets.

The grid router treats RF nets like any signal. This pass finds RF nets by
name (ANT, RF*, *_RF), computes the 50-ohm microstrip width for the stackup,
resizes the outer-layer segments (clamped so no clearance violation is
introduced), and places a GND via fence alongside. Zones are refilled.

Impedance model: IPC-2141 surface microstrip,
    Z0 = 87/sqrt(er+1.41) * ln(5.98*h / (0.8*w + t))
Stackup defaults are the JLC7628-class 4-layer: h=0.2104 mm prepreg to the
GND plane, er=4.4, t=0.035 mm outer copper. Override via env RF_H_MM / RF_ER.

  <kicad-python3> rf_pass.py <board.kicad_pcb> [target_ohms]

Prints one "RF_NET <name> w=<mm> Z0=<ohms> fence=<n>" line per net and a
final "RF_PASS <n>" sentinel (KiCad swig may segfault at teardown after a
clean save; callers key on the sentinel).
"""
import math
import os
import re
import sys

import pcbnew

board_path = sys.argv[1]
TARGET = float(sys.argv[2]) if len(sys.argv) > 2 else 50.0

H_MM = float(os.environ.get("RF_H_MM", "0.2104"))
ER = float(os.environ.get("RF_ER", "4.4"))
T_MM = 0.035

RF_NET = re.compile(r"^(ANT\w*|RF\w*|\w*_RF)$", re.IGNORECASE)


def z0_of(w_mm):
    return 87.0 / math.sqrt(ER + 1.41) * math.log(5.98 * H_MM / (0.8 * w_mm + T_MM))


def width_for(z0):
    lo, hi = 0.05, 3.0
    for _ in range(60):
        mid = (lo + hi) / 2
        if z0_of(mid) > z0:
            lo = mid  # too thin -> impedance high -> widen
        else:
            hi = mid
    return (lo + hi) / 2


b = pcbnew.LoadBoard(board_path)
gnd = None
for n in b.GetNetsByName().items():
    if str(n[0]) == "GND":
        gnd = n[1].GetNetCode()

dsn = b.GetDesignSettings()
via_d = int(dsn.GetCurrentViaSize() or pcbnew.FromMM(0.6))
via_k = int(dsn.GetCurrentViaDrill() or pcbnew.FromMM(0.3))
CLR = pcbnew.FromMM(0.20)

target_w = width_for(TARGET)

edges = b.GetBoardEdgesBoundingBox()


def clearance_limited_width(seg):
    """Largest width for this segment that keeps CLR to other-net copper."""
    sx, sy = seg.GetStart().x, seg.GetStart().y
    ex, ey = seg.GetEnd().x, seg.GetEnd().y
    mx, my = (sx + ex) // 2, (sy + ey) // 2
    best = pcbnew.FromMM(target_w)
    for t in b.GetTracks():
        if t.GetNetCode() == seg.GetNetCode():
            continue
        bb = t.GetBoundingBox()
        for px, py in ((sx, sy), (mx, my), (ex, ey)):
            dx = max(bb.GetLeft() - px, 0, px - bb.GetRight())
            dy = max(bb.GetTop() - py, 0, py - bb.GetBottom())
            d = math.hypot(dx, dy)
            if d > 0:
                best = min(best, int(2 * (d - CLR)))
    for fp in b.GetFootprints():
        for pad in fp.Pads():
            if pad.GetNetCode() == seg.GetNetCode():
                continue
            bb = pad.GetBoundingBox()
            for px, py in ((sx, sy), (mx, my), (ex, ey)):
                dx = max(bb.GetLeft() - px, 0, px - bb.GetRight())
                dy = max(bb.GetTop() - py, 0, py - bb.GetBottom())
                d = math.hypot(dx, dy)
                if d > 0:
                    best = min(best, int(2 * (d - CLR)))
    return max(best, seg.GetWidth())  # never shrink below what routed clean


def spot_clear(x, y, netcode):
    m = via_d // 2 + CLR
    if not (edges.GetLeft() + m < x < edges.GetRight() - m and
            edges.GetTop() + m < y < edges.GetBottom() - m):
        return False
    for t in b.GetTracks():
        if t.GetNetCode() == netcode:
            continue
        bb = t.GetBoundingBox()
        if (bb.GetLeft() - m <= x <= bb.GetRight() + m and
                bb.GetTop() - m <= y <= bb.GetBottom() + m):
            return False
    for fp in b.GetFootprints():
        for pad in fp.Pads():
            bb = pad.GetBoundingBox()
            if (bb.GetLeft() - m <= x <= bb.GetRight() + m and
                    bb.GetTop() - m <= y <= bb.GetBottom() + m):
                return False
    return True


OUTER = (pcbnew.F_Cu, pcbnew.B_Cu)
by_net = {}
for t in b.GetTracks():
    if t.GetClass() != "PCB_TRACK":
        continue
    name = t.GetNetname()
    if RF_NET.match(name or "") and t.GetLayer() in OUTER:
        by_net.setdefault(name, []).append(t)

total_nets = 0
for name, segs in by_net.items():
    total_nets += 1
    # width: target clamped per segment by available clearance
    applied = []
    for seg in segs:
        w = min(pcbnew.FromMM(target_w), clearance_limited_width(seg))
        seg.SetWidth(int(w))
        applied.append(pcbnew.ToMM(w))
    w_min = min(applied)
    z_actual = z0_of(w_min)

    # GND via fence alongside each segment, both sides, ~1.5 mm pitch
    fence = 0
    if gnd is not None:
        pitch = pcbnew.FromMM(1.5)
        for seg in segs:
            sx, sy = seg.GetStart().x, seg.GetStart().y
            ex, ey = seg.GetEnd().x, seg.GetEnd().y
            L = math.hypot(ex - sx, ey - sy)
            if L < pitch:
                continue
            ux, uy = (ex - sx) / L, (ey - sy) / L
            off = seg.GetWidth() // 2 + CLR + via_d // 2 + pcbnew.FromMM(0.05)
            n = int(L // pitch)
            for i in range(1, n + 1):
                px, py = sx + ux * i * pitch, sy + uy * i * pitch
                for s in (1, -1):
                    vx = int(px - uy * off * s)
                    vy = int(py + ux * off * s)
                    if not spot_clear(vx, vy, gnd):
                        continue
                    via = pcbnew.PCB_VIA(b)
                    via.SetPosition(pcbnew.VECTOR2I(vx, vy))
                    via.SetViaType(pcbnew.VIATYPE_THROUGH)
                    via.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
                    via.SetWidth(via_d)
                    via.SetDrill(via_k)
                    via.SetNetCode(gnd)
                    b.Add(via)
                    fence += 1
    print("RF_NET %s w=%.3f Z0=%.1f fence=%d" % (name, w_min, z_actual, fence))

if total_nets:
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
pcbnew.SaveBoard(board_path, b)
print("RF_PASS %d" % total_nets)
