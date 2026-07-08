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
ROW_CLEAR = 16.0    # column signal fans surface beyond the row-fan band
LANE0 = 1.6         # mm: first lane depth beyond the pad end (clears the package courtyard)
LANE_STEP = 1.2     # mm: lane spacing (with FAN_STEP keeps breakout courtyards apart)
FAN_GAP = 1.5       # mm: first breakout offset beyond the row end (clears the courtyard)
FAN_STEP = 2.4      # mm: breakout spacing (D1.0 TP courtyard ~2.4mm dia)
DOG_SHALLOW = 1.6   # mm: dogbone via depth (shallow)
DOG_DEEP = 2.5      # mm: dogbone via depth (deep — near a signal escape)
FINE_PITCH_MAX = 0.7  # 0.5mm TSSOP proven; 0.65mm LGA (BME280 sandbox) showed interior pads wall without fanout


def _mm(v):
    return pcbnew.FromMM(v)


_CUR_W = [STUB_W]


def _track(board, net, x0, y0, x1, y1, layer=None):
    t = pcbnew.PCB_TRACK(board)
    t.SetStart(pcbnew.VECTOR2I(_mm(x0), _mm(y0)))
    t.SetEnd(pcbnew.VECTOR2I(_mm(x1), _mm(y1)))
    t.SetWidth(_mm(_CUR_W[0]))
    t.SetLayer(pcbnew.F_Cu if layer is None else layer)
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


