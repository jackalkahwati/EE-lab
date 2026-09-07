#!/usr/bin/env python3
"""DRC-driven local repair of a routed, poured board — with KiCad's own geometry.

Usage: <kicad-python> drc_closure.py <in.kicad_pcb> <out.kicad_pcb> <drc.json> <clearance_mm> <hole_clearance_mm>

Input is the board that ships plus kicad-cli's DRC report for it. For each
clearance / hole_clearance violation the script tries the most local repair
that KiCad's SHAPE.Collide test (the DRC clearance test itself) accepts:

  1. a generated GND stub (a GND track from a ground pad to a stitch via or into
     the pour): delete it and re-place the pad's dog-bone with the clearance-
     checked search; a pad with no legal spot is left for the targeted retry;
  2. a via: move it within a small spiral to a spot whose drill clears other
     copper by the hole rule and whose ring clears by the clearance rule, then
     re-point every track end that sat on the via and re-check those too;
  3. a track segment against a pad/track/via: jog the middle of the segment
     away from the other item by the missing distance, as three segments, each
     checked.

Nothing is deleted without a replacement that checks clean, no repair is
committed if its own pieces collide, and the caller re-runs real DRC and keeps
the result only if the error count fell and connectivity did not. Prints one
JSON line: {"attempted","fixed":{...},"unfixed":[...]}.
"""
import json
import math
import os
import re
import sys

import pcbnew

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kicad_geom import CopperIndex, seg_shape, circle_shape, spiral  # noqa: E402

inp, outp, drcf = sys.argv[1], sys.argv[2], sys.argv[3]
CLEARANCE = pcbnew.FromMM(float(sys.argv[4]) if len(sys.argv) > 4 else 0.09)
HOLE_CLEARANCE = pcbnew.FromMM(float(sys.argv[5]) if len(sys.argv) > 5 else 0.35)
MARGIN = pcbnew.FromMM(0.01)   # land a hair past the rule, never on it
VIA_R_MAX = pcbnew.FromMM(0.6)
VIA_STEP = pcbnew.FromMM(0.025)

board = pcbnew.LoadBoard(inp)
# hole-to-hole: the board's own rule (KiCad grades holes against it), never a
# stricter private constant — that rejected every spot for a via that only had
# to gain 0.03mm of copper clearance
try:
    HOLE_GAP = max(int(board.GetDesignSettings().m_HoleToHoleMin), pcbnew.FromMM(0.25))
except Exception:
    HOLE_GAP = pcbnew.FromMM(0.25)
rep = json.load(open(drcf))
gnd = board.FindNet("GND")
GND_CODE = gnd.GetNetCode() if gnd else -1

# uuid -> item
by_id = {}
for t in board.GetTracks():
    by_id[t.m_Uuid.AsString()] = t
for fp in board.GetFootprints():
    for p in fp.Pads():
        by_id[p.m_Uuid.AsString()] = p


def item_index(net_code):
    """Other-net copper as seen from `net_code`'s point of view."""
    return CopperIndex(board, net_code)


def via_width(via):
    try:
        return via.GetWidth(pcbnew.F_Cu)
    except TypeError:
        return via.GetWidth()


def tracks_at(pos, net_code, radius=0, exclude=None):
    """Same-net tracks whose start or end sits on `pos` — within `radius`, because
    a track end lands anywhere inside the via's copper, not only at its centre
    (an exact match re-pointed two ends and stranded two others)."""
    out = []
    r2 = radius * radius
    for t in board.GetTracks():
        if isinstance(t, pcbnew.PCB_VIA) or t.GetNetCode() != net_code or t is exclude:
            continue
        for end in (t.GetStart(), t.GetEnd()):
            dx, dy = end.x - pos.x, end.y - pos.y
            if dx * dx + dy * dy <= r2:
                out.append((t, end == t.GetStart()))
                break
    return out


DEBUG = bool(os.environ.get("FL_CLOSURE_DEBUG"))


def seg_ok(idx, a, b, width, layer, exclude=()):
    """A track segment: clearance to other copper AND hole_clearance to other drills."""
    return idx.clear(seg_shape(a, b, width), layer, CLEARANCE + MARGIN, exclude,
                     hole_clearance=HOLE_CLEARANCE + MARGIN)


# ---- 1. generated GND stubs --------------------------------------------------
def gnd_pad_at(pos):
    for fp in board.GetFootprints():
        for p in fp.Pads():
            if p.GetNetCode() == GND_CODE and p.GetPosition() == pos:
                return p
    return None


