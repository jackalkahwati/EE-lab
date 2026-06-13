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

# ---- apply ------------------------------------------------------------------
for start, end, layer, width, code, label in plan:
    tr = pcbnew.PCB_TRACK(b)
    tr.SetStart(start)
    tr.SetEnd(end)
    tr.SetLayer(layer)
    tr.SetWidth(width)
    tr.SetNetCode(code)
    b.Add(tr)
    print(f"  stitch {label}: {pcbnew.ToMM(start.x - end.x):+.3f},{pcbnew.ToMM(start.y - end.y):+.3f} mm")

if plan:
    pcbnew.SaveBoard(board_path, b)
print(f"STITCHED {len(plan)}")
