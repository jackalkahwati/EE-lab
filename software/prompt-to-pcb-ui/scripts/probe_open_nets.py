"""For 2-pad nets that have copper but stay open: locate the physical gap.

  <kicad-python3> probe_open_nets.py <board.kicad_pcb> <net> [<net> ...]

Per net, reports:
  - segment-chain connectivity at 0 / 1um / 10um endpoint tolerance
    (micro-gaps from SES coordinate rounding show up here)
  - for each pad: smallest probe clearance at which a track endpoint
    touches the pad (pad-entry undershoot shows up here)
"""
import sys
from collections import defaultdict

import pcbnew

b = pcbnew.LoadBoard(sys.argv[1])
targets = set(sys.argv[2:])

pads_by_net = defaultdict(list)
for fp in b.GetFootprints():
    for pad in fp.Pads():
        if str(pad.GetNetname()) in targets:
            pads_by_net[str(pad.GetNetname())].append(pad)

tracks_by_net = defaultdict(list)
for t in b.GetTracks():
    if str(t.GetNetname()) in targets:
        tracks_by_net[str(t.GetNetname())].append(t)


def components(segs, tol_nm):
    """count connected components of track segments with endpoint tolerance"""
    pts = []
    for s in segs:
        if s.GetClass() == "PCB_VIA":
            pts.append((s.GetPosition(), s.GetPosition()))
        else:
            pts.append((s.GetStart(), s.GetEnd()))
    n = len(pts)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def near(a, c):
        return abs(a.x - c.x) <= tol_nm and abs(a.y - c.y) <= tol_nm

    for i in range(n):
        for j in range(i + 1, n):
            if any(near(a, c) for a in pts[i] for c in pts[j]):
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[ri] = rj
    return len({find(i) for i in range(n)})


for net in sorted(targets):
    pads = pads_by_net[net]
    segs = tracks_by_net[net]
    print(f"== {net}: {len(pads)} pads, {len(segs)} track items")
    if not segs:
        print("   no copper at all")
        continue
    for tol, label in [(0, "exact"), (1000, "1um"), (10000, "10um"), (100000, "100um")]:
        print(f"   chain components @ {label}: {components(segs, tol)}")
    # pad-entry probe: min clearance at which any endpoint touches each pad
    for pad in pads:
        shape = pad.GetEffectiveShape(pad.GetLayer())
        best = None
        for s in segs:
            ends = [s.GetPosition()] if s.GetClass() == "PCB_VIA" else [s.GetStart(), s.GetEnd()]
            for e in ends:
                for probe_um in (0, 10, 25, 50, 100, 200, 400, 800):
                    if shape.Collide(e, probe_um * 1000):
                        if best is None or probe_um < best:
                            best = probe_um
                        break
        try:
            ref = pad.GetParentFootprint().GetReference()
        except Exception:
            ref = "?"
        print(f"   pad {ref}-{pad.GetNumber()}: nearest endpoint within "
              f"{'NO CONTACT <=800um' if best is None else f'{best}um'}")
