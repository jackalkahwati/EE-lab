"""Via-stitch isolated pads to their power/ground plane.

Power and ground nets are served by a copper plane (an inner-layer zone), but an
SMD pad on an outer layer is only actually connected if a via drops from it into
that plane. flroute leaves these as islands, so KiCad DRC reports them as
unconnected even though a zone "serves" the net (the false "routed via zone").

This pass reads the DRC unconnected_items, and for every isolated PAD whose net
has a plane zone, places a through-via at the pad centre so it reaches the plane.
Vias are kept modest (<=0.45/0.20 mm) so via-in-pad stays clearance-clean on
small parts. Refill zones + re-DRC after to confirm.

  <kicad-python3> stitch_to_plane.py <board.kicad_pcb> <drc.json>

Prints "STITCHED <n>". The KiCad 10.0.1 standalone swig interpreter may segfault
at teardown AFTER a clean save, so callers must key on the sentinel.
"""
import json
import re
import sys

import pcbnew

board_path, drc_path = sys.argv[1], sys.argv[2]
b = pcbnew.LoadBoard(board_path)

# only nets that actually have a zone (plane) can be via-stitched to a plane
zone_nets = {z.GetNetCode() for z in b.Zones() if z.GetNetCode() > 0}

# collect the unconnected PAD sites from the DRC report: (netname, x_mm, y_mm)
drc = json.load(open(drc_path))
pad_re = re.compile(r"Pad \S+ \[(.+?)\] of")
sites = []  # (netname, x_mm, y_mm)
for u in drc.get("unconnected_items", []):
    for it in u.get("items", []):
        m = pad_re.search(it.get("description", ""))
        if not m:
            continue
        sites.append((m.group(1), it["pos"]["x"], it["pos"]["y"]))

TOL = pcbnew.FromMM(0.12)  # match a DRC site to a real pad within 0.12 mm

# via geometry: use the board's own via size so the via is design-rule compliant
# (matching its existing vias). Using anything smaller trips drill/diameter rules.
dsn = b.GetDesignSettings()
via_d = dsn.GetCurrentViaSize() or pcbnew.FromMM(0.6)
via_k = dsn.GetCurrentViaDrill() or pcbnew.FromMM(0.3)

placed = 0
seen = set()
for net, sx, sy in sites:
    sxn, syn = pcbnew.FromMM(sx), pcbnew.FromMM(sy)
    # find the pad on this net nearest the DRC site
    best = None
    best_d2 = None
    for fp in b.GetFootprints():
        for pad in fp.Pads():
            if pad.GetNetCode() not in zone_nets:
                continue
            if pad.GetNetname() != net:
                continue
            p = pad.GetPosition()
            d2 = (p.x - sxn) ** 2 + (p.y - syn) ** 2
            if best_d2 is None or d2 < best_d2:
                best_d2, best = d2, pad
    if best is None or best_d2 is None or best_d2 > TOL * TOL:
        continue
    pos = best.GetPosition()
    nc = best.GetNetCode()
    key = (nc, pos.x, pos.y)
    if key in seen:
        continue
    seen.add(key)
    via = pcbnew.PCB_VIA(b)
    via.SetPosition(pos)
    via.SetViaType(pcbnew.VIATYPE_THROUGH)
    via.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
    via.SetWidth(int(via_d))
    via.SetDrill(int(via_k))
    via.SetNetCode(nc)
    b.Add(via)
    placed += 1

b.Save(board_path)
print("STITCHED %d" % placed)
sys.stdout.flush()
