"""The CFD case's locationInMesh must not lie on a background-mesh face on any axis
(snappyHexMesh's findCells finds no cell there). Reproduces the 78x48x22mm case."""
import re, os, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
import sim_cfd


def _point_and_grid(dev):
    case = tempfile.mkdtemp()
    sim_cfd._gen_case(case, dev, 0.2)
    bm = open(os.path.join(case, "system/blockMeshDict")).read()
    sn = open(os.path.join(case, "system/snappyHexMeshDict")).read()
    verts = [tuple(map(float, v)) for v in re.findall(r"\(([-\d.e]+) ([-\d.e]+) ([-\d.e]+)\)", bm.split("vertices")[1].split("blocks")[0])]
    nx, ny, nz = map(int, re.search(r"hex \(0 1 2 3 4 5 6 7\) \((\d+) (\d+) (\d+)\)", bm).groups())
    loc = tuple(map(float, re.search(r"locationInMesh \(([-\d.e]+) ([-\d.e]+) ([-\d.e]+)\)", sn).groups()))
    lo = tuple(min(v[i] for v in verts) for i in range(3)); hi = tuple(max(v[i] for v in verts) for i in range(3))
    return loc, lo, hi, (nx, ny, nz)


def _check(dev):
    loc, lo, hi, n = _point_and_grid(dev)
    for i in range(3):
        assert lo[i] < loc[i] < hi[i], (dev, i, loc, lo, hi)
        frac = (loc[i] - lo[i]) / ((hi[i] - lo[i]) / n[i])
        assert abs(frac - round(frac)) > 0.05, "axis %d of %s sits on a mesh face (frac %.3f)" % (i, dev, frac)


def test_enclosure_78x48x22_is_interior_on_every_axis():
    _check((0.078, 0.048, 0.022))


def test_bare_boards_and_odd_grids_too():
    for dev in ((0.026, 0.029, 0.004), (0.034, 0.034, 0.016), (0.1, 0.1, 0.03), (0.05, 0.02, 0.01)):
        _check(dev)


if __name__ == "__main__":
    test_enclosure_78x48x22_is_interior_on_every_axis(); test_bare_boards_and_odd_grids_too(); print("2 passed")