def _breakout_pad(board, ref, x, y, net, dia=None):
    fp = pcbnew.FootprintLoad(os.path.join(FP_SHARE, "TestPoint.pretty"), "TestPoint_Pad_D1.0mm")
    fp.SetReference(ref)
    fp.SetPosition(pcbnew.VECTOR2I(_mm(x), _mm(y)))
    for p in fp.Pads():
        p.SetNet(net)
        if dia is not None:
            # QFN 0.6mm ladder: 1.0mm pads touch adjacent laterals; 0.6mm
            # pads keep the exact 0.2mm clearance
            p.SetSize(pcbnew.VECTOR2I(_mm(dia), _mm(dia)))
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
        # M2: count wired signals per column so QFN row fans can point AWAY
        # from the column whose B-corridor band they must not invade
        fcx0 = f.GetPosition().x / 1e6
        left_sig = sum(1 for (px, py, p) in pos
                       if px < fcx0 and p.GetNetname()
                       and p.GetNetname() not in ZONE_NETS
                       and abs(px - fcx0) > abs(py - f.GetPosition().y / 1e6))
        right_sig = sum(1 for (px, py, p) in pos
                        if px > fcx0 and p.GetNetname()
                        and p.GetNetname() not in ZONE_NETS
                        and abs(px - fcx0) > abs(py - f.GetPosition().y / 1e6))
        occupied = []  # 23.5: fan targets already claimed by ANY axis/row of
        #                this footprint — corner cells of a 4-sided QFN would
        #                otherwise collide between the row fans and column fans
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
                # 0.2 stubs at 0.4 pitch leave exactly-0.2mm gaps —
                # the clearance rule is >=, and the board min track width is
                # 0.2 (0.15 stubs drew 32 track_width violations)
                _CUR_W[0] = STUB_W
                sig = [t for t in g if t[2].GetNetname() not in ZONE_NETS
                       and t[2].GetNetname() != ""]
                zone = [t for t in g if t[2].GetNetname() in ZONE_NETS]
                # 23.5: a QFN side may carry ONLY plane pins (all its GPIOs
                # unwired) — zone dogbones must still run; only the signal
                # LANE pass needs 2+ signals.
                if len(sig) < 2 and not zone:
                    continue
                fc = f.GetPosition()
                fcx, fcy = fc.x / 1e6, fc.y / 1e6
                outward = 1.0 if key > (fcy if axis == 1 else fcx) else -1.0
                pad_len = max(g[0][2].GetSize().x, g[0][2].GetSize().y) / 1e6
                row_out_edge = key + outward * (pad_len / 2.0)
                # the fan lives off the SIGNAL end of the row
                row_cen = sum(along) / len(along)
                if sig:
                    sig_cen = sum(t[along_i] for t in sig) / len(sig)
                else:
                    sig_cen = row_cen  # zone-only row: no signal fan exists
                fan_dir = 1.0 if sig_cen >= row_cen else -1.0
                if pitch < 0.45 and axis == 1 and (left_sig or right_sig):
                    # rows: fan away from the heavier column corridor band
                    fan_dir = 1.0 if left_sig >= right_sig else -1.0
                if pitch < 0.45 and axis == 0:
                    # columns: dive corridors fan toward the side with board
                    # room (an upward fan walked TRIG/FAULT off the top edge)
                    bb = board.GetBoardEdgesBoundingBox()
                    room_dn = bb.GetBottom() / 1e6 - max(along)
                    room_up = min(along) - bb.GetTop() / 1e6
                    fan_dir = 1.0 if room_dn >= room_up else -1.0
                fan_end = max(along) if fan_dir > 0 else min(along)

                # ---- signal escapes: L-shaped private lanes ------------------
                # nearest-to-fan gets the SHALLOW lane so verticals never cross
                # a deeper pad's lateral run.
                # 23.5 QFN class (<0.45mm pitch): zone pins ride the SAME lane
                # system, terminating in a plane via at the fan target — the
                # outward dogbone depths interleave with lane laterals and
                # collide (the six RP_DVDD/XIN-vs-via clearance hits).
                qfn_mode = pitch < 0.45
                esc = list(sig) + (list(zone) if qfn_mode else [])
                sig_sorted = (sorted(esc, key=lambda t: fan_dir * (fan_end - t[along_i]))
                              if len(esc) >= 2 or (qfn_mode and esc) else [])
                for i, (x, y, p) in enumerate(sig_sorted):
                    # QFN rows can carry 13+ lanes — 0.6mm step (0.4mm gap
                    # between 0.2 laterals) keeps the deepest lane inside the
                    # board margin
                    _step = 0.6 if pitch < 0.45 else LANE_STEP
                    lane = row_out_edge + outward * (LANE0 + i * _step)
                    # QFN rows: start fan targets BEYOND the adjacent column's
                    # B-corridor band so row plane-vias never sit in a
                    # corridor (the INTERLOCK-x-3V3-via signature)
                    _gap = 14.0 if (pitch < 0.45 and axis == 1
                                    and (left_sig or right_sig)) else FAN_GAP
                    target = fan_end + fan_dir * (_gap + i * FAN_STEP)
                    # dedup against every fan cell this footprint already owns
                    def _bo_of(tg):
                        return (tg, lane) if axis == 1 else (lane, tg)
                    guard = 0
                    while any((_bo_of(target)[0] - ox) ** 2 +
                              (_bo_of(target)[1] - oy) ** 2 < 1.5 ** 2
                              for ox, oy in occupied) and guard < 20:
                        target += fan_dir * FAN_STEP
                        guard += 1
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
                    if qfn_mode and axis == 0:
                        # M2: COLUMN SIGNAL — its vertical lane run would
                        # cross the row fans' laterals on F (the Gate A DRC
                        # signature: I2C/UART/GPIO x XIN/SWD crossings). Keep
                        # the proven F ladder only to just past the column
                        # end, dive to B.Cu through the row band, surface
                        # beyond it at an extended target.
                        y_split = fan_end + fan_dir * 1.0
                        far = fan_end + fan_dir * (ROW_CLEAR + i * FAN_STEP)
                        seg_f1 = (x, y, lane, y)
                        seg_f2 = (lane, y, lane, y_split)
                        seg_b = (lane, y_split, lane, far)
                        pad_at = (lane, far + fan_dir * 1.4)
                        _track(board, net, *seg_f1)
                        _track(board, net, *seg_f2)
                        _via(board, net, lane, y_split)
                        _track(board, net, *seg_b, layer=pcbnew.B_Cu)
                        _via(board, net, lane, far)
                        if p.GetNetname() in ZONE_NETS:
                            # plane pin: the far via IS the plane connection —
                            # an in-band zone via always collides with an
                            # adjacent wired signal's stub at 0.4mm pitch
                            # (the RST_OUT x IOVDD-via signature)
                            occupied.append((lane, far))
                            dogbones.append({"ref": f.GetReference(),
                                             "pad": p.GetPadName(),
                                             "net": p.GetNetname(),
                                             "pin_token": "%s-%s" % (
                                                 f.GetReference(),
                                                 p.GetPadName()),
                                             "segments_mm": [
                                                 list(seg_f1) + ["F.Cu"],
                                                 list(seg_f2) + ["F.Cu"],
                                                 list(seg_b) + ["B.Cu"]],
                                             "vias_mm": [[lane, y_split],
                                                         [lane, far]],
                                             "width_mm": _CUR_W[0]})
                            continue
                        _track(board, net, lane, far, pad_at[0], pad_at[1])
                        fo_n += 1
                        ref = "FO%d" % fo_n
                        _breakout_pad(board, ref, pad_at[0], pad_at[1], net)
                        occupied.append(pad_at)
                        entries.append({"ref": f.GetReference(),
                                        "pad": p.GetPadName(),
                                        "net": p.GetNetname(),
                                        "breakout_ref": ref,
                                        "pin_token": "%s-%s" % (
                                            f.GetReference(), p.GetPadName()),
                                        "pitch_mm": pitch,
                                        "row_escapes": len(sig),
                                        "segments_mm": [
                                            list(seg_f1) + ["F.Cu"],
                                            list(seg_f2) + ["F.Cu"],
                                            list(seg_b) + ["B.Cu"],
                                            [lane, far, pad_at[0], pad_at[1],
                                             "F.Cu"]],
                                        "vias_mm": [[lane, y_split],
                                                    [lane, far]],
                                        "width_mm": _CUR_W[0],
                                        "layer_dive": "B.Cu through row band"})
                        continue
                    if False and qfn_mode and p.GetNetname() in ZONE_NETS and axis == 0:
                        # COLUMN plane pin (QFN left/right): no vertical lane
                        # run — it would cross the row fans' laterals in the
                        # corner box. Stub straight out to the lane depth and
                        # via there. Safe because QFN-56 column plane pins are
                        # never adjacent (IOVDD pads sit 9 positions apart).
                        seg1 = segs[0]
                        _track(board, net, *seg1)
                        via_at = (seg1[2], seg1[3])
                        _via(board, net, *via_at)
                        occupied.append(via_at)
                        dogbones.append({"ref": f.GetReference(),
                                         "pad": p.GetPadName(),
                                         "net": p.GetNetname(),
                                         "pin_token": "%s-%s" % (
                                             f.GetReference(), p.GetPadName()),
                                         "segments_mm": [seg1],
                                         "via_mm": list(via_at),
                                         "width_mm": _CUR_W[0]})
                        continue
                    occupied.append(bo)
                    if qfn_mode and p.GetNetname() in ZONE_NETS:
                        # plane pin: via at the fan target reaches the plane
                        _via(board, net, bo[0], bo[1])
                        dogbones.append({"ref": f.GetReference(),
                                         "pad": p.GetPadName(),
                                         "net": p.GetNetname(),
                                         "pin_token": "%s-%s" % (
                                             f.GetReference(), p.GetPadName()),
                                         "segments_mm": segs,
                                         "via_mm": [bo[0], bo[1]],
                                         "width_mm": _CUR_W[0]})
                        continue
                    _breakout_pad(board, ref, bo[0], bo[1], net,
                                  dia=0.6 if qfn_mode else None)
                    entries.append({"ref": f.GetReference(), "pad": p.GetPadName(),
                                    "net": p.GetNetname(), "breakout_ref": ref,
                                    "pin_token": "%s-%s" % (f.GetReference(), p.GetPadName()),
                                    "pitch_mm": pitch, "row_escapes": len(sig),
                                    "segments_mm": segs, "width_mm": _CUR_W[0]})

                # ---- plane-pad dogbones: staggered-depth 0.4/0.2 vias --------
                if qfn_mode:
                    zone = []  # already escaped through the lane system
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