def fix_gnd_stub(track):
    """Delete the offending stub and re-place the pad's dog-bone clean."""
    pad = gnd_pad_at(track.GetStart()) or gnd_pad_at(track.GetEnd())
    if pad is None:
        return False
    pos = pcbnew.VECTOR2I(pad.GetPosition())
    other = pcbnew.VECTOR2I(track.GetEnd() if track.GetStart() == pos else track.GetStart())
    # the via the stub fed (if any) goes too: it is re-placed with the stub
    via = None
    for t in board.GetTracks():
        if isinstance(t, pcbnew.PCB_VIA) and t.GetNetCode() == GND_CODE and t.GetPosition() == other:
            via = t
            break
    width, layer = track.GetWidth(), track.GetLayer()
    via_pad = via_width(via) if via else pcbnew.FromMM(0.5)
    via_hole = via.GetDrill() if via else pcbnew.FromMM(0.2)
    board.Remove(track)
    if via:
        board.Remove(via)
    idx = item_index(GND_CODE)
    if _place_dogbone(idx, pos, width, layer, via_pad, via_hole) or _place_zone_track(idx, pos, width, layer):
        return True
    # no legal replacement: put the original back and leave the fault reported —
    # a pad bonded only to a pour island with no via is an open, not a repair
    board.Add(track)
    if via:
        board.Add(via)
    return False


