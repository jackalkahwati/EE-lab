"""Ensure the board carries >= 3 assembly fiducials, spread out. The atopile
netlist has no fiducial parts, so the routed board can reach the DFM gate with
zero — pick-and-place needs them. This injects real KiCad fiducial footprints
into free space (clearing edges, mounting holes, and other courtyards), then
saves. Idempotent: does nothing if 3 are already present.

Run with KiCad's bundled python:  python3 add_fiducials.py <board.kicad_pcb>
Prints  FIDUCIALS <n>  (final count). Exit 0 always — best-effort self-heal.
"""
import sys

import pcbnew

BOARD = sys.argv[1]
FID_LIB = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints/Fiducial.pretty"
FID_FP = "Fiducial_1mm_Mask2mm"
NEED = 3
EDGE = 4.0      # inset from board edge, mm
CLEAR = 1.5     # courtyard clearance to other parts, mm


def mm(v):
    return pcbnew.FromMM(v)


def tomm(v):
    return pcbnew.ToMM(v)


def main():
    b = pcbnew.LoadBoard(BOARD)
    fps = list(b.GetFootprints())
    have = [f for f in fps if "Fiducial" in str(f.GetFPID().GetLibItemName())]
    if len(have) >= NEED:
        print("FIDUCIALS {}".format(len(have)))
        return

    # board bounding box from the edge cuts
    bb = b.GetBoardEdgesBoundingBox()
    x0, y0 = tomm(bb.GetX()), tomm(bb.GetY())
    x1, y1 = x0 + tomm(bb.GetWidth()), y0 + tomm(bb.GetHeight())

    # occupied rectangles (courtyard/bbox of every existing footprint)
    occ = []
    for f in fps:
        r = f.GetBoundingBox(False, False)
        occ.append((tomm(r.GetX()) - CLEAR, tomm(r.GetY()) - CLEAR,
                    tomm(r.GetX() + r.GetWidth()) + CLEAR,
                    tomm(r.GetY() + r.GetHeight()) + CLEAR))

    def free(px, py):
        if not (x0 + EDGE < px < x1 - EDGE and y0 + EDGE < py < y1 - EDGE):
            return False
        for ax0, ay0, ax1, ay1 in occ:
            if ax0 <= px <= ax1 and ay0 <= py <= ay1:
                return False
        return True

    # prefer spots near three different corners, then scan a grid for the rest
    targets = [(x0 + 8, y0 + 8), (x1 - 8, y1 - 8), (x0 + 8, y1 - 8),
               (x1 - 8, y0 + 8)]
    spots = []
    for tx, ty in targets:
        best = None
        for dy in range(0, 60, 3):
            for dx in range(0, 60, 3):
                for sx in (1, -1):
                    for sy in (1, -1):
                        px, py = tx + sx * dx, ty + sy * dy
                        if free(px, py) and all(
                                (px - q[0]) ** 2 + (py - q[1]) ** 2 > 100
                                for q in spots):
                            best = (px, py)
                            break
                    if best:
                        break
                if best:
                    break
            if best:
                break
        if best:
            spots.append(best)
            occ.append((best[0] - 3, best[1] - 3, best[0] + 3, best[1] + 3))
        if len(have) + len(spots) >= NEED:
            break

    added = 0
    for i, (px, py) in enumerate(spots):
        fp = pcbnew.FootprintLoad(FID_LIB, FID_FP)
        if fp is None:
            break
        fp.SetReference("FID{}".format(len(have) + i + 1))
        fp.SetPosition(pcbnew.VECTOR2I(mm(px), mm(py)))
        b.Add(fp)
        added += 1

    if added:
        pcbnew.SaveBoard(BOARD, b)
    print("FIDUCIALS {}".format(len(have) + added))


if __name__ == "__main__":
    main()
