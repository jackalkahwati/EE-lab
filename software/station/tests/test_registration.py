import math

from bringup_station.vision.registration import fit_transform


def test_affine_recovers_known_transform():
    # board rotated 30 degrees, translated (12, -7)
    theta = math.radians(30)
    c, s = math.cos(theta), math.sin(theta)

    def world(p):
        x, y = p
        return (c * x - s * y + 12.0, s * x + c * y - 7.0)

    board = [(0.0, 0.0), (100.0, 0.0), (0.0, 80.0), (100.0, 80.0)]
    machine = [world(p) for p in board]
    t = fit_transform(board, machine)

    probe = (37.5, 22.5)
    got = t.apply(probe)
    want = world(probe)
    assert math.isclose(got[0], want[0], abs_tol=1e-9)
    assert math.isclose(got[1], want[1], abs_tol=1e-9)
    assert max(t.residuals(board, machine)) < 1e-9


def test_two_point_similarity():
    # pure translation from two fiducials
    board = [(0.0, 0.0), (50.0, 0.0)]
    machine = [(10.0, 5.0), (60.0, 5.0)]
    t = fit_transform(board, machine)
    got = t.apply((25.0, 10.0))
    assert math.isclose(got[0], 35.0, abs_tol=1e-9)
    assert math.isclose(got[1], 15.0, abs_tol=1e-9)
