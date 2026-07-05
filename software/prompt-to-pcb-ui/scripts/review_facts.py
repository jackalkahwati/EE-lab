"""Extract deterministic review facts from a routed board.

The design-review agent must ground its findings in measurements, not vibes.
This script computes the physical facts a principal EE would check first and
emits them as JSON for the LLM reviewer:

- per-IC decoupling: distance from each U* part to its nearest same-rail cap
- RF nets: length, width, computed Z0 (IPC-2141), GND fence via count
- test-point coverage: which nets have a probe pad, which don't
- copper: track width range, via count, GND stitching density
- board: size, layer count, component count, DRC summary

  <kicad-python3> review_facts.py <board.kicad_pcb> <drc.json> <out.json>

Prints "FACTS_OK" sentinel.
"""
import json
import math
import os
import re
import sys

import pcbnew

board_path, drc_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
b = pcbnew.LoadBoard(board_path)

H_MM, ER, T_MM = 0.2104, 4.4, 0.035
RF_NET = re.compile(r"^(ANT\w*|RF\w*|\w*_RF)$", re.IGNORECASE)


def z0_of(w_mm):
    return 87.0 / math.sqrt(ER + 1.41) * math.log(5.98 * H_MM / (0.8 * w_mm + T_MM))


def mm(v):
    return round(pcbnew.ToMM(v), 3)


fps = list(b.GetFootprints())

# ---- decoupling: each U* to nearest cap pad on the same power rail ----------
POWER = ("+3V3", "+5V", "VCC", "VDD")
caps = []
for fp in fps:
    if fp.GetReference().startswith("C"):
        for pad in fp.Pads():
            if pad.GetNetname() in POWER:
                caps.append((pad.GetNetname(), pad.GetPosition(), fp.GetReference()))

decoupling = []
for fp in fps:
    ref = fp.GetReference()
    if not ref.startswith("U"):
        continue
    rails = {p.GetNetname() for p in fp.Pads() if p.GetNetname() in POWER}
    for rail in sorted(rails):
        pos = fp.GetPosition()
        best = None
        for cnet, cpos, cref in caps:
            if cnet != rail:
                continue
            d = math.hypot(cpos.x - pos.x, cpos.y - pos.y)
            if best is None or d < best[0]:
                best = (d, cref)
        decoupling.append({
            "part": ref,
            "rail": rail,
            "nearest_cap": best[1] if best else None,
            "distance_mm": mm(best[0]) if best else None,
        })

# ---- RF nets -----------------------------------------------------------------
tracks = [t for t in b.GetTracks() if t.GetClass() == "PCB_TRACK"]
vias = [t for t in b.GetTracks() if t.GetClass() == "PCB_VIA"]
gnd_vias = [v for v in vias if v.GetNetname() == "GND"]

rf = []
for name in {t.GetNetname() for t in tracks if RF_NET.match(t.GetNetname() or "")}:
    segs = [t for t in tracks if t.GetNetname() == name]
    total_len = sum(t.GetLength() for t in segs)
    widths = [t.GetWidth() for t in segs]
    fence = 0
    for v in gnd_vias:
        vp = v.GetPosition()
        for s in segs:
            sp, ep = s.GetStart(), s.GetEnd()
            mxp = ((sp.x + ep.x) // 2, (sp.y + ep.y) // 2)
            if min(math.hypot(vp.x - px, vp.y - py)
                   for px, py in ((sp.x, sp.y), mxp, (ep.x, ep.y))) < pcbnew.FromMM(2.0):
                fence += 1
                break
    w_min = mm(min(widths))
    rf.append({
        "net": name,
        "length_mm": mm(total_len),
        "width_min_mm": w_min,
        "width_max_mm": mm(max(widths)),
        "z0_ohms_at_min_width": round(z0_of(w_min), 1),
        "gnd_fence_vias_within_2mm": fence,
    })

# ---- test point coverage ------------------------------------------------------
tp_nets = set()
for fp in fps:
    if re.match(r"^TP\d+$", fp.GetReference()):
        for pad in fp.Pads():
            tp_nets.add(pad.GetNetname())
all_nets = {t.GetNetname() for t in tracks} | {p.GetNetname() for fp in fps for p in fp.Pads()}
all_nets.discard("")
signal_nets = sorted(n for n in all_nets if n not in ("GND",) and not RF_NET.match(n))
uncovered = [n for n in signal_nets if n not in tp_nets]

# ---- copper / board summary ---------------------------------------------------
drc = json.load(open(drc_path)) if os.path.exists(drc_path) else {}
hard = [v for v in drc.get("violations", []) if v.get("type") != "solder_mask_bridge"]
edges = b.GetBoardEdgesBoundingBox()
area_cm2 = pcbnew.ToMM(edges.GetWidth()) * pcbnew.ToMM(edges.GetHeight()) / 100.0

facts = {
    "board": {
        "width_mm": mm(edges.GetWidth()),
        "height_mm": mm(edges.GetHeight()),
        "layers": b.GetCopperLayerCount(),
        "components": len([f for f in fps if not f.GetReference().startswith(("FID", "TP"))]),
        "test_points": len([f for f in fps if re.match(r"^TP\d+$", f.GetReference())]),
    },
    "drc": {
        "rule_violations": len(hard),
        "unconnected_items": len(drc.get("unconnected_items", [])),
    },
    "decoupling": decoupling,
    "rf_nets": rf,
    "test_point_coverage": {
        "nets_with_tp": sorted(tp_nets),
        "signal_nets_without_tp": uncovered,
    },
    "copper": {
        "track_count": len(tracks),
        "track_width_min_mm": mm(min(t.GetWidth() for t in tracks)) if tracks else None,
        "track_width_max_mm": mm(max(t.GetWidth() for t in tracks)) if tracks else None,
        "via_count": len(vias),
        "gnd_via_count": len(gnd_vias),
        "gnd_vias_per_cm2": round(len(gnd_vias) / area_cm2, 2) if area_cm2 else None,
    },
    "stackup_assumption": {"h_mm": H_MM, "er": ER, "t_mm": T_MM,
                           "note": "JLC7628-class 4-layer, outer microstrip over GND plane"},
}

json.dump(facts, open(out_path, "w"), indent=1)
print("FACTS_OK")
