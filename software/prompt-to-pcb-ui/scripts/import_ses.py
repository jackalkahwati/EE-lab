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

# Pre-routed block copper (density program): same restoration as the fanout
# stubs — ImportSpecctraSES wiped it; the .preroute.json sidecar written by
# compose puts it back with exact geometry. flroute skipped these nets, so
# this copper IS their routing.
preroute_path = os.path.splitext(board_path)[0] + ".preroute.json"
if os.path.exists(preroute_path):
    pr = json.load(open(preroute_path))
    n_pre = 0
    for e in pr.get("entries", []):
        net = b.FindNet(e["net"])
        if net is None:
            continue
        for seg in e.get("segments_mm", []):
            x0, y0, x1, y1 = seg[:4]
            lname = seg[4] if len(seg) > 4 else "F.Cu"
            t = pcbnew.PCB_TRACK(b)
            t.SetStart(pcbnew.VECTOR2I(pcbnew.FromMM(x0), pcbnew.FromMM(y0)))
            t.SetEnd(pcbnew.VECTOR2I(pcbnew.FromMM(x1), pcbnew.FromMM(y1)))
            t.SetWidth(pcbnew.FromMM(seg[5] if len(seg) > 5 else e.get("width_mm", 0.25)))
            t.SetLayer(pcbnew.B_Cu if lname == "B.Cu" else pcbnew.F_Cu)
            t.SetNet(net)
            b.Add(t)
            n_pre += 1
        for vx, vy in e.get("vias_mm", []):
            v = pcbnew.PCB_VIA(b)
            v.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(vx), pcbnew.FromMM(vy)))
            v.SetViaType(pcbnew.VIATYPE_THROUGH)
            v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
            v.SetWidth(pcbnew.FromMM(0.4))
            v.SetDrill(pcbnew.FromMM(0.2))
            v.SetNet(net)
            b.Add(v)
            n_pre += 1
    print(f"pre-routed block copper re-added: {n_pre}")

# KiCad 9+ moved board design rules INTO the board file — the .kicad_pro
# sidecar compose writes is no longer read by kicad-cli drc (verified: absurd
# values in the pro change nothing). Apply the sidecar's rules onto the board
# itself so fine-pitch/via classes gate correctly again.
pro_path = os.path.splitext(board_path)[0] + ".kicad_pro"
if os.path.exists(pro_path):
    try:
        rules = (json.load(open(pro_path)).get("board", {})
                 .get("design_settings", {}).get("rules", {}))
        ds = b.GetDesignSettings()
        _map = {
            "min_through_hole_diameter": "m_MinThroughDrill",
            "min_via_diameter": "m_ViasMinSize",
            "min_via_annular_width": "m_ViasMinAnnularWidth",
            "min_hole_clearance": "m_HoleClearance",
            "min_hole_to_hole": "m_HoleToHoleMin",
            "min_clearance": "m_MinClearance",
        }
        applied = 0
        for k, attr in _map.items():
            if k in rules and hasattr(ds, attr):
                setattr(ds, attr, pcbnew.FromMM(float(rules[k])))
                applied += 1
        print(f"board design rules applied from sidecar: {applied}")
    except Exception as e:
        print(f"design-rule sidecar unreadable: {e}")

filler = pcbnew.ZONE_FILLER(b)
filler.Fill(zones)
pcbnew.SaveBoard(board_path, b)
print(f"zone fill: {len(zones)} zones")
print("IMPORT_OK")
