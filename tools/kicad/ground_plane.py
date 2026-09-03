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
other_pads = []
for fp in board.GetFootprints():
    for pad in fp.Pads():
        if pad.GetNet() == gnd:
            continue
        other_pads.append(pad.GetBoundingBox())


def clears_copper(pos):
    # nearest distance from the via centre to any other-net pad's bounding box,
    # compared against the hole-to-copper keep-out.
    for bb2 in other_pads:
        dx = max(bb2.GetLeft() - pos.x, 0, pos.x - bb2.GetRight())
        dy = max(bb2.GetTop() - pos.y, 0, pos.y - bb2.GetBottom())
        if dx * dx + dy * dy < COPPER_KEEP * COPPER_KEEP:
            return False
    return True


stitched = 0
skipped = 0
min2 = MIN_CENTER * MIN_CENTER
for pos in gnd_pads:
    too_close = False
    for h in hole_pts:
        dx = pos.x - h.x
        dy = pos.y - h.y
        if dx * dx + dy * dy < min2:
            too_close = True
            break
    if too_close or not clears_copper(pos):
        skipped += 1
        continue
    via = pcbnew.PCB_VIA(board)
    via.SetViaType(pcbnew.VIATYPE_THROUGH)
    via.SetPosition(pos)
    via.SetWidth(VIA_PAD)
    via.SetDrill(VIA_HOLE)
    via.SetNet(gnd)
    via.SetFrontTentingMode(pcbnew.TENTING_MODE_TENTED)
    via.SetBackTentingMode(pcbnew.TENTING_MODE_TENTED)
    board.Add(via)
    hole_pts.append(pos)
    stitched += 1

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
    "stitched": stitched,
    "skipped": skipped,
    "mhKeepout": mh_set,
}))
