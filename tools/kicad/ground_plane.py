#!/usr/bin/env python3
"""Add a real, DRC-verified ground plane to a net-less .kicad_pcb via pcbnew.

The circuit-json-to-kicad export carries no nets, so ground pins can't connect
to a plane the normal way. This pass, run with KiCad's own python (pcbnew):
  1. creates a GND net and assigns it to every ground pad (matched by
     footprint reference + pad number from the netlist);
  2. lays a filled GND copper zone on the TOP layer AND on a reference plane
     (an inner layer on a 4-layer board, else the back) so ground exists on
     both sides the way a real board carries it; and
  3. stitches a tented, spacing-aware through-via from each ground pad down to
     the reference plane. Tenting (solder-mask over the via) is what keeps the
     via-in-pad from tripping mask-clearance DRC — the reason the earlier naive
     stitch failed. Spacing (skip a via that would sit too close to any existing
     drilled hole) is what keeps it clear of the 0.5mm hole_clearance rule.
KiCad then computes real connectivity: it reports how many ground pads are NOT
reached (0 = every ground pin on the plane) so the caller can verify or honestly
report the residual. Never fakes a connection: a pad we can't stitch without
breaking a fab rule is left stranded and counted, not forced.

Usage: <kicad-python> ground_plane.py <in.kicad_pcb> <out.kicad_pcb> <gnd.json> [hole_clearance_mm]
  gnd.json = ["U1.8", "U1.16", "C1.2", ...]  (COMP.PAD ground pins)
  hole_clearance_mm = the fab's hole-to-copper rule (default 0.5; HDI 0.4)
Prints one JSON line: {"assigned","unconnected","zones","stitched","skipped"}
"""
import math
import sys
import json
import pcbnew

inp, outp, gndf = sys.argv[1], sys.argv[2], sys.argv[3]
hole_clearance = float(sys.argv[4]) if len(sys.argv) > 4 else 0.5
gnd_pins = set(json.load(open(gndf)))

board = pcbnew.LoadBoard(inp)
gnd = pcbnew.NETINFO_ITEM(board, "GND")
board.Add(gnd)


def norm_ref(ref):
    # freerouting's DSN round-trip mangles "U1" -> "U1_source_component_0"; match
    # the original component name too.
    return ref.split("_source_component")[0] if "_source_component" in ref else ref


# 1. Assign GND to the ground pads and remember their centres for stitching.
assigned = 0
gnd_pads = []
for fp in board.GetFootprints():
    ref = fp.GetReference()
    nref = norm_ref(ref)
    for pad in fp.Pads():
        num = pad.GetNumber()
        if f"{ref}.{num}" in gnd_pins or f"{nref}.{num}" in gnd_pins:
            pad.SetNet(gnd)
            assigned += 1
            gnd_pads.append(pad.GetPosition())

# 2. Pick the reference plane layer: a dedicated inner layer on a 4-layer board,
#    else the back copper. The top pour bonds top-side ground pads directly; the
#    reference plane is where the stitched vias land.
copper = board.GetCopperLayerCount()
ref_layer_name = "In2.Cu" if copper >= 4 else "B.Cu"
ref_layer = board.GetLayerID(ref_layer_name)

bb = board.GetBoardEdgesBoundingBox()
inset = pcbnew.FromMM(0.5)
corners = [
    (bb.GetLeft() + inset, bb.GetTop() + inset),
    (bb.GetRight() - inset, bb.GetTop() + inset),
    (bb.GetRight() - inset, bb.GetBottom() - inset),
    (bb.GetLeft() + inset, bb.GetBottom() - inset),
]


def add_zone(layer_id):
    z = pcbnew.ZONE(board)
    z.SetLayer(layer_id)
    z.SetNet(gnd)
    z.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)  # solidly bond ground pads
    # Pour clearance MUST be at least the fab's hole_clearance rule: the pour
    # surrounds signal via holes, and a 0.2mm clearance under a 0.4mm HDI hole
    # rule was THE dominant residual DRC on dense boards (the pour hugged every
    # signal via hole ~0.2mm and tripped hole_clearance). pcbnew has no per-via
    # local-clearance API (PCB_VIA lacks SetLocalClearance), so the pour-wide
    # clearance is the lever — set it to the hole rule. Verified 86->59 on a dense
    # board with no connectivity regression; the only cost is slightly less pour
    # fill between very close traces, which a ground plane tolerates.
    z.SetLocalClearance(pcbnew.FromMM(max(0.2, hole_clearance)))
    o = z.Outline()
    o.NewOutline()
    for (x, y) in corners:
        o.Append(x, y)
    board.Add(z)
    return z


add_zone(board.GetLayerID("F.Cu"))
if ref_layer != board.GetLayerID("F.Cu"):
    add_zone(ref_layer)

