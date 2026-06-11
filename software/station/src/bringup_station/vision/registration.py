"""Board-to-machine registration.

Fits a 2D transform from board-frame fiducial coordinates to machine-frame
coordinates (where the camera found those fiducials). Two fiducials give a
similarity transform (rotation + uniform scale + translation); three or more
give a full affine fit by least squares, which also absorbs board stretch.

EVT proof #1 (locate and probe accurately) rides on this module plus the
camera-to-probe offset calibration.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence, Tuple

import numpy as np

Point = Tuple[float, float]


@dataclass(frozen=True)
class Transform2D:
    """x_machine = A @ x_board + t"""

    a: Tuple[Tuple[float, float], Tuple[float, float]]
    t: Point

    def apply(self, p: Point) -> Point:
        (a11, a12), (a21, a22) = self.a
        x, y = p
        return (a11 * x + a12 * y + self.t[0],
                a21 * x + a22 * y + self.t[1])

    def residuals(self, board_pts: Sequence[Point],
                  machine_pts: Sequence[Point]) -> "list[float]":
        return [float(np.hypot(mx - tx, my - ty))
                for (mx, my), (tx, ty) in
                ((m, self.apply(b)) for b, m in zip(board_pts, machine_pts))]


def fit_transform(board_pts: Sequence[Point],
                  machine_pts: Sequence[Point]) -> Transform2D:
    if len(board_pts) != len(machine_pts):
        raise ValueError("point count mismatch")
    if len(board_pts) < 2:
        raise ValueError("at least 2 fiducials required")
    if len(board_pts) == 2:
        return _fit_similarity(board_pts, machine_pts)
    return _fit_affine(board_pts, machine_pts)


def _fit_affine(bp: Sequence[Point], mp: Sequence[Point]) -> Transform2D:
    n = len(bp)
    g = np.zeros((2 * n, 6))
    d = np.zeros(2 * n)
    for i, ((bx, by), (mx, my)) in enumerate(zip(bp, mp)):
        g[2 * i] = [bx, by, 1, 0, 0, 0]
        g[2 * i + 1] = [0, 0, 0, bx, by, 1]
        d[2 * i] = mx
        d[2 * i + 1] = my
    sol, *_ = np.linalg.lstsq(g, d, rcond=None)
    a11, a12, tx, a21, a22, ty = sol
    return Transform2D(a=((a11, a12), (a21, a22)), t=(tx, ty))


def _fit_similarity(bp: Sequence[Point], mp: Sequence[Point]) -> Transform2D:
    """Umeyama-style closed form for rotation + uniform scale + translation."""
    b = np.asarray(bp, dtype=float)
    m = np.asarray(mp, dtype=float)
    bc = b - b.mean(axis=0)
    mc = m - m.mean(axis=0)
    # complex-number formulation: m = s * e^{i theta} * b + t
    zb = bc[:, 0] + 1j * bc[:, 1]
    zm = mc[:, 0] + 1j * mc[:, 1]
    coeff = np.vdot(zb, zm) / np.vdot(zb, zb)
    a11, a21 = coeff.real, coeff.imag
    a = ((a11, -a21), (a21, a11))
    bx, by = b.mean(axis=0)
    mx, my = m.mean(axis=0)
    tx = mx - (a[0][0] * bx + a[0][1] * by)
    ty = my - (a[1][0] * bx + a[1][1] * by)
    return Transform2D(a=a, t=(tx, ty))
