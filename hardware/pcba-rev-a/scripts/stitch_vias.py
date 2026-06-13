"""Stitch zone-served SMD pads down to their plane.

flroute (correctly) skips the two zone-served nets — lv (poured on In1/B.Cu)
and the coil rail sel_p4-coil_bus-hv (poured on In2.Cu) — on the assumption
the pours connect them. But the pours live on inner/bottom layers, while the
nets' SMD pads sit on F.Cu. Each such pad therefore has no copper path to its
plane until a stitching via drops it down.

Strategy: one via-in-pad per unconnected F.Cu pad, sized to fit inside the
pad (same net, so no clearance conflict with the host pad), placed at the pad
center. A through via connects to whichever layer the net's pour occupies. If
a pad is narrower than the smallest via we'll place, the via annular ring can
protrude into a different-net neighbor — for those we shrink, then nudge along
the pad's long axis, and only then give up (reported, not silently dropped).

KiCad DRC is the referee; run drc after this.

Usage (KiCad bundled python, from pcba-rev-a/):
  .../python3 scripts/stitch_vias.py [board.kicad_pcb]
"""
import sys

import pcbnew

BOARD = sys.argv[1] if len(sys.argv) > 1 else "elec/layout/rev-a-routed.kicad_pcb"

FROM_MM = pcbnew.FromMM
TO_MM = pcbnew.ToMM

b = pcbnew.LoadBoard(BOARD)
ds = b.GetDesignSettings()
clearance = ds.GetSmallestClearanceValue()
EDGE_CLR = ds.m_CopperEdgeClearance
HOLE2HOLE = ds.m_HoleToHoleMin
STD_VIA = b.GetAllNetClasses()["Default"].GetViaDiameter()  # 0.6 mm
STD_DRILL = b.GetAllNetClasses()["Default"].GetViaDrill()   # 0.3 mm

# --- which layer each zone net pours on ---------------------------------------
zone_layers = {}
for z in b.Zones():
    net = z.GetNetname()
    zone_layers.setdefault(net, set()).update(z.GetLayerSet().CuStack())
zone_nets = set(zone_layers)

# --- obstacle model: every OTHER-net copper item, real geometry + layers ------
# A track's AABB spans its whole diagonal, so bbox tests reject far-too-much.
# Use KiCad's effective shapes (true segment/polygon geometry) for the actual
# clearance test, gated by a cheap inflated-bbox pre-filter. Each obstacle
# carries its copper-layer set: a through via must clear other-net copper on
# every layer it punches, but a via fully inside its host pad is already safe
# on the pad's layer (it merges, same net) and only needs the OTHER layers.
obstacles = []  # (effective_shape, inflated_bbox, netcode, frozenset(layers))


def register(item, layers):
    bb = item.GetBoundingBox()
    bb.Inflate(clearance)
    layer0 = next(iter(layers))
    shape = item.GetEffectiveShape(layer0)
    obstacles.append((shape, bb, item.GetNetCode(), frozenset(layers)))


# every drilled hole (THT pad / existing via): center + radius, for hole-to-hole
holes = []


