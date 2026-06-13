"""Placement engine v3 — measured courtyards + connectivity-driven.

Improvements over v2 (which caused router trial-and-error):
- Pitches DERIVED from measured courtyard sizes + margin, never hardcoded.
- TPIC sink drivers placed by their DRAIN nets: each sits atop the relay
  tree it sinks (channel map v2 locality), reed-bank TPICs by the bank.
- Relays grouped per tree by their coil nets, not by ref order.
- Board 200 x 160 (relay pitch from real courtyards needs the height).
- Run scripts/placement_score.py after this; gate must PASS before routing.

Run with KiCad's bundled python.
"""
import re

import pcbnew

BOARD = "elec/layout/rev-a-routed.kicad_pcb"
X0, Y0, BW, BH = 40.0, 40.0, 200.0, 175.0
MARGIN = 0.6  # courtyard-to-courtyard spacing, mm

# 4-layer stackup: In1 = lv plane, In2 = coil rail; both routable
# (zones pour around tracks)
b = pcbnew.LoadBoard(BOARD)
b.SetCopperLayerCount(4)
fps = list(b.GetFootprints())

# Net census BEFORE any board mutation: KiCad 10.0.1 swig proxies go stale
# after Remove/Add calls, and GetNetsByName() returns a dead SwigPyObject.
from collections import Counter
pc = Counter()
net_codes = {}
for _fp in fps:
    for _pad in _fp.Pads():
        pc[str(_pad.GetNetname())] += 1
        net_codes.setdefault(str(_pad.GetNetname()), _pad.GetNetCode())
# Zones list also captured pre-mutation: b.Zones() SEGFAULTS post-Remove/Add
# under KiCad 10.0.1 standalone python.
zones_pre = list(b.Zones())

def mm(v):
    return pcbnew.FromMM(v)

def place(fp, x, y, rot=0):
    fp.SetOrientationDegrees(rot)
    fp.SetPosition(pcbnew.VECTOR2I(mm(X0 + x), mm(Y0 + y)))

def cy_size(fp, rot=0):
    """bounding size w, h in mm at the given rotation"""
    old = fp.GetOrientationDegrees()
    fp.SetOrientationDegrees(rot)
    bb = fp.GetBoundingBox(False, False)
    fp.SetOrientationDegrees(old)
    return pcbnew.ToMM(bb.GetWidth()), pcbnew.ToMM(bb.GetHeight())

def pad_nets(fp):
    return {str(p.GetNetname()) for p in fp.Pads()}

by_lib = {}
for fp in fps:
    by_lib.setdefault(str(fp.GetFPID().GetLibItemName()), []).append(fp)

def natkey(fp):
    return int(re.sub(r"[^0-9]", "", fp.GetReference()) or 0)

PROBES = ["p1", "p2", "p3", "p4", "kfp", "kfn", "ksp", "ksn"]

# ---- relays grouped per tree by coil net (sel_<probe>.) ----------------------
relays = by_lib.get("RELAY-SMD_G6K-2F-X-XX", [])
rw, rh = cy_size(relays[0], 90)
r_pitch_x = rw + MARGIN + 0.4
r_pitch_y = rh + MARGIN
LANE_ORDER = ["bank", "scope_a", "scope_b", "daq_1", "daq_2",
              "logic_1", "logic_2", "pwr", "dmm_hi", "dmm_lo", "gnd"]
G6K_LANES = ["bank", "scope_a", "scope_b", "daq_1", "daq_2",
             "logic_1", "logic_2", "pwr"]
