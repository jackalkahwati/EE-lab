"""Pad-entry stitching: close the flroute referee gap.

flroute terminates routes at grid-cell centers that can sit 100-400um
outside the actual pad polygon (target rasterization includes cells whose
center misses the pad). This pass adds a short same-net segment from each
near-miss track endpoint to the pad center.

  <kicad-python3> stitch_pads.py <board.kicad_pcb>

Prints "STITCHED <n>" sentinel; interpreter may segfault at teardown
(KiCad 10.0.1 standalone swig) AFTER a clean save — callers must key on
the sentinel. The native fix belongs in flroute (emit a pad-entry segment);
this keeps the pipeline honest until then.
"""
import sys
from collections import defaultdict

import pcbnew

MAX_STITCH_NM = 600_000  # 0.6 mm: must exceed worst observed undershoot (400um)
CLEAR_NM = 200_000       # 0.2 mm board clearance — a stitch that comes within
                         # this of foreign-net copper is dropped, not shipped.

board_path = sys.argv[1]
b = pcbnew.LoadBoard(board_path)

# Zone-served nets (lv / coil_bus) are NOT stitchable laterally — their
# SMD pads reach the pour via fanout vias, a separate import_route.py pass.
# flroute v1 also snaps signal terminals to pad copper natively, so this
# pass is now a thin safety net for any residual near-miss only.
zone_codes = {z.GetNetCode() for z in b.Zones() if z.GetNetCode() > 0}

# ---- read-only pass first (swig: plan all mutations before applying any) ----
pads_by_net = defaultdict(list)
for fp in b.GetFootprints():
    for pad in fp.Pads():
        code = pad.GetNetCode()
        if code > 0 and code not in zone_codes:
            pads_by_net[code].append(pad)

segs_by_net = defaultdict(list)
for t in b.GetTracks():
    segs_by_net[t.GetNetCode()].append(t)

plan = []  # (start, end, layer, width, netcode, label)
for code, pads in pads_by_net.items():
    segs = segs_by_net.get(code)
    if not segs:
        continue
    for pad in pads:
        is_th = pad.HasHole()
        layer = pad.GetLayer()
        shape = pad.GetEffectiveShape(layer)
        touched = False
        best = None  # (dist2, endpoint, seg_layer, width)
        for s in segs:
            is_via = s.GetClass() == "PCB_VIA"
            ends = [s.GetPosition()] if is_via else [s.GetStart(), s.GetEnd()]
            for e in ends:
                if shape.Collide(e, 0):
                    touched = True
                    break
                if is_via and not is_th:
                    continue  # via can't enter an SMD pad on another layer
                if not is_via and not is_th and s.GetLayer() != layer:
                    continue
                d2 = (e.x - pad.GetPosition().x) ** 2 + (e.y - pad.GetPosition().y) ** 2
                if not shape.Collide(e, MAX_STITCH_NM):
                    continue
                w = pcbnew.FromMM(0.2) if is_via else s.GetWidth()
                lay = layer if is_via else s.GetLayer()
                if best is None or d2 < best[0]:
                    best = (d2, pcbnew.VECTOR2I(e.x, e.y), lay, w)
            if touched:
                break
        if touched or best is None:
            continue
        try:
            ref = pad.GetParentFootprint().GetReference()
        except Exception:
            ref = "?"
        plan.append((best[1], pcbnew.VECTOR2I(pad.GetPosition().x, pad.GetPosition().y),
                     best[2], best[3], code, f"{ref}-{pad.GetNumber()}"))

# ---- tee-bridge pass (Phase 16.7): close same-net track-end -> track gaps ----
# flroute tree branches occasionally tee into another branch one grid cell off,
# leaving a 0.1-0.5mm same-net gap MID-track that the pad pass cannot see (the
# REF_OUT junction gap). Bridge any dangling same-net end to the nearest same-net
# segment within reach — same net, electrically safe, and the clearance gate
# below still vets every bridge before it ships.
def _seg_pt(px, py, s):
    x1, y1 = s.GetStart().x, s.GetStart().y
    x2, y2 = s.GetEnd().x, s.GetEnd().y
    dx, dy = x2 - x1, y2 - y1
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / L2))
    cx, cy = x1 + t * dx, y1 + t * dy
    return (px - cx) ** 2 + (py - cy) ** 2, int(cx), int(cy)


