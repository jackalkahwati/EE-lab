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
    # foreign-net PADS too: a nudged via landing beside another net's pad is a
    # clearance/hole violation the track-only check missed. EXACT pad shapes —
    # a max-dimension circle falsely blocks everything beside elongated SOIC
    # pads (1.95mm long at 1.27mm pitch: neighbours "block" each other).
    pt = pcbnew.VECTOR2I(int(px), int(py))
    for fp2 in b.GetFootprints():
        for pad2 in fp2.Pads():
            if pad2.GetNetCode() == nc:
                continue
            L2 = pcbnew.F_Cu if pad2.IsOnLayer(pcbnew.F_Cu) else pcbnew.B_Cu
            sh2 = pad2.GetEffectiveShape(L2)
            if sh2.Collide(pt, int(vd // 2 + pcbnew.FromMM(0.22))):
                return True
    return False


def _bridge_clear(x0, y0, x1, y1, nc, layer):
    """True if a 0.2mm bridge track ON `layer` from (x0,y0) to (x1,y1) clears
    foreign copper ON THAT LAYER (vias always count — they span all layers).
    Inner-layer tracks do not conflict with an outer-layer bridge. Sampled along
    the segment; final DRC still gates everything."""
    n = max(2, int(((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5 / pcbnew.FromMM(0.3)))
    half_bridge = pcbnew.FromMM(0.1)
    for i in range(n + 1):
        px = x0 + (x1 - x0) * i // n
        py = y0 + (y1 - y0) * i // n
        for t in b.GetTracks():
            if t.GetNetCode() == nc:
                continue
            if t.GetClass() != "PCB_VIA" and t.GetLayer() != layer:
                continue
            need = half_bridge + t.GetWidth() // 2 + pcbnew.FromMM(0.21)
            if _seg_dist(px, py, t) < need:
                return False
        # foreign pads on the bridge layer block it too (EXACT shapes)
        pt3 = pcbnew.VECTOR2I(int(px), int(py))
        for fp3 in b.GetFootprints():
            for pad3 in fp3.Pads():
                if pad3.GetNetCode() == nc or not pad3.IsOnLayer(layer):
                    continue
                if pad3.GetEffectiveShape(layer).Collide(
                        pt3, int(half_bridge + pcbnew.FromMM(0.21))):
                    return False
    return True


def _fine_pitch(fp, pos):
    """True if this footprint has another pad within 0.8mm of `pos` — i.e. a
    fine-pitch part (0.5-0.65mm LGA/QFN/WSON) where the default 0.6mm via would
    clip the neighbour. Such pads take a finer 0.4/0.2 via (the board ships a
    matching finer-via-class .kicad_pro). Coarse parts (>=1.0mm-pitch SOIC,
    passives, relays) keep the default via, so nothing regresses."""
    for pad in fp.Pads():
        pp = pad.GetPosition()
        if (pp.x == pos.x and pp.y == pos.y):
            continue
        if (pp.x - pos.x) ** 2 + (pp.y - pos.y) ** 2 < pcbnew.FromMM(0.8) ** 2:
            return True
    return False


# Phase 16.5: pads already dogboned by the fine-pitch fanout carry their own
# offset via — an in-pad via here would clip the 0.5mm-pitch neighbours.
import json as _json  # noqa: E402
import os as _os      # noqa: E402
_fanout_skip = set()
_fp_path = _os.path.splitext(board_path)[0] + ".fanout.json"
if _os.path.exists(_fp_path):
    _fo = _json.load(open(_fp_path))
    for _e in _fo.get("dogbones", []) + _fo.get("entries", []):
        _fanout_skip.add(_e["pin_token"])

# candidate pads: SMD, on an outer copper layer, net has a plane zone, and NOT
# already served by a same-net via.
placed = 0
seen = set()
connected_pads = {}  # net -> [(x,y)] pads verified/made plane-connected
_retry = []
for fp in b.GetFootprints():
    for pad in fp.Pads():
        nc = pad.GetNetCode()
        if nc not in zone_nets:
            continue
        if "%s-%s" % (fp.GetReference(), pad.GetPadName()) in _fanout_skip:
            continue  # fanout dogbone already connects this pad to its plane
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
            connected_pads.setdefault(nc, []).append((pos.x, pos.y))
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
        # progressive rings: the pad->via bridge track spans the offset, so the
        # via can live further out when the immediate neighborhood is dense
        # (0402 clusters need ~1.0mm clear). Final DRC gates every placement.
        # distance-sorted GRID search (0.45mm step, radius 6mm): fixed-direction
        # rings miss the only free pocket in dense regions (header fields, SOIC
        # rows). Via spot must clear all layers; the pad->via bridge must clear
        # its own layer. Final DRC gates every placement.
        blayer = pcbnew.F_Cu if pcbnew.F_Cu in layers else pcbnew.B_Cu
        step = pcbnew.FromMM(0.45)
        R = 13   # 13*0.45 ~ 5.9mm
        cands = sorted(((dx, dy) for dx in range(-R, R + 1) for dy in range(-R, R + 1)),
                       key=lambda t: t[0] * t[0] + t[1] * t[1])
        spot = None
        for gx, gy in cands:
            dx, dy = gx * step, gy * step
            if _blocked(pos.x + dx, pos.y + dy, nc, vd):
                continue
            if (dx or dy) and not _bridge_clear(pos.x, pos.y,
                                                pos.x + dx, pos.y + dy, nc, blayer):
                continue
            spot = pcbnew.VECTOR2I(pos.x + dx, pos.y + dy)
            break
        if spot is None:
            # FALLBACK: no legal via spot anywhere nearby — bridge the pad BY
            # TRACK to the nearest same-net anchor that already reaches the
            # plane (a PTH pad or an existing via), path-checked on this layer.
            anchors = []
            for vx, vy in vias_by_net.get(nc, []):
                anchors.append((vx, vy))
            for fp4 in b.GetFootprints():
                for pad4 in fp4.Pads():
                    if pad4.GetNetCode() == nc and pad4.HasHole():
                        pp4 = pad4.GetPosition()
                        anchors.append((pp4.x, pp4.y))
            # already-plane-connected same-net SMD pads are valid anchors too
            # (landing at a pad often clears where landing at its via cannot)
            anchors += connected_pads.get(nc, [])
            anchors.sort(key=lambda a2: (a2[0] - pos.x) ** 2 + (a2[1] - pos.y) ** 2)
            bl2 = pcbnew.F_Cu if pcbnew.F_Cu in layers else pcbnew.B_Cu
            bridged = False
            for ax, ay in anchors[:5]:
                if (ax - pos.x) ** 2 + (ay - pos.y) ** 2 > pcbnew.FromMM(14) ** 2:
                    break
                if not _bridge_clear(pos.x, pos.y, ax, ay, nc, bl2):
                    continue
                tr2 = pcbnew.PCB_TRACK(b)
                tr2.SetStart(pos)
                tr2.SetEnd(pcbnew.VECTOR2I(ax, ay))
                tr2.SetWidth(pcbnew.FromMM(0.2))
                tr2.SetLayer(bl2)
                tr2.SetNetCode(nc)
                b.Add(tr2)
                placed += 1
                bridged = True
                break
            if not bridged:
                _retry.append((pad, nc, pos))
            else:
                connected_pads.setdefault(nc, []).append((pos.x, pos.y))
            continue
        via = pcbnew.PCB_VIA(b)
        via.SetPosition(spot)
        via.SetViaType(pcbnew.VIATYPE_THROUGH)
        via.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
        via.SetWidth(int(vd))
        via.SetDrill(int(vk))
        via.SetNetCode(nc)
        b.Add(via)
        # a NUDGED via may only graze (or miss) a small 0402 pad — guarantee the
        # connection with a short same-net track from the pad centre to the via.
        if spot.x != pos.x or spot.y != pos.y:
            lk = pcbnew.F_Cu if pcbnew.F_Cu in layers else pcbnew.B_Cu
            tr = pcbnew.PCB_TRACK(b)
            tr.SetStart(pos)
            tr.SetEnd(spot)
            tr.SetWidth(pcbnew.FromMM(0.2))
            tr.SetLayer(lk)
            tr.SetNetCode(nc)
            b.Add(tr)
        vias_by_net.setdefault(nc, []).append((spot.x, spot.y))
        connected_pads.setdefault(nc, []).append((pos.x, pos.y))
        seen.add(key)
        placed += 1

# RETRY pass: pads that found no via spot and no anchor on the first pass get a
# second chance once every other pad has been stitched (anchors now complete).
for pad, nc, pos in _retry:
    layers5 = list(pad.GetLayerSet().CuStack())
    bl5 = pcbnew.F_Cu if pcbnew.F_Cu in layers5 else pcbnew.B_Cu
    anchors = list(vias_by_net.get(nc, [])) + connected_pads.get(nc, [])
    for fp5 in b.GetFootprints():
        for pad5 in fp5.Pads():
            if pad5.GetNetCode() == nc and pad5.HasHole():
                pp5 = pad5.GetPosition()
                anchors.append((pp5.x, pp5.y))
    anchors.sort(key=lambda a5: (a5[0] - pos.x) ** 2 + (a5[1] - pos.y) ** 2)
    ok5 = False
    for ax, ay in anchors[:6]:
        if (ax - pos.x) ** 2 + (ay - pos.y) ** 2 > pcbnew.FromMM(14) ** 2:
            break
        if abs(ax - pos.x) < 100 and abs(ay - pos.y) < 100:
            continue
        if not _bridge_clear(pos.x, pos.y, ax, ay, nc, bl5):
            continue
        tr5 = pcbnew.PCB_TRACK(b)
        tr5.SetStart(pos)
        tr5.SetEnd(pcbnew.VECTOR2I(ax, ay))
        tr5.SetWidth(pcbnew.FromMM(0.2))
        tr5.SetLayer(bl5)
        tr5.SetNetCode(nc)
        b.Add(tr5)
        placed += 1
        ok5 = True
        break
    if not ok5:
        print("skip %s: no clear via spot at pad" % pad.GetNetname())

# refill zones so the new vias are captured by the pours before re-DRC
pcbnew.ZONE_FILLER(b).Fill(b.Zones())
b.Save(board_path)
print("STITCHED %d" % placed)
sys.stdout.flush()