# 3. Stitch a tented through-via from each ground pad down to the reference
#    plane. We only stitch where a real fab could drill it:
#    * skip if the via hole would sit closer than MIN_CENTER to another drilled
#      hole (signal vias / other stitch vias) — a hole-to-hole violation; and
#    * skip if the via hole would come within hole_clearance of OTHER-net copper
#      (e.g. the neighbouring pin of a 0.5mm-pitch QFN) — a hole-to-copper
#      violation. Dropping a through-via into a fine-pitch pad genuinely needs a
#      microvia/HDI process; we don't fake it, we skip and report it.
#    Tented both sides -> no mask aperture -> no mask-clearance error. A skipped
#    pad is left for the top pour to reach on its own; if it can't it shows up in
#    the unconnected count, honestly.
VIA_PAD = pcbnew.FromMM(0.5)
VIA_HOLE = pcbnew.FromMM(0.2)
VIA_HOLE_R = VIA_HOLE / 2
MIN_CENTER = pcbnew.FromMM(0.8)  # 0.2mm holes >=0.8mm apart -> >0.5mm edge gap
COPPER_KEEP = pcbnew.FromMM(hole_clearance) + VIA_HOLE_R  # via-centre -> other copper

hole_pts = []  # centres of every existing drilled hole (signal vias, etc.)
for t in board.GetTracks():
    if isinstance(t, pcbnew.PCB_VIA):
        hole_pts.append(t.GetPosition())

# Other-net pad copper (bounding boxes) the via hole must clear. Same-net (GND)
# copper is fine to touch.
#
# Compare NET CODES, not NETINFO_ITEM objects. `pad.GetNet() == gnd` compares two
# SWIG proxy objects and is ALWAYS False, so every ground pad fell through to
# other_pads -- and clears_copper() then measured each pad against ITS OWN
# bounding box at distance zero and skipped it. Guaranteed, on every pad, on
# every board: 39 boards on disk, 421 ground pads, `stitched: 0` every time.
# Via-in-pad stitching never once ran, and 108 of those pads were left
# unreached as a result.
GND_CODE = gnd.GetNetCode()
other_pads = []
for fp in board.GetFootprints():
    for pad in fp.Pads():
        if pad.GetNetCode() == GND_CODE:
            continue
        other_pads.append(pad.GetBoundingBox())

# The router's TRACKS are copper too. Checking only pads was enough while no via
# was ever placed; the moment stitching started working, vias landed on traces --
# 4 new hole_clearance violations and a new short on the first fixed board.
# Segments are kept as endpoints so the distance is point-to-SEGMENT, not to a
# bounding box: a diagonal trace's box is mostly empty and would reject legal
# spots while accepting illegal ones.
other_tracks = []
for t in board.GetTracks():
    if isinstance(t, pcbnew.PCB_VIA) or t.GetNetCode() == GND_CODE:
        continue
    other_tracks.append((t.GetStart(), t.GetEnd(), t.GetWidth()))


def seg_dist2(px, py, a, b):
    ax, ay, bx, by = a.x, a.y, b.x, b.y
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 == 0:
        return (px - ax) ** 2 + (py - ay) ** 2
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / float(L2)))
    cx, cy = ax + t * dx, ay + t * dy
    return (px - cx) ** 2 + (py - cy) ** 2


def clears_tracks(x, y, keep):
    for a, b, w in other_tracks:
        need = keep + w // 2
        if seg_dist2(x, y, a, b) < need * need:
            return False
    return True


def clears_copper(pos):
    # nearest distance from the via centre to any other-net PAD's bounding box
    # AND to any other-net TRACK, compared against the hole-to-copper keep-out.
    for bb2 in other_pads:
        dx = max(bb2.GetLeft() - pos.x, 0, pos.x - bb2.GetRight())
        dy = max(bb2.GetTop() - pos.y, 0, pos.y - bb2.GetBottom())
        if dx * dx + dy * dy < COPPER_KEEP * COPPER_KEEP:
            return False
    return clears_tracks(pos.x, pos.y, COPPER_KEEP)


stitched = 0
skipped = 0
min2 = MIN_CENTER * MIN_CENTER


def hole_ok(x, y):
    for h in hole_pts:
        dx = x - h.x
        dy = y - h.y
        if dx * dx + dy * dy < min2:
            return False
    return True


# A short GND track from the pad to an offset via must itself clear other-net
# copper, or the dog-bone trades an open net for a short. Sample along it.
# A TRACK obeys the CLEARANCE rule, not hole_clearance -- hole_clearance is a
# drill-to-copper rule and applies to the via, not to the copper leading to it.
# Using it here made the keep-out ~7x too big and every fanout candidate failed
# (`fanned: 0` on a board where 6 pads had legal spots 0.3-0.8mm away).
# HDI is 0.0635mm, standard 0.09mm; hole_clearance tells us which profile.
CLEARANCE = 0.0635 if hole_clearance <= 0.45 else 0.09
TRACK_W = pcbnew.FromMM(0.15)
TRACK_KEEP = pcbnew.FromMM(CLEARANCE) + TRACK_W // 2


