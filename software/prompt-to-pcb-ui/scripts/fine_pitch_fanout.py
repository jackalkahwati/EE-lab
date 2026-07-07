"""Fine-pitch pre-escape fanout (Phase 16.5) — the real fine-grid capability.

The router's grid is DRC-tied ((track+clearance)*1.15 = 0.46mm) so it cannot
resolve ADJACENT escapes on a 0.5mm-pitch package (the proven
blocked_by_grid_resolution result), and the plane stitcher cannot legally drop
even a 0.4mm via inside a 0.5mm pad row.

This pass solves the whole row in EXACT geometry:
  - SIGNAL pads get L-shaped lane escapes: straight out of the pad (0.2mm wide;
    adjacent verticals have 0.3mm gap >= 0.2mm clearance), then a lateral run in
    a private lane (0.95mm lane spacing), fanning off the SIGNAL end of the row
    to breakout pads spaced 1.6mm apart — trivially resolvable by the 0.46mm
    global grid.
  - PLANE pads (GND/+3V3/+5V) get dogbones: straight out to a staggered-depth
    0.4/0.2 via (2.5mm deep when adjacent to a signal escape, alternating
    1.6/2.5mm otherwise) that reaches the inner plane legally.

export_dsn removes the ORIGINAL fine pins from the DSN net lists so flroute
routes from the breakouts; flroute marks the stub wires as net-owned obstacles
(v5 wiring); import_ses re-adds stubs+vias after SES import (which deletes all
tracks); stitch_to_plane skips dogboned pads. KiCad's final DRC + unconnected
check verifies the WHOLE chain end-to-end — a broken or shorted stub fails
honestly. A stub alone never counts as a routed net.

  <kicad-python3> fine_pitch_fanout.py <board.kicad_pcb>     (in-place + sidecar)
"""
import json
import os
import sys

import pcbnew

FP_SHARE = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints"
ZONE_NETS = {"GND", "+3V3", "+5V"}
STUB_W = 0.2        # mm
LANE0 = 1.6         # mm: first lane depth beyond the pad end (clears the package courtyard)
LANE_STEP = 1.2     # mm: lane spacing (with FAN_STEP keeps breakout courtyards apart)
FAN_GAP = 1.5       # mm: first breakout offset beyond the row end (clears the courtyard)
FAN_STEP = 2.4      # mm: breakout spacing (D1.0 TP courtyard ~2.4mm dia)
DOG_SHALLOW = 1.6   # mm: dogbone via depth (shallow)
DOG_DEEP = 2.5      # mm: dogbone via depth (deep — near a signal escape)
FINE_PITCH_MAX = 0.55


def _mm(v):
    return pcbnew.FromMM(v)


def _track(board, net, x0, y0, x1, y1):
    t = pcbnew.PCB_TRACK(board)
    t.SetStart(pcbnew.VECTOR2I(_mm(x0), _mm(y0)))
    t.SetEnd(pcbnew.VECTOR2I(_mm(x1), _mm(y1)))
    t.SetWidth(_mm(STUB_W))
    t.SetLayer(pcbnew.F_Cu)
    t.SetNet(net)
    board.Add(t)


def _via(board, net, x, y):
    v = pcbnew.PCB_VIA(board)
    v.SetPosition(pcbnew.VECTOR2I(_mm(x), _mm(y)))
    v.SetViaType(pcbnew.VIATYPE_THROUGH)
    v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
    v.SetWidth(_mm(0.4))
    v.SetDrill(_mm(0.2))
    v.SetNet(net)
    board.Add(v)


def _breakout_pad(board, ref, x, y, net):
    fp = pcbnew.FootprintLoad(os.path.join(FP_SHARE, "TestPoint.pretty"), "TestPoint_Pad_D1.0mm")
    fp.SetReference(ref)
    fp.SetPosition(pcbnew.VECTOR2I(_mm(x), _mm(y)))
    for p in fp.Pads():
        p.SetNet(net)
    board.Add(fp)