def classify(fp):
    """tree, lane from the coil sink net: sink_<t>_<lane> alias OR
    drain<N> alias decoded via channel map v2 (drains 1-64 = G6K,
    t=(N-1)//8, lane=G6K_LANES[(N-1)%8]; 65-88 reeds; 89-91 ref)."""
    for n in pad_nets(fp):
        m = re.search(r"matrix\.sel_(p\d|kfp|kfn|ksp|ksn)\.k_(\w+?)-", n)
        if m:
            return m.group(1), m.group(2)
    for n in pad_nets(fp):
        m = re.match(r"sink_(p\d|kfp|kfn|ksp|ksn)_(\w+)", n)
        if m:
            return m.group(1), m.group(2)
        m = re.match(r"(?:ctl-)?drain(\d+)$", n)
        if m:
            N = int(m.group(1))
            if 1 <= N <= 64:
                return PROBES[(N - 1) // 8], G6K_LANES[(N - 1) % 8]
            if 65 <= N <= 88:
                r = N - 65
                return PROBES[r // 3], ["dmm_hi", "dmm_lo", "gnd"][r % 3]
            return None, "ref"
    return None, None

tree_of, lane_of = {}, {}
for fp in relays:
    t, l = classify(fp)
    if t:
        tree_of[fp.GetReference()] = t
        lane_of[fp.GetReference()] = l
trees = {p: [] for p in PROBES}
unmatched = []
for fp in relays:
    t = tree_of.get(fp.GetReference())
    if t is None:
        unmatched.append(fp.GetReference())
        t = "p1"
    trees[t].append(fp)
if unmatched:
    print("WARNING unmatched relays:", unmatched)
print("tree sizes:", {p: len(v) for p, v in trees.items()})
TREE_X0, TREE_Y0 = 44.0, 52.0
for ti, p in enumerate(PROBES):
    col = sorted(trees[p],
                 key=lambda f: LANE_ORDER.index(lane_of.get(f.GetReference(), "pwr")))
    for ri, fp in enumerate(col):
        place(fp, TREE_X0 + ti * r_pitch_x, TREE_Y0 + ri * r_pitch_y, 90)
relay_bottom = TREE_Y0 + 7 * r_pitch_y + rh / 2

# ---- TPIC sinks: net-driven — atop the tree they sink -------------------------
soics = sorted(by_lib.get("SOIC-20_L13.0-W7.6-P1.27-LS10.3-BL", []), key=natkey)
sw, sh = cy_size(soics[0], 90)
sink_y = TREE_Y0 - r_pitch_y / 2 - sh / 2 - 2.0
# net -> tree map from classified relays (coil sink nets are 2-pad nets:
# relay coil_n <-> TPIC drain, so shared net = served tree)
net_tree = {}
for fp in relays:
    t = tree_of.get(fp.GetReference())
    if t:
        for n in pad_nets(fp):
            net_tree.setdefault(n, t)
reed_lib = by_lib.get("RELAY-TH_SIP-1A05", [])
reed_nets = set()
for fp in reed_lib:
    reed_nets |= pad_nets(fp)
reed_sinks = []
for fp in soics:
    votes = {}
    for n in pad_nets(fp):
        t = net_tree.get(n)
        if t:
            votes[t] = votes.get(t, 0) + 1
    if votes:
        ti = PROBES.index(max(votes, key=votes.get))
        row_y = sink_y - (sh + 1.5) * (ti % 2)
        place(fp, TREE_X0 + ti * r_pitch_x, row_y, 90)
    else:
        reed_sinks.append(fp)
print("tree sinks:", 12 - len(reed_sinks), "| reed/ref sinks:", len(reed_sinks))

# ---- reed bank: measured pitch, 3 rows of 9 + ref row --------------------------
reeds = sorted(by_lib.get("RELAY-TH_SIP-1A05", []), key=natkey)
dw, dh = cy_size(reeds[0], 0)
reed_y0 = relay_bottom + dh / 2 + 2.0
matrix_reeds, ref_reeds = [], []
for fp in reeds:
    t, l = classify(fp)
    if t:
        matrix_reeds.append(fp)
    else:
        ref_reeds.append(fp)
for i, fp in enumerate(matrix_reeds):
    row, col = divmod(i, 8)
    place(fp, 14 + dw / 2 + col * (dw + MARGIN), reed_y0 + row * (dh + MARGIN))
for k, fp in enumerate(ref_reeds):
    place(fp, 14 + dw / 2 + k * (dw + MARGIN), reed_y0 + 3 * (dh + MARGIN))
# reed-bank TPICs (sr9-12) right of the bank
for i, fp in enumerate(reed_sinks):
    place(fp, 189, 108 + i * 15.5, 0)

# ---- protection channels west ----------------------------------------------------
prot_libs = [("F0805", 12.0), ("SOT-23-3_L2.9-W1.6-P1.90-LS2.8-BR", 18.0),
             ("SMA_L4.4-W2.6-LS5.0-BI", 25.0)]
for lib, x in prot_libs:
    for i, fp in enumerate(sorted(by_lib.get(lib, []), key=natkey)):
        place(fp, x, 52 + i * 9)
comps = []
for lib, items in by_lib.items():
    if "MSOP" in lib or "VSSOP" in lib or "DGK" in lib:
        comps += items
for i, fp in enumerate(sorted(comps, key=natkey)[:8]):
    place(fp, 34, 52 + i * 9)

# ---- power row north ----------------------------------------------------------------
px = 8.0
power_items = []
for lib, items in sorted(by_lib.items()):
    if lib.startswith(("SMB_", "SOIC-8", "IND", "L_")) or "SON" in lib or "RLT" in lib:
        power_items += sorted(items, key=natkey)
for fp in power_items:
    w, h = cy_size(fp, 0)
    place(fp, px + w / 2, 7)
    px += w + MARGIN + 1.5

# ---- Pico + supervisors east ---------------------------------------------------------
for fp in by_lib.get("RaspberryPi_Pico_SMD_HandSolder", []):
    place(fp, 170, 85)
sot5 = []
for lib, items in by_lib.items():
    if "SOT-23-5" in lib or "SOT-23-6" in lib or "SOT-23-8" in lib:
        sot5 += items
for i, fp in enumerate(sorted(sot5, key=natkey)):
    place(fp, 152, 36 + i * 7)

# ---- connectors ------------------------------------------------------------------------
hdr2 = sorted(by_lib.get("PinHeader_1x02_P2.54mm_Vertical", []), key=natkey)
for fp, (x, y) in zip(hdr2, [(120, 5), (193, 18), (193, 30), (193, 168)]):
    place(fp, x, y)
for fp in by_lib.get("PinHeader_1x04_P2.54mm_Vertical", []):
    place(fp, 193, 48)
for fp in by_lib.get("PinHeader_1x08_P2.54mm_Vertical", []):
    place(fp, 193, 72)
for fp in by_lib.get("SEAF14", []):
    place(fp, 5, 110, 90)

# ---- leftovers: measured rows in the free mid strip ------------------------------------
leftovers = []
for fp in fps:
    p = fp.GetPosition()
    inside = mm(X0) <= p.x <= mm(X0 + BW) and mm(Y0) <= p.y <= mm(Y0 + BH)
    if not inside:
        leftovers.append(fp)
lx, ly = 126.0, 8.0
for fp in sorted(leftovers, key=natkey):
    w, h = cy_size(fp, 0)
    if lx + w > 185:
        lx, ly = 126.0, ly + 5.2
    place(fp, lx + w / 2, ly)
    lx += w + MARGIN

# ---- outline + holes ----------------------------------------------------------------------
for d in list(b.GetDrawings()):
    if d.GetLayer() == pcbnew.Edge_Cuts:
        b.Remove(d)
rect = pcbnew.PCB_SHAPE(b)
rect.SetShape(pcbnew.SHAPE_T_RECT)
rect.SetStart(pcbnew.VECTOR2I(mm(X0), mm(Y0)))
rect.SetEnd(pcbnew.VECTOR2I(mm(X0 + BW), mm(Y0 + BH)))
rect.SetLayer(pcbnew.Edge_Cuts)
rect.SetWidth(mm(0.15))
b.Add(rect)
for cx, cy in ((5, 5), (BW - 5, 5), (5, BH - 5), (BW - 5, BH - 5)):
    c = pcbnew.PCB_SHAPE(b)
    c.SetShape(pcbnew.SHAPE_T_CIRCLE)
    c.SetCenter(pcbnew.VECTOR2I(mm(X0 + cx), mm(Y0 + cy)))
    c.SetEnd(pcbnew.VECTOR2I(mm(X0 + cx + 1.6), mm(Y0 + cy)))
    c.SetLayer(pcbnew.Edge_Cuts)
    c.SetWidth(mm(0.15))
    b.Add(c)

# ---- zones -----------------------------------------------------------------------------------
# (net census pc/net_codes computed at the top of the script, pre-mutation)
gnd_name = "lv"
coil_name = max((n for n in pc if "coil_bus" in n), key=lambda n: pc[n], default=None)

def add_zone(name, layer):
    if name is None or name not in net_codes:
        return
    z = pcbnew.ZONE(b)
    z.SetLayer(layer)
    z.SetNetCode(net_codes[name])
    chain = pcbnew.SHAPE_LINE_CHAIN()
    for x, y in [(X0, Y0), (X0 + BW, Y0), (X0 + BW, Y0 + BH), (X0, Y0 + BH)]:
        chain.Append(mm(x), mm(y))
    chain.SetClosed(True)
    z.Outline().AddOutline(chain)
    z.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)
    z.SetMinThickness(mm(0.2))
    b.Add(z)

# KiCad 10.0.1 standalone swig: objects created/fetched after Remove/Add
# mutations have dead method dispatch (Outline() etc). Existing zones are
# full-board pours with unchanged nets, so KEEP them instead of
# remove-and-recreate; only create zones on a board that has none.
if not zones_pre:
    add_zone(gnd_name, pcbnew.In1_Cu)
    add_zone(gnd_name, pcbnew.B_Cu)
    add_zone(coil_name, pcbnew.In2_Cu)

pcbnew.SaveBoard(BOARD, b)
print("v3: relay pitch {:.1f}x{:.1f}, reed pitch {:.1f}x{:.1f}, zones: {} / {}".format(
    r_pitch_x, r_pitch_y, dw + MARGIN, dh + MARGIN, gnd_name, coil_name))
