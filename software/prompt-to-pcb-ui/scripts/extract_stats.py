"""Extract real board stats from the routed KiCad board into board.json.

Run with KiCad's bundled python (needs pcbnew):
  <kicad-python3> extract_stats.py <board.kicad_pcb> <drc.json> <out board.json>
"""
import json
import re
import sys

import pcbnew

board_path, drc_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

b = pcbnew.LoadBoard(board_path)
fps = list(b.GetFootprints())

# --- nets: only nets with >= 2 pads are routable ----------------------------
net_pads = {}
net_names = {}
for fp in fps:
    for pad in fp.Pads():
        code = pad.GetNetCode()
        if code <= 0:
            continue
        net_pads.setdefault(code, []).append(pad.GetPosition())
        net_names[code] = str(pad.GetNetname())
multi = {c: pts for c, pts in net_pads.items() if len(pts) >= 2}

# --- HPWL (same estimator as placement_score.py) -----------------------------
hpwl = 0.0
for pts in multi.values():
    xs = [p.x for p in pts]
    ys = [p.y for p in pts]
    hpwl += pcbnew.ToMM(max(xs) - min(xs)) + pcbnew.ToMM(max(ys) - min(ys))

# --- unrouted nets from the DRC report (the neutral referee) -----------------
drc = json.load(open(drc_path))
unrouted = set()
for u in drc.get("unconnected_items", []):
    for it in u.get("items", []):
        m = re.search(r"\[(.*?)\]", it.get("description", ""))
        if m:
            unrouted.add(m.group(1))
zone_nets = {str(z.GetNetname()) for z in b.Zones() if z.GetNetCode() > 0}
unrouted_signal = sorted(unrouted - zone_nets)

violations = drc.get("violations", [])
vio_summaries = [
    {"type": v.get("type", "?"), "description": v.get("description", "")}
    for v in violations
]

# --- placement gate: courtyard overlaps + off-board (placement_score logic) --
def cy_bbox(fp):
    try:
        shape = fp.GetCourtyard(pcbnew.F_CrtYd)
        bb = shape.BBox()
        if bb.GetWidth() > 0:
            return bb
    except Exception:
        pass
    return fp.GetBoundingBox(False, False)

boxes = [(fp.GetReference(), cy_bbox(fp)) for fp in fps]
overlap_pairs = []
for i, (ra, ba) in enumerate(boxes):
    for rb, bb2 in boxes[i + 1:]:
        if ba.Intersects(bb2):
            inter = ba.Intersect(bb2)
            if (inter.GetWidth() > pcbnew.FromMM(0.05)
                    and inter.GetHeight() > pcbnew.FromMM(0.05)):
                overlap_pairs.append(f"{ra} ↔ {rb}")

edge_bb = b.GetBoardEdgesBoundingBox()
off_board = [fp.GetReference() for fp in fps
             if not edge_bb.Contains(fp.GetPosition())]

# --- copper inventory ---------------------------------------------------------
tracks = sum(1 for t in b.GetTracks() if t.GetClass() in ("PCB_TRACK", "PCB_ARC"))
vias = sum(1 for t in b.GetTracks() if t.GetClass() == "PCB_VIA")

out = {
    "source": board_path,
    "boardSize": {
        "wMm": round(pcbnew.ToMM(edge_bb.GetWidth()), 2),
        "hMm": round(pcbnew.ToMM(edge_bb.GetHeight()), 2),
    },
    "layers": b.GetCopperLayerCount(),
    "components": len(fps),
    "netsTotal": len(multi),
    "netsRouted": len(multi) - len(unrouted_signal),
    "unroutedNets": unrouted_signal,
    "zoneServedNets": sorted(zone_nets),
    "tracks": tracks,
    "vias": vias,
    "hpwlMm": round(hpwl),
    "placement": {
        "overlaps": len(overlap_pairs),
        "overlapPairs": overlap_pairs[:20],
        "offBoard": off_board,
    },
    "drc": {
        "violations": len(violations),
        "violationSummaries": vio_summaries[:20],
        "unconnectedItems": len(drc.get("unconnected_items", [])),
        "kicadVersion": drc.get("kicad_version", ""),
        "date": drc.get("date", ""),
    },
}

with open(out_path, "w") as f:
    json.dump(out, f, indent=1)
print(f"board.json: {out['netsRouted']}/{out['netsTotal']} nets routed, "
      f"{out['drc']['violations']} DRC violations, "
      f"{out['components']} components, HPWL {out['hpwlMm']} mm")