def fanout(board_path):
    """Apply the fanout in place. Returns the signal sidecar entries (may be [])."""
    board = pcbnew.LoadBoard(board_path)
    entries, dogbones = [], []
    fo_n = 0
    for f in board.GetFootprints():
        pads = list(f.Pads())
        if len(pads) < 6:
            continue
        pos = [(p.GetPosition().x / 1e6, p.GetPosition().y / 1e6, p) for p in pads]
        for axis in (1, 0):     # 1: horizontal rows (escape in y), 0: vertical columns
            groups = {}
            for x, y, p in pos:
                key = round((y if axis == 1 else x), 2)
                groups.setdefault(key, []).append((x, y, p))
            along_i = 0 if axis == 1 else 1
            for key, g in groups.items():
                if len(g) < 3:
                    continue
                g.sort(key=lambda t: t[along_i])
                along = [t[along_i] for t in g]
                pitch = min(b2 - a for a, b2 in zip(along, along[1:]))
                if pitch > FINE_PITCH_MAX or pitch <= 0.05:
                    continue
                sig = [t for t in g if t[2].GetNetname() not in ZONE_NETS
                       and t[2].GetNetname() != ""]
                zone = [t for t in g if t[2].GetNetname() in ZONE_NETS]
                if len(sig) < 2:
                    continue
                fc = f.GetPosition()
                fcx, fcy = fc.x / 1e6, fc.y / 1e6
                outward = 1.0 if key > (fcy if axis == 1 else fcx) else -1.0
                pad_len = max(g[0][2].GetSize().x, g[0][2].GetSize().y) / 1e6
                row_out_edge = key + outward * (pad_len / 2.0)
                # the fan lives off the SIGNAL end of the row
                row_cen = sum(along) / len(along)
                sig_cen = sum(t[along_i] for t in sig) / len(sig)
                fan_dir = 1.0 if sig_cen >= row_cen else -1.0
                fan_end = max(along) if fan_dir > 0 else min(along)

                # ---- signal escapes: L-shaped private lanes ------------------
                # nearest-to-fan gets the SHALLOW lane so verticals never cross
                # a deeper pad's lateral run.
                sig_sorted = sorted(sig, key=lambda t: fan_dir * (fan_end - t[along_i]))
                for i, (x, y, p) in enumerate(sig_sorted):
                    lane = row_out_edge + outward * (LANE0 + i * LANE_STEP)
                    target = fan_end + fan_dir * (FAN_GAP + i * FAN_STEP)
                    net = p.GetNet()
                    fo_n += 1
                    ref = "FO%d" % fo_n
                    if axis == 1:
                        segs = [(x, y, x, lane), (x, lane, target, lane)]
                        bo = (target, lane)
                    else:
                        segs = [(x, y, lane, y), (lane, y, lane, target)]
                        bo = (lane, target)
                    for s in segs:
                        _track(board, net, *s)
                    _breakout_pad(board, ref, bo[0], bo[1], net)
                    entries.append({"ref": f.GetReference(), "pad": p.GetPadName(),
                                    "net": p.GetNetname(), "breakout_ref": ref,
                                    "pin_token": "%s-%s" % (f.GetReference(), p.GetPadName()),
                                    "pitch_mm": pitch, "row_escapes": len(sig),
                                    "segments_mm": segs, "width_mm": STUB_W})

                # ---- plane-pad dogbones: staggered-depth 0.4/0.2 vias --------
                sig_pos = [t[along_i] for t in sig]
                last_deep = None
                for (x, y, p) in sorted(zone, key=lambda t: t[along_i]):
                    a = x if axis == 1 else y
                    near_sig = any(abs(a - sp) <= pitch + 0.06 for sp in sig_pos)
                    deep = True if near_sig else (not last_deep)
                    last_deep = deep
                    depth = DOG_DEEP if deep else DOG_SHALLOW
                    vend = row_out_edge + outward * depth
                    net = p.GetNet()
                    if axis == 1:
                        seg = (x, y, x, vend)
                        via_at = (x, vend)
                    else:
                        seg = (x, y, vend, y)
                        via_at = (vend, y)
                    _track(board, net, *seg)
                    _via(board, net, *via_at)
                    dogbones.append({"ref": f.GetReference(), "pad": p.GetPadName(),
                                     "net": p.GetNetname(),
                                     "pin_token": "%s-%s" % (f.GetReference(), p.GetPadName()),
                                     "segments_mm": [seg], "via_mm": list(via_at),
                                     "width_mm": STUB_W})
    if entries or dogbones:
        board.Save(board_path)
        json.dump({"version": "v2", "entries": entries, "dogbones": dogbones},
                  open(os.path.splitext(board_path)[0] + ".fanout.json", "w"), indent=1)
    return entries


if __name__ == "__main__":
    ents = fanout(sys.argv[1])
    print("FANOUT: %d fine-pitch escape(s) fanned out" % len(ents))
    for e in ents:
        print("  %s (%s) -> %s" % (e["pin_token"], e["net"], e["breakout_ref"]))
