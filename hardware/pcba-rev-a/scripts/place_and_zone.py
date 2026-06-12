"""Place the atopile-generated board per the DFM floorplan, add the
200x146 outline + mounting holes, and pour GND/power zones.

Run with KiCad's bundled python:
/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3 scripts/place_and_zone.py
"""
import sys

import pcbnew

BOARD = "elec/layout/rev-a-routed.kicad_pcb"
X0, Y0, BW, BH = 40.0, 40.0, 200.0, 146.0

b = pcbnew.LoadBoard(BOARD)
fps = list(b.GetFootprints())

def mm(v):
    return pcbnew.FromMM(v)

def place(fp, x, y, rot=0):
    fp.SetPosition(pcbnew.VECTOR2I(mm(X0 + x), mm(Y0 + y)))
    fp.SetOrientationDegrees(rot)

by_lib = {}
for fp in fps:
    by_lib.setdefault(str(fp.GetFPID().GetLibItemName()), []).append(fp)
for v in by_lib.values():
    v.sort(key=lambda f: f.GetReference())

# --- relays: 8 trees x 8 G6K (ref order follows tree order) ------------------
relays = by_lib.get("RELAY-SMD_G6K-2F-X-XX", [])
for i, fp in enumerate(relays):
    tree, row = divmod(i, 8)
    place(fp, 42 + tree * 13, 44 + row * 9.75, 90)

# --- reeds: 24 matrix (8x3) + 3 reference column ------------------------------
reeds = by_lib.get("RELAY-TH_SIP-1A05", [])
for i, fp in enumerate(reeds[:24]):
    row, col = divmod(i, 8)
    place(fp, 26 + col * 20.9, 121.5 + row * 8)
for k, fp in enumerate(reeds[24:27]):
    place(fp, 144, 56 + k * 21, 90)

# --- sink drivers --------------------------------------------------------------
soics20 = by_lib.get("SOIC-20_L13.0-W7.6-P1.27-LS10.3-BL", [])
for i, fp in enumerate(soics20):
    place(fp, 30 + i * 12.4, 26)

# --- SOIC-8s: TPS54331, INA219? (INA219 is SOT-23-8) --------------------------
soic8 = by_lib.get("SOIC-8_L4.9-W3.9-P1.27-LS6.0-BL", [])
for i, fp in enumerate(soic8):
    place(fp, 25 + i * 10, 8)

# --- protection channels: SOT-23 (BAV99) + SMA (TVS) + comparators ------------
sots = by_lib.get("SOT-23-3_L2.9-W1.6-P1.90-LS2.8-BR", [])
for i, fp in enumerate(sots):
    place(fp, 16, 44 + i * 9)
smas = by_lib.get("SMA_L4.4-W2.6-LS5.0-BI", [])
for i, fp in enumerate(smas):
    place(fp, 22, 44 + i * 9)
ptcs = by_lib.get("F0805", [])
for i, fp in enumerate(ptcs):
    place(fp, 11, 44 + i * 9)

# comparators (MSOP-8 / VSSOP) — find by value/ref among remaining libs
comps = []
for lib, items in by_lib.items():
    if "MSOP" in lib or "VSSOP" in lib or "DGK" in lib:
        comps += items
for i, fp in enumerate(sorted(comps, key=lambda f: f.GetReference())[:8]):
    place(fp, 30, 44 + i * 9)

# --- power region: SMB TVS, regulators, inductors, shunt ----------------------
for lib, items in sorted(by_lib.items()):
    if lib.startswith("SMB_"):
        for fp in items:
            place(fp, 17, 5)
    if "SON" in lib or "DSG" in lib or "RLT" in lib or "WSON" in lib:
        for i, fp in enumerate(items):
            place(fp, 50 + i * 8, 8)
    if lib.startswith("IND") or "L_" in lib[:2] or "Inductor" in lib:
        for i, fp in enumerate(items):
            place(fp, 60 + i * 10, 5)

# --- Pico + supervisors --------------------------------------------------------
for fp in by_lib.get("RaspberryPi_Pico_SMD_HandSolder", []):
    place(fp, 160, 78)
sot5 = []
for lib, items in by_lib.items():
    if "SOT-23-5" in lib or "SOT-23-6" in lib:
        sot5 += items
for i, fp in enumerate(sorted(sot5, key=lambda f: f.GetReference())):
    place(fp, 143 + (i % 2) * 8, 33 + (i // 2) * 7)

# --- connectors ------------------------------------------------------------------
hdr2 = by_lib.get("PinHeader_1x02_P2.54mm_Vertical", [])
hdr2_pos = [(118, 5, 0), (190, 18, 0), (190, 32, 0), (190, 100, 0)]
for fp, (x, y, r) in zip(hdr2, hdr2_pos):
    place(fp, x, y, r)
for fp in by_lib.get("PinHeader_1x04_P2.54mm_Vertical", []):
    place(fp, 190, 54)
for fp in by_lib.get("PinHeader_1x08_P2.54mm_Vertical", []):
    place(fp, 190, 74)
for fp in by_lib.get("SEAF14", []):
    place(fp, 7, 75, 90)

# --- passives: spread leftovers near power/protection --------------------------
leftover_r = (by_lib.get("R0402", []) + by_lib.get("R0603", []) +
              by_lib.get("C0603", []) + by_lib.get("R1206", []))
for i, fp in enumerate(leftover_r):
    if fp.GetPosition().x > mm(X0 + BW) or fp.GetPosition().x < mm(X0):
        place(fp, 36 + (i % 16) * 4, 14 + (i // 16) * 5)

# any footprint still outside the outline: park it in the power strip
for fp in fps:
    p = fp.GetPosition()
    if not (mm(X0) <= p.x <= mm(X0 + BW) and mm(Y0) <= p.y <= mm(Y0 + BH)):
        place(fp, 100 + (hash(fp.GetReference()) % 40), 16)

# --- board outline + mounting holes ---------------------------------------------
# clear existing Edge.Cuts
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

# --- zones: GND on In1 + B.Cu, coil rail on In2 ---------------------------------
def find_net(*cands):
    nets = b.GetNetsByName()
    for name in nets:
        for c in cands:
            if c.lower() in str(name).lower():
                return nets[name]
    return None

gnd = find_net("gnd", "lv")
coil = find_net("v5_coil", "coil")
def add_zone(net, layer):
    if net is None:
        return
    z = pcbnew.ZONE(b)
    z.SetLayer(layer)
    z.SetNetCode(net.GetNetCode())
    pts = [(X0, Y0), (X0 + BW, Y0), (X0 + BW, Y0 + BH), (X0, Y0 + BH)]
    chain = pcbnew.SHAPE_LINE_CHAIN()
    for x, y in pts:
        chain.Append(mm(x), mm(y))
    chain.SetClosed(True)
    z.Outline().AddOutline(chain)
    z.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL)
    b.Add(z)

add_zone(gnd, pcbnew.In1_Cu)
add_zone(gnd, pcbnew.B_Cu)
add_zone(coil, pcbnew.In2_Cu)

pcbnew.SaveBoard(BOARD, b)
print("placed {} footprints, outline + holes + zones written".format(len(fps)))
print("GND net:", gnd.GetNetname() if gnd else "NOT FOUND",
      "| coil net:", coil.GetNetname() if coil else "NOT FOUND")
