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
# stitchable PLANES only — +5V has no plane on this stackup; a +5V "zone"
# dogbone creates an orphan via and strips the pin from routing (the TXB0102
# VCCB signature). +5V escapes like a signal and flroute routes it.
ZONE_NETS = {"GND", "+3V3"}
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
    global ZONE_NETS
    board = pcbnew.LoadBoard(board_path)
    # the stitchable planes are whatever zones THIS board actually carries —
    # a SoM carrier swaps the In2 plane to +5V, and dogboning into a plane
    # that does not exist strands the pin (the TXB0102 VCCB signature)
    board_zones = {str(z.GetNetname()) for z in board.Zones() if z.GetNetCode() > 0}
    if board_zones:
        ZONE_NETS = board_zones
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
        done_channels = set()  # connector channels already solved (row pairs)
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

                # ---- connector-field mode (SoM carriers, DF40-class) --------
                # A 50-pad 0.4mm row is NOT a QFN side: the lane/fan system
                # scales per-pad and drew 2.6 METERS of copper across the CM4
                # field. A board-to-board connector always has a sibling row
                # ~3mm away — every wired pad dives into the inter-row CHANNEL
                # (stub -> via placed by a greedy clearance-checked search;
                # BOTH rows share the channel so they are solved together).
                # Plane pads end at their channel via (the via IS the plane
                # connection; consecutive same-net pads merge onto one bus
                # with fewer, fatter-spaced vias); signals continue on B.Cu
                # out the row's outer side — crossing SMD pad rows is legal
                # on B.Cu — and surface at a breakout pad the router reaches.
                if len(g) > 20 and pitch <= 0.45:
                    sibs = [k2 for k2, g2 in groups.items()
                            if k2 != key and len(g2) > 20
                            and 1.0 < abs(k2 - key) < 6.0]
                    conn_sib = min(sibs, key=lambda k2: abs(k2 - key)) if sibs else None
                else:
                    conn_sib = None
                if conn_sib is not None:
                    ck = (axis,) + tuple(sorted((key, conn_sib)))
                    if ck in done_channels:
                        continue
                    done_channels.add(ck)
                    mid = (key + conn_sib) / 2.0
                    pad_len = max(g[0][2].GetSize().x, g[0][2].GetSize().y) / 1e6

                    def _pt(a, c):
                        # (along, cross) -> board (x, y)
                        return (a, c) if axis == 1 else (c, a)

                    def _dps(p, a, b):
                        px, py = p
                        ax, ay = a
                        bx, by = b
                        dx, dy = bx - ax, by - ay
                        l2 = dx * dx + dy * dy
                        t = 0.0 if l2 == 0 else max(0.0, min(1.0, (
                            (px - ax) * dx + (py - ay) * dy) / l2))
                        cx, cy = ax + t * dx, ay + t * dy
                        return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5

                    def _dss(s1, s2):
                        # min distance between segments (0 if they cross)
                        (a, b), (c, dd) = s1, s2
                        def _o(p, q, r):
                            v = (q[0] - p[0]) * (r[1] - p[1]) - \
                                (q[1] - p[1]) * (r[0] - p[0])
                            return 0 if abs(v) < 1e-12 else (1 if v > 0 else -1)
                        if (_o(a, b, c) != _o(a, b, dd)
                                and _o(c, dd, a) != _o(c, dd, b)):
                            return 0.0
                        return min(_dps(a, c, dd), _dps(b, c, dd),
                                   _dps(c, a, b), _dps(dd, a, b))

                    rows_c = [(key, g), (conn_sib, groups[conn_sib])]
                    ch_vias, ch_segs, entry_pts = [], [], []
                    b_exits, b_lines = [], []
                    row_meta = []
                    for rk, rg in rows_c:
                        r_inw = 1.0 if mid > rk else -1.0
                        r_wired = sorted((t for t in rg if t[2].GetNetname()),
                                         key=lambda t: t[along_i])
                        r_entry = rk + r_inw * (pad_len / 2.0 + 0.15)
                        for t in r_wired:
                            entry_pts.append((t[along_i], r_entry))
                        row_meta.append((rk, r_inw, r_wired, r_entry))

                    def _find_via(a0, r_inw, own_pts, rk,
                                  allow_deep=False, b_check=False,
                                  debug=False):
                        """clearance-checked channel via near along=a0.
                        0.6 via-via, 0.5 via-copper, 0.4 track-track; the
                        pad-end lines of both rows are quasi-continuous
                        copper walls (0.4mm pitch) the via must respect.
                        Single pads may enter the channel DEEPER before the
                        diagonal (allow_deep) — the straight prefix hugs the
                        own lane, buying diagonal room past crowded entries.
                        Returns (va, vc, [segments to draw])."""
                        own_end = rk + r_inw * (pad_len / 2.0)
                        opp_end = (2.0 * mid - rk) - r_inw * (pad_len / 2.0)
                        e_opts = (0.15, 0.55) if allow_deep else (0.15,)
                        for e_d in e_opts:
                            entry_c = rk + r_inw * (pad_len / 2.0 + e_d)
                            prefix = ((a0, own_end), (a0, entry_c))
                            if e_d > 0.2:
                                if any(_dps((x, y), *prefix) < 0.4999
                                       for x, y in ch_vias):
                                    continue
                                if any(_dss(prefix, s) < 0.3999 for s in ch_segs):
                                    continue
                            for ox in (0.0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9,
                                       1.2, -1.2):
                                for d in (0.25, 0.5, 0.74, -0.2, -0.4, -0.6):
                                    va, vc = a0 + ox, mid - r_inw * d
                                    why = None
                                    # wall rule: directly over the own pad the
                                    # nearest FOREIGN pad is a full pitch away
                                    own_wall = 0.3 if abs(ox) < 0.05 else 0.5
                                    diag = ((a0, entry_c), (va, vc))
                                    if abs(vc - own_end) < own_wall:
                                        why = "own-wall"
                                    elif abs(vc - opp_end) < 0.5:
                                        why = "opp-wall"
                                    elif any((va - x) ** 2 + (vc - y) ** 2
                                             < 0.3599 for x, y in ch_vias):
                                        why = "via-via"
                                    elif any(_dps((va, vc), s[0], s[1]) < 0.4999
                                             for s in ch_segs):
                                        why = "via-seg"
                                    elif any((va - x) ** 2 + (vc - y) ** 2
                                             < 0.2499 for x, y in entry_pts
                                             if (x, y) not in own_pts):
                                        why = "via-entry"
                                    elif any(_dps((x, y), *diag) < 0.4999
                                             for x, y in ch_vias):
                                        why = "diag-via"
                                    elif any(_dss(diag, s) < 0.3999
                                             for s in ch_segs):
                                        why = "diag-seg"
                                    elif any(_dps(p, *diag) < 0.3999
                                             for p in entry_pts
                                             if p not in own_pts):
                                        why = "diag-entry"
                                    # every channel via is a THROUGH barrel:
                                    # it must clear the B.Cu exit runs too,
                                    # and a signal's own future B run (b1,
                                    # straight out at va) must clear placed
                                    # barrels
                                    elif any(_dps((va, vc), s[0], s[1]) < 0.4999
                                             for s in b_lines):
                                        why = "via-brun"
                                    elif b_check and (
                                        any(_dps((x, y), (va, vc),
                                                 (va, rk - r_inw *
                                                  (pad_len / 2.0 + 0.6)))
                                            < 0.4999 for x, y in ch_vias)
                                        or any(_dss(((va, vc),
                                                     (va, rk - r_inw *
                                                      (pad_len / 2.0 + 0.6))),
                                                    s) < 0.4
                                               for s in b_lines)):
                                        why = "b1-blocked"
                                    if why is None:
                                        return va, vc, [prefix, diag]
                                    if debug:
                                        print("  cand e=%.2f ox=%.1f d=%.2f"
                                              " -> %s" % (e_d, ox, d, why))
                        return None

                    # collect runs (consecutive same-net pads merge) from
                    # BOTH rows, then place SIGNALS FIRST: their channel
                    # corridors + B exits are the scarce resource; a zone pad
                    # placed first can wall off the only path (GND 53 walled
                    # CM4_TX 55 in run-4), while zone pads have an outward
                    # fallback signals do not.
                    runs_all = []
                    for rk, r_inw, r_wired, r_entry in row_meta:
                        runs = []
                        for t in r_wired:
                            if (runs and runs[-1][-1][2].GetNetname() ==
                                    t[2].GetNetname()
                                    and abs(t[along_i] - runs[-1][-1][along_i])
                                    <= pitch + 0.05):
                                runs[-1].append(t)
                            else:
                                runs.append([t])
                        for run in runs:
                            runs_all.append((rk, r_inw, r_entry, run))
                    sig_i_row = {}
                    o_vias = []  # outward fallback dogbone vias
                    for rk, r_inw, r_entry, run in sorted(
                            runs_all,
                            key=lambda r: r[3][0][2].GetNetname() in ZONE_NETS):
                        p0 = run[0][2]
                        net, nname = p0.GetNet(), p0.GetNetname()
                        is_zone = nname in ZONE_NETS
                        alongs = [t[along_i] for t in run]
                        own_pts = {(a, r_entry) for a in alongs}
                        if not is_zone:
                            # SIGNAL: pure-F.Cu OUTWARD escape. The outward
                            # side of a board-to-board connector row is open
                            # field on this class of footprint (module
                            # interior or just past the module edge) — no
                            # via, no channel contention: straight stub past
                            # the row, then a candidate-checked diverging jog
                            # to a breakout pad. Signals go before zone pads,
                            # so only sibling escapes live out here.
                            a0 = alongs[0]
                            out0 = rk - r_inw * (pad_len / 2.0 + 0.95)
                            f1s = [((a, rk), (a, out0)) for a in alongs]
                            if len(alongs) > 1:
                                f1s.append(((min(alongs), out0),
                                            (max(alongs), out0)))
                            bad = any(
                                any(_dss(s, s2) < 0.3999 for s2 in b_lines)
                                or any(_dps(p, *s) < 0.7999 for p in b_exits)
                                for s in f1s)
                            if bad and os.environ.get("FL_FANOUT_DEBUG"):
                                for s in f1s:
                                    for s2 in b_lines:
                                        if _dss(s, s2) < 0.4:
                                            print("  f1 %r hits line %r"
                                                  % (s, s2))
                                    for p in b_exits:
                                        if _dps(p, *s) < 0.8:
                                            print("  f1 %r hits exit %r"
                                                  % (s, p))
                            sig_i = sig_i_row.get(rk, 0)
                            base = 1.0 if sig_i % 2 else -1.0
                            pick = None
                            if not bad:
                                for dep in (0.9, 2.5, 4.1):
                                    for j in (base, -base, 2 * base,
                                              -2 * base):
                                        ept = (a0 + j,
                                               out0 - r_inw * dep)
                                        f2 = ((a0, out0), ept)
                                        if any((ept[0] - x) ** 2 +
                                               (ept[1] - y) ** 2 < 1.9599
                                               for x, y in b_exits):
                                            continue
                                        if any(_dps(ept, *s) < 0.7999
                                               for s in b_lines):
                                            continue
                                        if any(_dss(f2, s) < 0.3999
                                               for s in b_lines):
                                            continue
                                        if any(_dps(p, *f2) < 0.7999
                                               for p in b_exits):
                                            continue
                                        pick = (ept, f2)
                                        break
                                    if pick:
                                        break
                            if not pick:
                                print("FANOUT: connector escape field FULL "
                                      "at %s (%s) — pad left for the router"
                                      % (p0.GetPadName(), nname))
                                if os.environ.get("FL_FANOUT_DEBUG"):
                                    print("  f1-bad=%r out0=%.2f" % (bad, out0))
                                    for dep in (0.9, 2.5, 4.1):
                                        for j in (base, -base, 2 * base,
                                                  -2 * base):
                                            ept = (a0 + j, out0 - r_inw * dep)
                                            f2 = ((a0, out0), ept)
                                            why = "ok?"
                                            if any((ept[0] - x) ** 2 +
                                                   (ept[1] - y) ** 2 < 1.9599
                                                   for x, y in b_exits):
                                                why = "ept-exit"
                                            elif any(_dps(ept, *s) < 0.7999
                                                     for s in b_lines):
                                                why = "ept-line"
                                            elif any(_dss(f2, s) < 0.3999
                                                     for s in b_lines):
                                                why = "f2-line"
                                            elif any(_dps(p, *f2) < 0.7999
                                                     for p in b_exits):
                                                why = "f2-exit"
                                            print("  j=%.0f dep=%.1f -> %s"
                                                  % (j, dep, why))
                                continue
                            sig_i_row[rk] = sig_i + 1
                            ept, f2 = pick
                            all_f = f1s + [f2]
                            for s in all_f:
                                (x0, y0), (x1, y1) = _pt(*s[0]), _pt(*s[1])
                                _track(board, net, x0, y0, x1, y1)
                            ex, ey = _pt(*ept)
                            fo_n += 1
                            ref = "FO%d" % fo_n
                            _breakout_pad(board, ref, ex, ey, net)
                            b_lines.extend(all_f)
                            b_exits.append(ept)
                            occupied.append((ex, ey))
                            segs_mm = [list(_pt(*s[0]) + _pt(*s[1]))
                                       + ["F.Cu"] for s in all_f]
                            for i, t in enumerate(run):
                                entries.append({
                                    "ref": f.GetReference(),
                                    "pad": t[2].GetPadName(), "net": nname,
                                    "breakout_ref": ref,
                                    "pin_token": "%s-%s" % (
                                        f.GetReference(), t[2].GetPadName()),
                                    "pitch_mm": pitch,
                                    "row_escapes": len(run),
                                    "segments_mm": segs_mm if i == 0 else [],
                                    "vias_mm": [],
                                    "width_mm": _CUR_W[0]})
                            continue
                        segs_f = [((a, rk), (a, r_entry)) for a in alongs]
                        if len(alongs) > 1:
                            segs_f.append(((min(alongs), r_entry),
                                           (max(alongs), r_entry)))
                        # vias: 1 for singles/pairs, ~1 per 2 pads for
                        # power runs (a lone 0.2mm-drill via is no way
                        # to feed a SoM's supply pins)
                        n_via = 1 if len(run) < 3 else (len(run) + 1) // 2
                        anchors = [alongs[int(i * (len(alongs) - 1) /
                                              max(1, n_via - 1))]
                                   for i in range(n_via)] if n_via > 1 \
                            else [alongs[len(alongs) // 2]]
                        got, extra_segs = [], []
                        for a0 in anchors:
                            r = _find_via(a0, r_inw, own_pts, rk,
                                          allow_deep=len(run) == 1,
                                          b_check=not is_zone)
                            if r:
                                got.append((r[0], r[1]))
                                extra_segs.extend(r[2])
                                ch_vias.append((r[0], r[1]))
                                ch_segs.extend(r[2])
                        if not got and is_zone and len(run) == 1:
                            # OUTWARD fallback: a plane pad may dogbone away
                            # from the channel instead — its own lane is
                            # always clear on F.Cu; only the B exits and
                            # earlier fallbacks live out there.
                            a0 = alongs[0]
                            for dd in (0.7, 1.3, 1.9, 2.5):
                                oc = rk - r_inw * (pad_len / 2.0 + dd)
                                opt = (a0, oc)
                                if any((opt[0] - x) ** 2 + (opt[1] - y) ** 2
                                       < 0.8099 for x, y in b_exits):
                                    continue
                                if any((opt[0] - x) ** 2 + (opt[1] - y) ** 2
                                       < 0.3599 for x, y in o_vias):
                                    continue
                                # the field also carries the signals' escape
                                # copper and breakout pads — clear them
                                if any(_dps(opt, s[0], s[1]) < 0.4999
                                       for s in b_lines):
                                    continue
                                stub_o = ((a0, rk), opt)
                                if any(_dps(p, *stub_o) < 0.7999
                                       for p in b_exits):
                                    continue
                                if any(_dss(stub_o, s) < 0.3999
                                       for s in b_lines):
                                    continue
                                (x0, y0), (x1, y1) = _pt(*stub_o[0]), _pt(*stub_o[1])
                                _track(board, net, x0, y0, x1, y1)
                                vx, vy = _pt(*opt)
                                _via(board, net, vx, vy)
                                o_vias.append(opt)
                                dogbones.append({
                                    "ref": f.GetReference(),
                                    "pad": p0.GetPadName(), "net": nname,
                                    "pin_token": "%s-%s" % (
                                        f.GetReference(), p0.GetPadName()),
                                    "segments_mm": [[x0, y0, x1, y1, "F.Cu"]],
                                    "vias_mm": [[vx, vy]],
                                    "width_mm": _CUR_W[0]})
                                got = None  # handled
                                break
                            if got is None:
                                continue
                        if not got:
                            print("FANOUT: connector channel FULL at "
                                  "%s (%s) — pad left for the router"
                                  % (p0.GetPadName(), nname))
                            if os.environ.get("FL_FANOUT_DEBUG"):
                                _find_via(anchors[0], r_inw, own_pts, rk,
                                          allow_deep=len(run) == 1,
                                          debug=True)
                            continue
                        ch_segs.extend(segs_f)
                        all_f = segs_f + extra_segs
                        for s in all_f:
                            (x0, y0), (x1, y1) = _pt(*s[0]), _pt(*s[1])
                            _track(board, net, x0, y0, x1, y1)
                        for va, vc in got:
                            vx, vy = _pt(va, vc)
                            _via(board, net, vx, vy)
                        segs_mm = [list(_pt(*s[0]) + _pt(*s[1])) + ["F.Cu"]
                                   for s in all_f]
                        vias_mm = [list(_pt(va, vc)) for va, vc in got]
                        if is_zone:
                            for i, t in enumerate(run):
                                dogbones.append({
                                    "ref": f.GetReference(),
                                    "pad": t[2].GetPadName(), "net": nname,
                                    "pin_token": "%s-%s" % (
                                        f.GetReference(), t[2].GetPadName()),
                                    "segments_mm": segs_mm if i == 0 else [],
                                    "vias_mm": vias_mm if i == 0 else [],
                                    "width_mm": _CUR_W[0]})
                            continue
                    continue
                sig = [t for t in g if t[2].GetNetname() not in ZONE_NETS
                       and t[2].GetNetname() != ""]
                zone = [t for t in g if t[2].GetNetname() in ZONE_NETS]
                # 23.5: a QFN side may carry ONLY plane pins (all its GPIOs
                # unwired) — zone dogbones must still run. M3A harness catch:
                # a SINGLE wired signal on a fine-pitch row also needs its
                # ladder (the router cannot do 0.4mm work directly; fixture
                # qfn_corner_escape_simple showed a 0.175mm clearance hit).
                if not sig and not zone:
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
                # zone pins ride the lanes whenever the row ALSO carries
                # signals — an outward dogbone between a signal and its fan
                # is crossed by the signal's lateral at ANY pitch (the SoM
                # board's +3V3-as-signal x GND-dogbone crossing at 0.65mm)
                ride_zone = qfn_mode or (bool(sig) and bool(zone))
                esc = list(sig) + (list(zone) if ride_zone else [])
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
                    if ride_zone and p.GetNetname() in ZONE_NETS:
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
                if ride_zone:
                    zone = []  # already escaped through the lane system
                sig_pos = [t[along_i] for t in sig]
                last_deep = None
                for (x, y, p) in sorted(zone, key=lambda t: t[along_i]):
                    a = x if axis == 1 else y
                    near_sig = any(abs(a - sp) <= pitch + 0.06 for sp in sig_pos)
                    deep = True if near_sig else (not last_deep)
                    last_deep = deep
                    if sig:
                        # a signal's lane LATERAL crosses every dogbone x in
                        # the row at depths 1.6+1.2k — near_sig only guarded
                        # the one-pitch neighbor (the +3V3-as-signal SoM board
                        # shorted a GND via at 1.6 under a +3V3 lateral).
                        # With signals present, vias sit at lane MIDPOINTS.
                        depth = (LANE0 + LANE_STEP / 2.0) + \
                            (LANE_STEP if deep else 0.0)
                    else:
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