def _place_dogbone(idx, pos, width, layer, via_pad, via_hole):
    for c in spiral(pos, pcbnew.FromMM(0.1), pcbnew.FromMM(2.6)):
        if c == pos:
            continue
        hole = circle_shape(c, via_hole // 2)
        if not idx.hole_clear(hole, HOLE_CLEARANCE + MARGIN) or not idx.holes_apart(hole, HOLE_GAP):
            continue
        if not idx.clear_all_layers(circle_shape(c, via_pad // 2), CLEARANCE + MARGIN):
            continue
        if not seg_ok(idx, pos, c, width, layer):
            continue
        v = pcbnew.PCB_VIA(board)
        v.SetViaType(pcbnew.VIATYPE_THROUGH)
        v.SetPosition(c)
        v.SetWidth(via_pad)
        v.SetDrill(via_hole)
        v.SetNet(gnd)
        v.SetFrontTentingMode(pcbnew.TENTING_MODE_TENTED)
        v.SetBackTentingMode(pcbnew.TENTING_MODE_TENTED)
        board.Add(v)
        t = pcbnew.PCB_TRACK(board)
        t.SetStart(pos)
        t.SetEnd(c)
        t.SetWidth(width)
        t.SetLayer(layer)
        t.SetNet(gnd)
        board.Add(t)
        return True
    return False


def _main_pour(layer):
    """The largest filled GND outline on `layer` — the plane itself, not an island."""
    best = None
    for z in board.Zones():
        if z.GetNetCode() != GND_CODE or not z.IsOnLayer(layer) or not z.HasFilledPolysForLayer(layer):
            continue
        polys = z.GetFilledPolysList(layer)
        for i in range(polys.OutlineCount()):
            o = polys.Outline(i)
            if best is None or o.Area() > best.Area():
                best = o
    return best


def _place_zone_track(idx, pos, width, layer):
    """Same-layer GND track from the pad into the main pour (no drill needed)."""
    pour = _main_pour(layer)
    if pour is None:
        return False
    inset = width // 2 + CLEARANCE + pcbnew.FromMM(0.05)
    for c in spiral(pos, pcbnew.FromMM(0.2), pcbnew.FromMM(6.0)):
        if c == pos:
            continue
        if not all(pour.PointInside(pcbnew.VECTOR2I(c.x + dx, c.y + dy))
                   for dx, dy in ((0, 0), (inset, 0), (-inset, 0), (0, inset), (0, -inset))):
            continue
        if not seg_ok(idx, pos, c, width, layer):
            continue
        t = pcbnew.PCB_TRACK(board)
        t.SetStart(pos)
        t.SetEnd(c)
        t.SetWidth(width)
        t.SetLayer(layer)
        t.SetNet(gnd)
        board.Add(t)
        return True
    return False


# ---- 2. vias ---------------------------------------------------------------------
def _directed(old, other, deficit):
    """Minimal moves straight away from the offending item: the deficit plus a
    hair, then a little more. A 0.0245mm shortfall needs a 0.03mm move, not a
    0.05mm spiral that lands in the next constraint."""
    if other is None or not hasattr(other, "GetPosition"):
        return []
    oc = other.GetPosition()
    if isinstance(other, pcbnew.PCB_TRACK) and not isinstance(other, pcbnew.PCB_VIA):
        oc = pcbnew.VECTOR2I((other.GetStart().x + other.GetEnd().x) // 2, (other.GetStart().y + other.GetEnd().y) // 2)
    dx, dy = old.x - oc.x, old.y - oc.y
    L = math.hypot(dx, dy)
    if L == 0:
        return []
    ux, uy = dx / L, dy / L
    out = []
    for k in (1.0, 1.5, 2.0, 3.0):
        d = (deficit + MARGIN) * k
        out.append(pcbnew.VECTOR2I(int(old.x + ux * d), int(old.y + uy * d)))
    return out


def fix_via(via, other=None, deficit=0):
    net = via.GetNetCode()
    idx = item_index(net)
    idx.remove(via)
    old = pcbnew.VECTOR2I(via.GetPosition())
    ends = tracks_at(old, net, radius=via_width(via) // 2)
    rej = {"hole": 0, "gap": 0, "ring": 0, "track": 0}
    cands = _directed(old, other, deficit) + [c for c in spiral(old, VIA_STEP, VIA_R_MAX)]
    for c in cands:
        if c == old:
            continue
        hole = circle_shape(c, via.GetDrill() // 2)
        if not idx.hole_clear(hole, HOLE_CLEARANCE + MARGIN, exclude=[via]):
            rej["hole"] += 1
            if DEBUG and rej["hole"] <= 2:
                hit = idx.hole_hit(hole, HOLE_CLEARANCE + MARGIN, exclude=[via])
                sys.stderr.write("[closure]   cand (%.3f, %.3f) hole hit: %s %s on %s\n" % (
                    pcbnew.ToMM(c.x), pcbnew.ToMM(c.y), hit.GetClass() if hit else None,
                    (hit.GetNetname()[:30] if hit else ""), board.GetLayerName(hit.GetLayer()) if hit else ""))
            continue
        if not idx.holes_apart(hole, HOLE_GAP, exclude=[via]):
            rej["gap"] += 1
            continue
        ok = True
        for l in idx.layers:
            if via.IsOnLayer(l) and not idx.clear(circle_shape(c, via_width(via) // 2), l, CLEARANCE + MARGIN, exclude=[via]):
                ok = False
                break
        if not ok:
            rej["ring"] += 1
            continue
        # re-pointed track ends must be clean too
        for t, at_start in ends:
            a = c if at_start else t.GetStart()
            b = t.GetEnd() if at_start else c
            if not seg_ok(idx, a, b, t.GetWidth(), t.GetLayer(), exclude=[t, via]):
                ok = False
                break
        if not ok:
            rej["track"] += 1
            continue
        via.SetPosition(c)
        for t, at_start in ends:
            if at_start:
                t.SetStart(c)
            else:
                t.SetEnd(c)
        return True
    if DEBUG:
        sys.stderr.write("[closure] via at (%.3f, %.3f) mm: no spot; rejected %s\n"
                         % (pcbnew.ToMM(old.x), pcbnew.ToMM(old.y), rej))
    return False


# ---- 3. track jog -----------------------------------------------------------------
def fix_track(track, other):
    """Jog the middle of `track` away from `other` by the missing distance."""
    net = track.GetNetCode()
    idx = item_index(net)
    # copies: pcbnew hands out references to the live members, so after
    # SetEnd(q1) a "b" taken from GetEnd() reads q1 (measured: the third jog
    # piece ran q2 -> q1 and the via end was dropped — U1.8 stranded)
    a, b = pcbnew.VECTOR2I(track.GetStart()), pcbnew.VECTOR2I(track.GetEnd())
    dx, dy = b.x - a.x, b.y - a.y
    L = math.hypot(dx, dy)
    if L < pcbnew.FromMM(0.4):
        return False
    # direction: from the other item's centre, perpendicular to the track
    oc = other.GetPosition() if hasattr(other, "GetPosition") else None
    if oc is None:
        return False
    if isinstance(other, pcbnew.PCB_TRACK) and not isinstance(other, pcbnew.PCB_VIA):
        oc = pcbnew.VECTOR2I((other.GetStart().x + other.GetEnd().x) // 2, (other.GetStart().y + other.GetEnd().y) // 2)
    nx, ny = -dy / L, dx / L
    side = (oc.x - a.x) * nx + (oc.y - a.y) * ny
    if side > 0:
        nx, ny = -nx, -ny
    # measured shortfall from the shapes themselves
    need = CLEARANCE + MARGIN
    for step_mm in (0.05, 0.1, 0.15, 0.2, 0.3):
        off = pcbnew.FromMM(step_mm)
        # jog span: the part of the track nearest the other item, +-0.4mm
        t0 = max(0.0, min(1.0, ((oc.x - a.x) * dx + (oc.y - a.y) * dy) / (L * L)))
        span = min(0.45, pcbnew.FromMM(0.4) / L)
        t1, t2 = max(0.0, t0 - span), min(1.0, t0 + span)
        p1 = pcbnew.VECTOR2I(int(a.x + dx * t1), int(a.y + dy * t1))
        p2 = pcbnew.VECTOR2I(int(a.x + dx * t2), int(a.y + dy * t2))
        q1 = pcbnew.VECTOR2I(int(p1.x + nx * off), int(p1.y + ny * off))
        q2 = pcbnew.VECTOR2I(int(p2.x + nx * off), int(p2.y + ny * off))
        # the track's own endpoints NEVER move (they sit on a pad or a via): a jog
        # that reaches an end becomes a short diagonal lead from that end
        # (measured: a jog that replaced the start stranded U1.8 — an open for a nit)
        pieces = [(a, q1), (q1, q2), (q2, b)]
        if any(not seg_ok(idx, s, e, track.GetWidth(), track.GetLayer(), exclude=[track]) for s, e in pieces):
            continue
        layer, width = track.GetLayer(), track.GetWidth()
        netinfo = track.GetNet()
        first = True
        for s, e in pieces:
            if first:
                track.SetStart(s)
                track.SetEnd(e)
                first = False
                continue
            t = pcbnew.PCB_TRACK(board)
            t.SetStart(s)
            t.SetEnd(e)
            t.SetWidth(width)
            t.SetLayer(layer)
            t.SetNet(netinfo)
            board.Add(t)
        # endpoints of the whole track moved only if the jog reached an end
        return True
    return False


# ---- drive ------------------------------------------------------------------------
fixed = {"gndStub": 0, "via": 0, "trackJog": 0}
unfixed = []
attempted = 0
seen = set()
viol = [v for v in rep.get("violations", []) if v.get("type") in ("clearance", "hole_clearance")]


def _has_via(v):
    return any(isinstance(by_id.get(i.get("uuid")), pcbnew.PCB_VIA) for i in v.get("items", []))


# vias first: they are the most boxed-in items, and a stub or jog placed before
# them can close the only spot they had (measured: a jogged GND stub landed
# beside a via pair and every candidate was then rejected)
viol.sort(key=lambda v: 0 if _has_via(v) else 1)
for v in viol:
    items = [by_id.get(i.get("uuid")) for i in v.get("items", [])]
    items = [i for i in items if i is not None]
    if len(items) < 1:
        unfixed.append(v.get("description", "")[:80])
        continue
    attempted += 1
    key = tuple(sorted(i.m_Uuid.AsString() for i in items))
    if key in seen:
        continue
    seen.add(key)
    done = False
    # 1. a GND stub on either side (ours: GND track touching a ground pad)
    for it in items:
        if isinstance(it, pcbnew.PCB_TRACK) and not isinstance(it, pcbnew.PCB_VIA) and it.GetNetCode() == GND_CODE \
                and (gnd_pad_at(it.GetStart()) or gnd_pad_at(it.GetEnd())):
            if fix_gnd_stub(it):
                fixed["gndStub"] += 1
                done = True
                break
    # 2. a via on either side: move it away from the other item by the deficit
    if not done:
        m = re.search(r"clearance ([0-9.]+) mm; actual ([0-9.]+) mm", v.get("description", ""))
        deficit = pcbnew.FromMM(float(m.group(1)) - float(m.group(2))) if m else pcbnew.FromMM(0.03)
        for i, it in enumerate(items):
            if isinstance(it, pcbnew.PCB_VIA):
                other = items[1 - i] if len(items) == 2 else None
                if fix_via(it, other, max(deficit, 0)):
                    fixed["via"] += 1
                    done = True
                    break
    # 3. a track against something
    if not done and len(items) == 2:
        for i, it in enumerate(items):
            if isinstance(it, pcbnew.PCB_TRACK) and not isinstance(it, pcbnew.PCB_VIA):
                if fix_track(it, items[1 - i]):
                    fixed["trackJog"] += 1
                    done = True
                    break
    if not done:
        unfixed.append(v.get("description", "")[:80])

# zones retreat from the moved copper on their own
pcbnew.ZONE_FILLER(board).Fill(board.Zones())
board.BuildConnectivity()
unconnected = board.GetConnectivity().GetUnconnectedCount(False)
unreached = []
_conn = board.GetConnectivity()
for fp in board.GetFootprints():
    for pad in fp.Pads():
        if pad.GetNetCode() != GND_CODE or GND_CODE < 0:
            continue
        if not any(i.GetClass() == 'ZONE' and i.GetNetCode() == GND_CODE for i in _conn.GetConnectedItems(pad)):
            unreached.append(f"{fp.GetReference()}.{pad.GetNumber()}")
pcbnew.SaveBoard(outp, board)
print(json.dumps({"attempted": attempted, "fixed": fixed, "unfixed": unfixed,
                  "unconnected": unconnected, "unreachedPads": unreached}))