for code, segs in segs_by_net.items():
    if code <= 0 or code in zone_codes:
        continue
    tracks = [s for s in segs if s.GetClass() != "PCB_VIA"]
    for s in tracks:
        for e in (s.GetStart(), s.GetEnd()):
            touching = False
            for o in segs:
                if o is s:
                    continue
                if o.GetClass() == "PCB_VIA":
                    r = o.GetWidth() // 2 + s.GetWidth() // 2
                    if (o.GetPosition().x - e.x) ** 2 + (o.GetPosition().y - e.y) ** 2 <= r * r:
                        touching = True
                        break
                elif o.GetLayer() == s.GetLayer():
                    d2, _cx, _cy = _seg_pt(e.x, e.y, o)
                    if d2 <= ((o.GetWidth() + s.GetWidth()) // 2) ** 2:
                        touching = True
                        break
            if not touching:
                for pad in pads_by_net.get(code, []):
                    if pad.GetEffectiveShape(s.GetLayer()).Collide(e, 0):
                        touching = True
                        break
            if touching:
                continue
            best = None
            for o in tracks:
                if o is s or o.GetLayer() != s.GetLayer():
                    continue
                d2, cx, cy = _seg_pt(e.x, e.y, o)
                if d2 <= MAX_STITCH_NM ** 2 and (best is None or d2 < best[0]):
                    best = (d2, cx, cy)
            if best is not None and best[0] > 100:
                plan.append((pcbnew.VECTOR2I(e.x, e.y),
                             pcbnew.VECTOR2I(best[1], best[2]),
                             s.GetLayer(), s.GetWidth(), code, "tee-bridge"))

# ---- clearance index: foreign-net copper per layer (read-only snapshot) ------
# A stitch is non-grid copper, so unlike the main router its segment can graze
# another net within clearance (DRC clearance). Build per-layer shapes of every
# pad/track/via so each planned stitch can be tested before it is committed.
COPPER = [pcbnew.F_Cu, pcbnew.In1_Cu, pcbnew.In2_Cu, pcbnew.B_Cu]
layer_shapes = {L: [] for L in COPPER}
for fp in b.GetFootprints():
    for pad in fp.Pads():
        c = pad.GetNetCode()
        for L in COPPER:
            if pad.IsOnLayer(L):
                layer_shapes[L].append((pad.GetEffectiveShape(L), c))
for t in b.GetTracks():
    c = t.GetNetCode()
    if t.GetClass() == "PCB_VIA":
        for L in COPPER:
            layer_shapes[L].append((t.GetEffectiveShape(), c))
    elif t.GetLayer() in layer_shapes:
        layer_shapes[t.GetLayer()].append((t.GetEffectiveShape(), c))


def clears(seg, layer, code):
    """True if this stitch segment clears all foreign-net copper on its layer."""
    for sh, c in layer_shapes.get(layer, []):
        if c == code:
            continue
        if sh.Collide(seg, CLEAR_NM):
            return False
    return True


# ---- apply (clearance-gated) -------------------------------------------------
applied, skipped = 0, 0
for start, end, layer, width, code, label in plan:
    seg = pcbnew.SHAPE_SEGMENT(start, end, width)
    if not clears(seg, layer, code):
        skipped += 1
        continue
    tr = pcbnew.PCB_TRACK(b)
    tr.SetStart(start)
    tr.SetEnd(end)
    tr.SetLayer(layer)
    tr.SetWidth(width)
    tr.SetNetCode(code)
    b.Add(tr)
    # later stitches must also clear this one
    layer_shapes[layer].append((seg, code))
    applied += 1
    print(f"  stitch {label}: {pcbnew.ToMM(start.x - end.x):+.3f},{pcbnew.ToMM(start.y - end.y):+.3f} mm")

if applied:
    pcbnew.SaveBoard(board_path, b)
print(f"stitch dropped (clearance): {skipped}")
print(f"STITCHED {applied}")
