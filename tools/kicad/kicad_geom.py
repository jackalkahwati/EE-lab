"""Clearance checks against KiCad's OWN geometry (pcbnew effective shapes).

Every residual sub-rule clearance fault on a shipped board this month came from
copper that was placed or moved by a model that is not the one DRC grades:
bounding boxes for pads in the pour's dog-bone search, circuit-json pad sizes
in the router-side legalizers. This module is the one geometry model: the
same SHAPE objects KiCad's DRC measures, queried with SHAPE.Collide(shape,
clearance), which is exactly the DRC clearance test.

Used by ground_plane.py (prevention: never place a stub or via that fails the
rule) and drc_closure.py (repair: fix what an upstream step still got wrong).
"""
import math

import pcbnew


class CopperIndex:
    """Other-net copper on each copper layer, with cheap bbox pre-filtering.

    items: {layer_id: [(bbox, shape, item)]} for pads, tracks and vias whose net
    is not `own_net` (same-net copper may touch). Zones are excluded on purpose:
    a zone is refilled after every edit and retreats from other copper itself.
    """

    def __init__(self, board, own_net_code, layers=None):
        self.board = board
        self.own = own_net_code
        self.layers = list(layers) if layers is not None else list(board.GetEnabledLayers().CuStack())
        self.items = {l: [] for l in self.layers}
        self.holes = []  # (bbox, hole_shape, item) for every drilled hole (PTH pads, vias, NPTH)
        self.rebuild()

    def rebuild(self):
        for l in self.layers:
            self.items[l] = []
        self.holes = []
        for fp in self.board.GetFootprints():
            for pad in fp.Pads():
                if pad.GetAttribute() in (pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH):
                    try:
                        hs = pad.GetEffectiveHoleShape()
                        self.holes.append((hs.BBox(), hs, pad))
                    except Exception:
                        pass
                if pad.GetNetCode() == self.own:
                    continue
                for l in self.layers:
                    if pad.IsOnLayer(l):
                        s = pad.GetEffectiveShape(l)
                        self.items[l].append((s.BBox(), s, pad))
        for t in self.board.GetTracks():
            if isinstance(t, pcbnew.PCB_VIA):
                try:
                    hs = t.GetEffectiveHoleShape()
                    self.holes.append((hs.BBox(), hs, t))
                except Exception:
                    pass
                if t.GetNetCode() == self.own:
                    continue
                for l in self.layers:
                    if t.IsOnLayer(l):
                        s = t.GetEffectiveShape(l)
                        self.items[l].append((s.BBox(), s, t))
            else:
                if t.GetNetCode() == self.own:
                    continue
                l = t.GetLayer()
                if l in self.items:
                    s = t.GetEffectiveShape()
                    self.items[l].append((s.BBox(), s, t))

    @staticmethod
    def _near(bb, sb, margin):
        return not (bb.GetRight() + margin < sb.GetLeft() or sb.GetRight() + margin < bb.GetLeft()
                    or bb.GetBottom() + margin < sb.GetTop() or sb.GetBottom() + margin < bb.GetTop())

    def first_hit(self, shape, layer, clearance, exclude=(), hole_clearance=None):
        """The first other-net item on `layer` within `clearance` of `shape`, or
        None. With `hole_clearance`, other-net DRILLS (PTH pads, vias, NPTH) must
        also stay that far from the copper — KiCad's hole_clearance rule, which
        a track passing a signal via trips at 0.275mm against 0.35mm."""
        sb = shape.BBox()
        for bb, s, item in self.items.get(layer, ()):
            if self._excluded(item, exclude):
                continue
            if not self._near(bb, sb, clearance):
                continue
            if s.Collide(shape, int(clearance)):
                return item
        if hole_clearance is not None:
            for bb, hs, item in self.holes:
                if item.GetNetCode() == self.own or self._excluded(item, exclude):
                    continue
                if not self._near(bb, sb, hole_clearance):
                    continue
                if hs.Collide(shape, int(hole_clearance)):
                    return item
        return None

    def clear(self, shape, layer, clearance, exclude=(), hole_clearance=None):
        return self.first_hit(shape, layer, clearance, exclude, hole_clearance) is None

    def clear_all_layers(self, shape, clearance, exclude=(), hole_clearance=None):
        """A through-hole feature must clear every copper layer."""
        for l in self.layers:
            if not self.clear(shape, l, clearance, exclude, hole_clearance):
                return False
        return True

    @staticmethod
    def _same(a, b):
        # SWIG hands out a new proxy per access: compare the underlying item by uuid
        try:
            return a.m_Uuid.AsString() == b.m_Uuid.AsString()
        except Exception:
            return a is b

    def _excluded(self, item, exclude):
        return any(self._same(item, e) for e in exclude)

    def hole_hit(self, hole_shape, hole_clearance, exclude=()):
        """Drill-to-copper: the first other-net pad/track within `hole_clearance`
        of the hole on ANY layer (a through drill crosses them all), or None.
        Via copper counts: KiCad reported "Hole clearance violation 0.2982mm"
        between two vias the moment one was moved by a test that skipped it."""
        sb = hole_shape.BBox()
        for l in self.layers:
            for bb, s, item in self.items.get(l, ()):
                if self._excluded(item, exclude):
                    continue
                if not self._near(bb, sb, hole_clearance):
                    continue
                if s.Collide(hole_shape, int(hole_clearance)):
                    return item
        return None

    def hole_clear(self, hole_shape, hole_clearance, exclude=()):
        return self.hole_hit(hole_shape, hole_clearance, exclude) is None

    def holes_apart(self, hole_shape, min_gap, exclude=()):
        """Hole-to-hole: no other drilled hole within `min_gap` edge to edge."""
        sb = hole_shape.BBox()
        for bb, s, item in self.holes:
            if self._excluded(item, exclude) or not self._near(bb, sb, min_gap):
                continue
            if s.Collide(hole_shape, int(min_gap)):
                return False
        return True

    def add(self, item):
        """Index a newly added item (tracks/vias/pads) so later checks see it."""
        if isinstance(item, pcbnew.PCB_VIA):
            try:
                hs = item.GetEffectiveHoleShape()
                self.holes.append((hs.BBox(), hs, item))
            except Exception:
                pass
            if item.GetNetCode() == self.own:
                return
            for l in self.layers:
                if item.IsOnLayer(l):
                    s = item.GetEffectiveShape(l)
                    self.items[l].append((s.BBox(), s, item))
        elif isinstance(item, pcbnew.PCB_TRACK):
            if item.GetNetCode() == self.own:
                return
            l = item.GetLayer()
            if l in self.items:
                s = item.GetEffectiveShape()
                self.items[l].append((s.BBox(), s, item))

    def remove(self, item):
        for l in self.layers:
            self.items[l] = [e for e in self.items[l] if not self._same(e[2], item)]
        self.holes = [e for e in self.holes if not self._same(e[2], item)]


def seg_shape(a, b, width):
    return pcbnew.SHAPE_SEGMENT(a, b, int(width))


def circle_shape(center, radius):
    return pcbnew.SHAPE_CIRCLE(center, int(radius))


def spiral(center, step, rmax):
    """Candidate positions around `center`: rings of `step`, 8/16/24 directions."""
    yield center
    r = step
    while r <= rmax:
        n = 8 if r <= step else (16 if r <= 2 * step else 24)
        for k in range(n):
            a = 2.0 * math.pi * k / n
            yield pcbnew.VECTOR2I(int(center.x + r * math.cos(a)), int(center.y + r * math.sin(a)))
        r += step