def reg_hole(center, drill):
    holes.append((center, drill // 2))


for fp in b.GetFootprints():
    for pad in fp.Pads():
        cu = list(pad.GetLayerSet().CuStack())
        register(pad, cu or [pcbnew.F_Cu])
        dh = pad.GetDrillSize()
        if dh.x > 0:
            reg_hole(pad.GetPosition(), min(dh.x, dh.y))
for t in b.GetTracks():
    register(t, [t.GetLayer()])
    if isinstance(t, pcbnew.PCB_VIA):
        reg_hole(t.GetPosition(), t.GetDrill())

edge_box = None
for d in b.GetDrawings():
    if d.GetLayer() == pcbnew.Edge_Cuts and d.GetShape() == pcbnew.SHAPE_T_RECT:
        edge_box = d.GetBoundingBox()


def hole_clears(cx, cy, drill):
    """True if a drill of `drill` at (cx,cy) keeps hole-to-hole spacing."""
    r = drill // 2
    for (c, hr) in holes:
        dx, dy = c.x - cx, c.y - cy
        if (dx * dx + dy * dy) ** 0.5 < r + hr + HOLE2HOLE:
            return False
    return True


def inside_edge(cx, cy, outer_dia):
    """True if a via of outer_dia clears the board edge by EDGE_CLR."""
    if edge_box is None:
        return True
    e = pcbnew.BOX2I(edge_box.GetPosition(), edge_box.GetSize())
    e.Inflate(-(outer_dia // 2 + EDGE_CLR))
    return e.Contains(pcbnew.VECTOR2I(cx, cy))


def clears_point(cx, cy, reach, netcode, on_layers):
    """True if (cx,cy) clears every other-net obstacle sharing a layer in
    on_layers, by at least `reach`."""
    pt = pcbnew.VECTOR2I(cx, cy)
    qb = pcbnew.BOX2I(pcbnew.VECTOR2I(cx, cy), pcbnew.VECTOR2I(0, 0))
    qb.Inflate(reach)
    for shape, bb, nc, layers in obstacles:
        if nc == netcode or layers.isdisjoint(on_layers):
            continue
        if not bb.Intersects(qb):
            continue  # cheap reject
        if shape.Collide(pt, reach):
            return False
    return True


def via_clears(cx, cy, outer_dia, drill, netcode, on_layers):
    """True if a through via at (cx,cy) clears other-net copper on on_layers,
    the board edge, and neighboring holes."""
    if not inside_edge(cx, cy, outer_dia) or not hole_clears(cx, cy, drill):
        return False
    return clears_point(cx, cy, outer_dia // 2 + clearance, netcode, on_layers)


def stub_clears(x0, y0, x1, y1, width, netcode):
    """True if an F.Cu stub trace clears other-net F.Cu copper (point-sampled)."""
    reach = width // 2 + clearance
    dx, dy = x1 - x0, y1 - y0
    length = max(1, int((dx * dx + dy * dy) ** 0.5))
    nstep = max(2, length // FROM_MM(0.1))
    for i in range(nstep + 1):
        t = i / nstep
        if not clears_point(int(x0 + dx * t), int(y0 + dy * t), reach, netcode,
                            {pcbnew.F_Cu}):
            return False
    return True


def add_via(cx, cy, outer_dia, drill, netcode):
    v = pcbnew.PCB_VIA(b)
    v.SetPosition(pcbnew.VECTOR2I(cx, cy))
    v.SetWidth(outer_dia)
    v.SetDrill(drill)
    v.SetViaType(pcbnew.VIATYPE_THROUGH)
    v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
    v.SetNetCode(netcode)
    b.Add(v)
    register(v, [pcbnew.F_Cu, pcbnew.In1_Cu, pcbnew.In2_Cu, pcbnew.B_Cu])
    reg_hole(pcbnew.VECTOR2I(cx, cy), drill)
    return v


def add_stub(x0, y0, x1, y1, width, netcode):
    t = pcbnew.PCB_TRACK(b)
    t.SetStart(pcbnew.VECTOR2I(x0, y0))
    t.SetEnd(pcbnew.VECTOR2I(x1, y1))
    t.SetWidth(width)
    t.SetLayer(pcbnew.F_Cu)
    t.SetNetCode(netcode)
    b.Add(t)
    register(t, [pcbnew.F_Cu])
    return t


# --- place one stitch via per unconnected zone SMD pad ------------------------
# Two-tier: (1) via-in-pad, the manufacturable ideal (no stub, no wicking path
# longer than the pad). (2) fanout — nearest open spot reachable by a short
# F.Cu stub. Both collision-checked against real geometry; DRC referees.
placed = 0
stubbed = 0
failed = []
# board-honored via geometry: never below min via / min drill / hole rules
VIA_O = STD_VIA      # 0.6 mm
VIA_D = STD_DRILL    # 0.3 mm
MIN_VIA_O = ds.m_ViasMinSize   # 0.5 mm
STUB_W = FROM_MM(0.25)
ALLCU = {pcbnew.F_Cu, pcbnew.In1_Cu, pcbnew.In2_Cu, pcbnew.B_Cu}
import math

for fp in b.GetFootprints():
    for pad in fp.Pads():
        net = pad.GetNetname()
        if net not in zone_nets or pad.GetAttribute() != pcbnew.PAD_ATTRIB_SMD:
            continue
        if set(pad.GetLayerSet().CuStack()) & zone_layers[net]:
            continue  # already touches its pour

        nc = pad.GetNetCode()
        pos = pad.GetPosition()

        # tier 1: via-in-pad. A same-net via fully inside the host pad merges
        # with it on F.Cu (no new F.Cu clearance issue — the pad was already
        # clean), but a THROUGH via still punches In1/In2/B.Cu and must clear
        # other-net copper there. So: fit on F.Cu + clear on the other layers +
        # board edge + hole spacing. Via size stays >= board minimum.
        pad_layers = set(pad.GetLayerSet().CuStack())
        punch = ALLCU - pad_layers

        def fits_in_pad(cx, cy, o):
            rad = o // 2
            for k in range(8):
                ang = math.radians(k * 45)
                px = cx + int(rad * math.cos(ang))
                py = cy + int(rad * math.sin(ang))
                if not pad.HitTest(pcbnew.VECTOR2I(px, py)):
                    return False
            return True

        # candidate via centers inside the pad: center first, then a grid (an
        # off-center via can dodge an inner-layer track running under the pad)
        sz = pad.GetSize()
        cand = [(pos.x, pos.y)]
        gx = max(1, sz.x // 6)
        gy = max(1, sz.y // 6)
        for ix in (-2, -1, 1, 2):
            cand.append((pos.x + ix * gx, pos.y))
        for iy in (-2, -1, 1, 2):
            cand.append((pos.x, pos.y + iy * gy))
        for ix in (-1, 1):
            for iy in (-1, 1):
                cand.append((pos.x + ix * gx, pos.y + iy * gy))

        done = False
        o = VIA_O
        while o >= MIN_VIA_O and not done:
            for (cx, cy) in cand:
                if (fits_in_pad(cx, cy, o)
                        and clears_point(cx, cy, o // 2 + clearance, nc, punch)
                        and inside_edge(cx, cy, o)
                        and hole_clears(cx, cy, VIA_D)):
                    add_via(cx, cy, o, VIA_D, nc)
                    placed += 1
                    done = True
                    break
            o -= FROM_MM(0.05)
        if done:
            continue

        # tier 2: fanout — spiral outward, standard via + collision-checked stub.
        # Anchor the stub at the nearest in-pad point to the via so it starts on
        # copper; try the default track width then the board minimum.
        for stub_w in (STUB_W, FROM_MM(0.2)):
            for rmm in (0.4, 0.5, 0.6, 0.7, 0.8, 1.0, 1.2, 1.5, 1.8, 2.2, 2.6, 3.0):
                r = FROM_MM(rmm)
                for a in range(0, 360, 15):
                    cx = pos.x + int(r * math.cos(math.radians(a)))
                    cy = pos.y + int(r * math.sin(math.radians(a)))
                    if not via_clears(cx, cy, VIA_O, VIA_D, nc, ALLCU):
                        continue
                    if not stub_clears(pos.x, pos.y, cx, cy, stub_w, nc):
                        continue
                    add_stub(pos.x, pos.y, cx, cy, stub_w, nc)
                    add_via(cx, cy, VIA_O, VIA_D, nc)
                    placed += 1
                    stubbed += 1
                    done = True
                    break
                if done:
                    break
            if done:
                break
        if not done:
            failed.append((fp.GetReference(), pad.GetPadName(), net))

# --- tighten zone clearance + refill ------------------------------------------
# The pours shipped at 0.5 mm clearance (2.5x the 0.2 mm design rule), so copper
# could not squeeze between nearby tracks and fragmented into dead islands.
# Drop to just above the rule (hv coil keeps a little extra) so the planes flood
# completely and the stitch vias land on the main pour body, not slivers.
ZONE_CLR = {"sel_p4-coil_bus-hv": FROM_MM(0.3)}  # hv: a touch of margin
DEFAULT_ZONE_CLR = FROM_MM(0.25)
for z in b.Zones():
    z.SetLocalClearance(ZONE_CLR.get(z.GetNetname(), DEFAULT_ZONE_CLR))
pcbnew.ZONE_FILLER(b).Fill(b.Zones())
pcbnew.SaveBoard(BOARD, b)

conn = b.GetConnectivity()
print(f"stitch vias placed: {placed} ({stubbed} via fanout stub, {placed - stubbed} via-in-pad)")
print(f"unrouted connections remaining: {conn.GetUnconnectedCount(True)}")
if failed:
    print(f"NO CLEAR SPOT for {len(failed)} pads:")
    for ref, pad, net in failed:
        print(f"  {ref}.{pad} [{net}]")
