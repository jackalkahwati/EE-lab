"""Import a routed SES session, refill zones, save.

  <kicad-python3> import_ses.py <board.kicad_pcb> <session.ses>

KiCad 10.0.1 standalone swig notes: container accessors break after board
mutation, and the interpreter may segfault at teardown AFTER all work is
done. Zones are captured pre-import, and the caller must treat the
IMPORT_OK sentinel (not the exit code) as success. Track/via stats come
from extract_stats.py in a fresh read-only process.
"""
import json
import os
import sys

import pcbnew

board_path, ses_path = sys.argv[1], sys.argv[2]
b = pcbnew.LoadBoard(board_path)
zones = list(b.Zones())  # pre-mutation capture

ok = pcbnew.ImportSpecctraSES(b, ses_path)
print(f"SES import: {ok}")
if not ok:
    sys.exit(1)

# Phase 16.5: re-add the fine-pitch fanout stubs. ImportSpecctraSES DELETES all
# tracks — including the hand-authored pre-escape stubs connecting fine pads to
# their breakout pads. Restore them from the fanout sidecar (same exact geometry);
# without them the escapes are honestly reported unconnected.
fanout_path = os.path.splitext(board_path)[0] + ".fanout.json"
if os.path.exists(fanout_path):
    fo = json.load(open(fanout_path))
    n_stubs = 0
    for e in fo.get("entries", []) + fo.get("dogbones", []):
        net = b.FindNet(e["net"])
        if net is None:
            continue
        for seg in e.get("segments_mm", []):
            x0, y0, x1, y1 = seg[:4]
            seg_layer = (pcbnew.B_Cu if len(seg) > 4 and seg[4] == "B.Cu"
                         else pcbnew.F_Cu)
            t = pcbnew.PCB_TRACK(b)
            t.SetStart(pcbnew.VECTOR2I(pcbnew.FromMM(x0), pcbnew.FromMM(y0)))
            t.SetEnd(pcbnew.VECTOR2I(pcbnew.FromMM(x1), pcbnew.FromMM(y1)))
            t.SetWidth(pcbnew.FromMM(e.get("width_mm", 0.2)))
            t.SetLayer(seg_layer)
            t.SetNet(net)
            b.Add(t)
            n_stubs += 1
        if e.get("via_mm"):
            v = pcbnew.PCB_VIA(b)
            v.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(e["via_mm"][0]),
                                          pcbnew.FromMM(e["via_mm"][1])))
            v.SetViaType(pcbnew.VIATYPE_THROUGH)
            v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
            v.SetWidth(pcbnew.FromMM(0.4))
            v.SetDrill(pcbnew.FromMM(0.2))
            v.SetNet(net)
            b.Add(v)
            n_stubs += 1
        for vx, vy in e.get("vias_mm", []):
            v = pcbnew.PCB_VIA(b)
            v.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(vx), pcbnew.FromMM(vy)))
            v.SetViaType(pcbnew.VIATYPE_THROUGH)
            v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
            v.SetWidth(pcbnew.FromMM(0.4))
            v.SetDrill(pcbnew.FromMM(0.2))
            v.SetNet(net)
            b.Add(v)
            n_stubs += 1
    print(f"fanout stubs re-added: {n_stubs}")

filler = pcbnew.ZONE_FILLER(b)
filler.Fill(zones)
pcbnew.SaveBoard(board_path, b)
print(f"zone fill: {len(zones)} zones")
print("IMPORT_OK")
