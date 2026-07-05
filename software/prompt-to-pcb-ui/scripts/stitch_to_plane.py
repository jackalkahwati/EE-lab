"""Via-stitch power/ground SMD pads to their plane — by GEOMETRY.

Power and ground nets are served by a copper plane (an inner-layer zone), but an
SMD pad on an outer layer is only actually connected if a via drops from it into
that plane. flroute leaves these as islands; a filled zone "serves" the net, so
KiCad may even CREDIT the pad as connected (the false "routed via zone") — which
made the old DRC-report-driven approach fragile: any change to the via class or
design rules shifted what DRC reported, and the heal then under-stitched.

This pass decides from geometry alone, independent of any DRC report: for EVERY
SMD pad on an outer layer whose net has a plane zone, if it does not already
have a same-net via, drop a through-via at the pad centre so it physically
reaches the plane. Idempotent (skips pads already stitched) and robust to rule
changes. Refill zones + re-DRC after to confirm.

  <kicad-python3> stitch_to_plane.py <board.kicad_pcb> [<drc.json ignored>]

Prints "STITCHED <n>". The KiCad 10.0.1 standalone swig interpreter may segfault
at teardown AFTER a clean save, so callers must key on the sentinel.
"""
import sys

import pcbnew

board_path = sys.argv[1]  # argv[2] (drc.json) is accepted but no longer used
b = pcbnew.LoadBoard(board_path)

# only nets that actually have a zone (plane) can be via-stitched to a plane
zone_nets = {z.GetNetCode() for z in b.Zones() if z.GetNetCode() > 0}

# via geometry: use the board's own via size so the via is design-rule compliant
# (matching its existing vias). Using anything smaller trips drill/diameter rules.
dsn = b.GetDesignSettings()
via_d = dsn.GetCurrentViaSize() or pcbnew.FromMM(0.6)
via_k = dsn.GetCurrentViaDrill() or pcbnew.FromMM(0.3)

OUTER = (pcbnew.F_Cu, pcbnew.B_Cu)

# existing same-net vias, so a pad already dropped to its plane is left alone
vias_by_net = {}
for t in b.GetTracks():
    if t.GetClass() == "PCB_VIA":
        p = t.GetPosition()
        vias_by_net.setdefault(t.GetNetCode(), []).append((p.x, p.y))


def _seg_dist(px, py, t):
    sx, sy = t.GetStart().x, t.GetStart().y
    ex, ey = t.GetEnd().x, t.GetEnd().y
    dx, dy = ex - sx, ey - sy
    L2 = dx * dx + dy * dy
    if L2 == 0:
        return ((px - sx) ** 2 + (py - sy) ** 2) ** 0.5
    u = max(0.0, min(1.0, ((px - sx) * dx + (py - sy) * dy) / L2))
    cx, cy = sx + u * dx, sy + u * dy
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def _blocked(px, py, nc, vd):
    # TRUE geometric distance to other-net copper. A bbox test false-blocks
    # everything near a long diagonal track, which left probe pads unstitched.
    for t in b.GetTracks():
        if t.GetNetCode() == nc:
            continue
        half = t.GetWidth() // 2
        need = vd // 2 + half + pcbnew.FromMM(0.22)
        if _seg_dist(px, py, t) < need:
            return True
    return False


def _fine_pitch(fp, pos):
    """True if this footprint has another pad within 0.6mm of `pos` — i.e. a
    0.5mm-pitch part where the default 0.6mm via would clip the neighbour. Such
    pads take a finer 0.4/0.2 via (the board ships a matching finer-via-class
    .kicad_pro). Coarse pads keep the default via, so nothing regresses."""
    for pad in fp.Pads():
        pp = pad.GetPosition()
        if (pp.x == pos.x and pp.y == pos.y):
            continue
        if (pp.x - pos.x) ** 2 + (pp.y - pos.y) ** 2 < pcbnew.FromMM(0.6) ** 2:
            return True
    return False


# candidate pads: SMD, on an outer copper layer, net has a plane zone, and NOT
# already served by a same-net via.
placed = 0
seen = set()
for fp in b.GetFootprints():
    for pad in fp.Pads():
        nc = pad.GetNetCode()
        if nc not in zone_nets:
            continue
        # through-hole pads already span to the inner plane — no via needed
        if pad.GetAttribute() == pcbnew.PAD_ATTRIB_PTH:
            continue
        layers = list(pad.GetLayerSet().CuStack())
        if not any(L in layers for L in OUTER):
            continue
        pos = pad.GetPosition()
        key = (nc, pos.x, pos.y)
        if key in seen:
            continue
        # already stitched? a same-net via within the pad's copper connects it
        sz = pad.GetSize()
        r = max(sz.x, sz.y) / 2.0 + pcbnew.FromMM(0.1)
        if any((vx - pos.x) ** 2 + (vy - pos.y) ** 2 < r * r
               for vx, vy in vias_by_net.get(nc, [])):
            continue

        # fine-pitch pads take a smaller via so via-in-pad clears the neighbour
        # (legal under the board's finer-via-class .kicad_pro); coarse pads keep
        # the default via, byte-identical to before.
        if _fine_pitch(fp, pos):
            vd, vk = pcbnew.FromMM(0.4), pcbnew.FromMM(0.2)
        else:
            vd, vk = via_d, via_k
        # drop the via at the pad centre, nudging to the first spot clear of
        # other-net copper on all layers.
        off = pcbnew.FromMM(0.4)
        spot = None
        for dx, dy in ((0, 0), (off, 0), (-off, 0), (0, off), (0, -off)):
            if not _blocked(pos.x + dx, pos.y + dy, nc, vd):
                spot = pcbnew.VECTOR2I(pos.x + dx, pos.y + dy)
                break
        if spot is None:
            print("skip %s: no clear via spot at pad" % pad.GetNetname())
            continue
        via = pcbnew.PCB_VIA(b)
        via.SetPosition(spot)
        via.SetViaType(pcbnew.VIATYPE_THROUGH)
        via.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
        via.SetWidth(int(vd))
        via.SetDrill(int(vk))
        via.SetNetCode(nc)
        b.Add(via)
        vias_by_net.setdefault(nc, []).append((spot.x, spot.y))
        seen.add(key)
        placed += 1

# refill zones so the new vias are captured by the pours before re-DRC
pcbnew.ZONE_FILLER(b).Fill(b.Zones())
b.Save(board_path)
print("STITCHED %d" % placed)
sys.stdout.flush()
