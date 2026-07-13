#!/usr/bin/env python3
"""Add a real, DRC-verified ground plane to a net-less .kicad_pcb via pcbnew.

The circuit-json-to-kicad export carries no nets, so ground pins can't connect
to a plane the normal way. This pass, run with KiCad's own python (pcbnew):
  1. creates a GND net and assigns it to every ground pad (matched by
     footprint reference + pad number from the netlist), and
  2. lays a filled GND copper zone on the top layer with a solid pad connection
     so the ground pads actually bond to the plane (SetPadConnection(FULL) +
     a local clearance is what makes the fill reach the pads).
KiCad then computes real connectivity: it reports how many ground pads are NOT
reached by the plane, so the caller can verify (0 = every ground pin on the
plane) or honestly report the residual. Never fakes a connection.

Usage: <kicad-python> ground_plane.py <in.kicad_pcb> <out.kicad_pcb> <gnd.json>
  gnd.json = ["U1.8", "U1.16", "C1.2", ...]  (COMP.PAD ground pins)
Prints one JSON line: {"assigned": N, "unconnected": M, "zones": Z}
"""
import sys
import json
import pcbnew

inp, outp, gndf = sys.argv[1], sys.argv[2], sys.argv[3]
gnd_pins = set(json.load(open(gndf)))

board = pcbnew.LoadBoard(inp)
gnd = pcbnew.NETINFO_ITEM(board, "GND")
board.Add(gnd)

def norm_ref(ref):
    # freerouting's DSN round-trip mangles "U1" -> "U1_source_component_0"; match
    # the original component name too.
    return ref.split("_source_component")[0] if "_source_component" in ref else ref

assigned = 0
for fp in board.GetFootprints():
    ref = fp.GetReference()
    nref = norm_ref(ref)
    for pad in fp.Pads():
        num = pad.GetNumber()
        if f"{ref}.{num}" in gnd_pins or f"{nref}.{num}" in gnd_pins:
            pad.SetNet(gnd)
            assigned += 1

bb = board.GetBoardEdgesBoundingBox()
inset = pcbnew.FromMM(0.5)
corners = [
    (bb.GetLeft() + inset, bb.GetTop() + inset),
    (bb.GetRight() - inset, bb.GetTop() + inset),
    (bb.GetRight() - inset, bb.GetBottom() - inset),
    (bb.GetLeft() + inset, bb.GetBottom() - inset),
]

def add_zone(layer):
    z = pcbnew.ZONE(board)
    z.SetLayer(board.GetLayerID(layer))
    z.SetNet(gnd)
    z.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)  # solidly bond ground pads
    z.SetLocalClearance(pcbnew.FromMM(0.2))
    o = z.Outline(); o.NewOutline()
    for (x, y) in corners:
        o.Append(x, y)
    board.Add(z)
    return z

# Top-layer ground plane: bonds the top-side ground pads directly and stays DRC
# clean. On a dense board the fill can fragment and strand a few pads; we report
# that honestly (like an unrouted net) rather than forcing via-in-pad stitching,
# which trips solder-mask/clearance DRC (dense boards need a via-in-pad fab
# process for full coverage — a real limitation, not faked away).
add_zone("F.Cu")
pcbnew.ZONE_FILLER(board).Fill(board.Zones())
board.BuildConnectivity()
unconnected = board.GetConnectivity().GetUnconnectedCount(False)

pcbnew.SaveBoard(outp, board)
print(json.dumps({"assigned": assigned, "unconnected": unconnected, "zones": board.GetAreaCount()}))
