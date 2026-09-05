"""Pure test for the dog-bone clearance geometry in ground_plane.py.

The functions are exact segment↔box / segment↔segment distances. They replaced an
8-point sampled check that let a 1.8mm dog-bone pass 0.031mm from a QFN pad
(measured). No pcbnew: the slice is exec'd with a stand-in box.
"""
import math, os, re, sys

SRC = open(os.path.join(os.path.dirname(__file__), 'ground_plane.py')).read()
start = SRC.index('def _pt_seg_d2(')
end = SRC.index('def track_clears(')
ns = {}
exec(SRC[start:end], ns)


class P:
    def __init__(self, x, y): self.x, self.y = x, y


class Box:  # pcbnew BOX2I stand-in (y grows downward, Top < Bottom)
    def __init__(self, l, t, r, b): self._l, self._t, self._r, self._b = l, t, r, b
    def GetLeft(self): return self._l
    def GetRight(self): return self._r
    def GetTop(self): return self._t
    def GetBottom(self): return self._b


def d(x): return math.sqrt(x)


def test_segment_passing_beside_a_pad_between_sample_points():
    # 1.8mm track at x=0 from y=0..1800; pad box 250 wide whose near edge is 106 away,
    # spanning y 900..1150 — the exact case the sampled check missed.
    pad = Box(106, 900, 356, 1150)
    assert abs(d(ns['seg_rect_d2'](P(0, 0), P(0, 1800), pad)) - 106) < 1e-9


def test_segment_crossing_or_ending_inside_a_pad_is_zero():
    pad = Box(-100, 500, 100, 700)
    assert ns['seg_rect_d2'](P(0, 0), P(0, 1800), pad) == 0        # crosses
    assert ns['seg_rect_d2'](P(0, 0), P(0, 600), pad) == 0         # ends inside
    assert ns['seg_rect_d2'](P(-500, 600), P(500, 600), pad) == 0  # crosses sideways


def test_segment_clear_of_a_pad_measures_to_the_nearest_corner_or_edge():
    pad = Box(1000, 1000, 1200, 1200)
    assert abs(d(ns['seg_rect_d2'](P(0, 0), P(0, 500), pad)) - math.hypot(1000, 500)) < 1e-9  # corner
    assert abs(d(ns['seg_rect_d2'](P(0, 1100), P(800, 1100), pad)) - 200) < 1e-9             # edge, endpoint nearest


def test_segment_to_segment():
    s = ns['seg_seg_d2']
    assert s(P(0, 0), P(10, 0), P(5, -5), P(5, 5)) == 0                          # cross
    assert abs(d(s(P(0, 0), P(10, 0), P(0, 3), P(10, 3))) - 3) < 1e-9            # parallel
    assert abs(d(s(P(0, 0), P(10, 0), P(12, 0), P(20, 0))) - 2) < 1e-9           # collinear gap
    assert abs(d(s(P(0, 0), P(10, 0), P(3, 4), P(3, 9))) - 4) < 1e-9             # endpoint to segment


if __name__ == '__main__':
    fails = 0
    for name, fn in list(globals().items()):
        if name.startswith('test_'):
            try:
                fn(); print('  ok  ' + name)
            except AssertionError as e:
                fails += 1; print('  FAIL ' + name, e)
    print(f'{len([n for n in globals() if n.startswith("test_")]) - fails} passed, {fails} failed')
    sys.exit(1 if fails else 0)