def track_clears(a, b):
    steps = 8
    for i in range(steps + 1):
        x = a.x + (b.x - a.x) * i // steps
        y = a.y + (b.y - a.y) * i // steps
        for bb in other_pads:
            dx = max(bb.GetLeft() - x, 0, x - bb.GetRight())
            dy = max(bb.GetTop() - y, 0, y - bb.GetBottom())
            if dx * dx + dy * dy < TRACK_KEEP * TRACK_KEEP:
                return False
        # the dog-bone must not cross or crowd another net's trace either --
        # that trades an open net for a short, which is a worse fault
        if not clears_tracks(x, y, TRACK_KEEP):
            return False
    return True


# Where the via may sit relative to the pad. 0 is via-in-pad; the rest is a
# DOG-BONE FANOUT -- the standard way to get a fine-pitch pad down to a plane
# when the pad itself cannot take a drill. Measured on a real failing board:
# 8 of 14 ground pads accept a via at their centre, and ALL 14 accept one
# within 0.8mm. Without the offsets those last 6 are simply left open.
OFFSETS_MM = [0.0, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0]
DIRS = 16
fanned = 0
for pos in gnd_pads:
    placed = None
    for r_mm in OFFSETS_MM:
        if r_mm == 0.0:
            cands = [pos]
        else:
            r = pcbnew.FromMM(r_mm)
            cands = []
            for k in range(DIRS):
                a = 2.0 * math.pi * k / DIRS
                cands.append(pcbnew.VECTOR2I(int(pos.x + r * math.cos(a)),
                                             int(pos.y + r * math.sin(a))))
        for c in cands:
            if not hole_ok(c.x, c.y) or not clears_copper(c):
                continue
            if r_mm > 0.0 and not track_clears(pos, c):
                continue
            placed = (c, r_mm)
            break
        if placed:
            break
    if not placed:
        skipped += 1
        continue
    at, r_mm = placed
    via = pcbnew.PCB_VIA(board)
    via.SetViaType(pcbnew.VIATYPE_THROUGH)
    via.SetPosition(at)
    via.SetWidth(VIA_PAD)
    via.SetDrill(VIA_HOLE)
    via.SetNet(gnd)
    via.SetFrontTentingMode(pcbnew.TENTING_MODE_TENTED)
    via.SetBackTentingMode(pcbnew.TENTING_MODE_TENTED)
    board.Add(via)
    hole_pts.append(at)
    stitched += 1
    if r_mm > 0.0:
        # the dog-bone itself: pad -> via, on the pad's own layer, on GND
        t = pcbnew.PCB_TRACK(board)
        t.SetStart(pos)
        t.SetEnd(at)
        t.SetWidth(TRACK_W)
        t.SetLayer(pcbnew.F_Cu)
        t.SetNet(gnd)
        board.Add(t)
        fanned += 1

# Mounting-hole pour keepout. The zones use a 0.2mm local clearance for good
# ground coverage between traces, but that let the GND pour come within 0.2mm of
# the NPTH screw holes -- under the fab's hole_clearance rule (0.4mm HDI). That
# pour-to-hole gap was THE dominant residual DRC error across every dense board
# (the pour, not the router, tripped hole_clearance; e.g. 0.369mm vs 0.4mm, one
# error away from a clean board). Give each NPTH mounting hole its own local
# clearance so the filler keeps the pour a full hole_clearance + margin away from
# JUST the holes, without receding from every trace. Guarded: a pcbnew API drift
# must never crash the fill (that would break EVERY board), so on failure we log
# and pour as before.
mh_set = 0
try:
    mh_clear = pcbnew.FromMM(hole_clearance + 0.15)
    for fp in board.GetFootprints():
        for p in fp.Pads():
            if p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH:
                p.SetLocalClearance(mh_clear)
                mh_set += 1
except Exception as _e:
    mh_set = -1  # surfaced in the JSON; pour proceeds with the default clearance

pcbnew.ZONE_FILLER(board).Fill(board.Zones())
board.BuildConnectivity()
unconnected = board.GetConnectivity().GetUnconnectedCount(False)

pcbnew.SaveBoard(outp, board)
print(json.dumps({
    "assigned": assigned,
    "unconnected": unconnected,
    "zones": board.GetAreaCount(),
    "stitched": stitched, "fanned": fanned,
    "skipped": skipped,
    "mhKeepout": mh_set,
}))
