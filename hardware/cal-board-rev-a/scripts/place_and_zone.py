"""Placement engine — FL-1 calibration board Rev A.

Strategy: probe pads in a regular 10 mm pitch grid (3 rows of 8 / 7 / 8),
passives placed between rows near the pads they serve, EEPROM cluster in
the bottom-right corner, fiducials at three corners.

Run with KiCad bundled python AFTER `ato build` has synced the netlist:
  <kicad-python3> scripts/place_and_zone.py
Gate: scripts/placement_score.py must PASS before routing.
"""
import re
import pcbnew

BOARD  = "elec/layout/cal-rev-a.kicad_pcb"
X0, Y0 = 40.0, 40.0   # board origin offset in KiCad coordinates
BW, BH = 90.0, 80.0   # board width, height in mm
MARGIN = 0.5           # courtyard-to-courtyard minimum spacing

b   = pcbnew.LoadBoard(BOARD)
b.SetCopperLayerCount(4)
fps = list(b.GetFootprints())

# net census (must happen before any Remove/Add mutations)
from collections import Counter
pc        = Counter()
net_codes = {}
for _fp in fps:
    for _pad in _fp.Pads():
        pc[str(_pad.GetNetname())] += 1
        net_codes.setdefault(str(_pad.GetNetname()), _pad.GetNetCode())
zones_pre = list(b.Zones())


def mm(v):
    return pcbnew.FromMM(v)


def place(fp, x, y, rot=0):
    fp.SetOrientationDegrees(rot)
    fp.SetPosition(pcbnew.VECTOR2I(mm(X0 + x), mm(Y0 + y)))


def cy_size(fp, rot=0):
    old = fp.GetOrientationDegrees()
    fp.SetOrientationDegrees(rot)
    bb = fp.GetBoundingBox(False, False)
    fp.SetOrientationDegrees(old)
    return pcbnew.ToMM(bb.GetWidth()), pcbnew.ToMM(bb.GetHeight())


def natkey(fp):
    return int(re.sub(r"[^0-9]", "", fp.GetReference()) or 0)


by_lib = {}
for fp in fps:
    by_lib.setdefault(str(fp.GetFPID().GetLibItemName()), []).append(fp)


# ---- test pads: 3 rows, 10 mm pitch, origin at (10, 15) ----------------------
# Row 1: TP01–TP08  y = 15 mm
# Row 2: TP09–TP16  y = 35 mm
# Row 3: TP17–TP23  y = 55 mm
pad_fps = sorted(
    [fp for fp in fps if fp.GetReference().startswith("TP")],
    key=natkey,
)
ROW_Y   = [15.0, 35.0, 55.0]
ROW_X0  = 10.0
PAD_PITCH = 10.0

for i, fp in enumerate(pad_fps):
    row  = i // 8
    col  = i % 8
    if row >= len(ROW_Y):
        row = len(ROW_Y) - 1
    place(fp, ROW_X0 + col * PAD_PITCH, ROW_Y[row])

print(f"placed {len(pad_fps)} test pads")

# ---- precision resistors: between rows 1 and 2, near their pad pair ---------
# R10 near TP04/05 (col 2,3 → x=30,40), R1K near TP06/07 (col 4,5 → x=50,60)
# R100K near TP08/TP09 (col 6,7 / row-1,row-2 → x=70,80 / 20,30)
r_prec = sorted(
    [fp for fp in fps if fp.GetReference().startswith("R")
     and "ARG" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
r_prec_x = [30.0, 50.0, 70.0]
for i, fp in enumerate(r_prec[:3]):
    place(fp, r_prec_x[i], 25.0)

# ---- diodes: between rows 2 and 3 -------------------------------------------
diodes = sorted(
    [fp for fp in fps if fp.GetReference().startswith("D")],
    key=natkey,
)
diode_x = [30.0, 50.0]
for i, fp in enumerate(diodes[:2]):
    place(fp, diode_x[i], 45.0)

# ---- LED + R_LED: near TP14/15 (col 5,6 row-2 → x=60,70) -------------------
leds = [fp for fp in fps if fp.GetReference().startswith("LED")]
for fp in leds:
    place(fp, 62.0, 45.0)

r_leds = sorted(
    [fp for fp in fps if fp.GetReference().startswith("R")
     and "ARG" not in str(fp.GetFPID().GetLibItemName())
     and "R_RC" not in fp.GetReference()],
    key=natkey,
)
if r_leds:
    place(r_leds[0], 70.0, 45.0)

# ---- RC network near TP16/17 ------------------------------------------------
r_rcs = [fp for fp in fps if "RC" in fp.GetReference() and fp.GetReference().startswith("R")]
c_rcs = [fp for fp in fps if fp.GetReference().startswith("C")]
if r_rcs:
    place(r_rcs[0], 15.0, 65.0)
if c_rcs:
    place(c_rcs[0], 25.0, 65.0)

# ---- EEPROM cluster: bottom-right -------------------------------------------
eeproms = [fp for fp in fps if fp.GetReference().startswith("U")]
for fp in eeproms:
    place(fp, 75.0, 68.0)

# I2C pull-ups + decoupling cap near EEPROM
r_pullups = sorted(
    [fp for fp in fps if fp.GetReference().startswith("R")
     and "ARG" not in str(fp.GetFPID().GetLibItemName())
     and "LED" not in fp.GetReference()
     and "RC" not in fp.GetReference()],
    key=natkey,
)
for i, fp in enumerate(r_pullups[:2]):
    place(fp, 63.0 + i * 6, 68.0)
# decoupling cap
rem_caps = [fp for fp in fps if fp.GetReference().startswith("C") and fp not in c_rcs]
if rem_caps:
    place(rem_caps[0], 75.0, 62.0)

# ---- fiducials: three board corners -----------------------------------------
fids = sorted([fp for fp in fps if fp.GetReference().startswith("FID")], key=natkey)
fid_positions = [(10.0, 10.0), (80.0, 10.0), (10.0, 70.0)]
for fp, (x, y) in zip(fids, fid_positions):
    place(fp, x, y)

# ---- board outline + mounting holes -----------------------------------------
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

# M3 mounting holes at four corners (3.2 mm drill, 3.5 mm pad)
for cx, cy in ((5.0, 5.0), (BW - 5.0, 5.0), (5.0, BH - 5.0), (BW - 5.0, BH - 5.0)):
    h = pcbnew.PCB_SHAPE(b)
    h.SetShape(pcbnew.SHAPE_T_CIRCLE)
    h.SetCenter(pcbnew.VECTOR2I(mm(X0 + cx), mm(Y0 + cy)))
    h.SetEnd(pcbnew.VECTOR2I(mm(X0 + cx + 1.6), mm(Y0 + cy)))
    h.SetLayer(pcbnew.Edge_Cuts)
    h.SetWidth(mm(0.15))
    b.Add(h)

# ---- GND plane on In1 -------------------------------------------------------
gnd_name = next((n for n in pc if n.lower() in ("gnd", "lv", "gnd_ref")), None)
if gnd_name and not zones_pre:
    z = pcbnew.ZONE(b)
    z.SetLayer(pcbnew.In1_Cu)
    z.SetNetCode(net_codes[gnd_name])
    chain = pcbnew.SHAPE_LINE_CHAIN()
    for x, y in [(X0, Y0), (X0 + BW, Y0), (X0 + BW, Y0 + BH), (X0, Y0 + BH)]:
        chain.Append(mm(x), mm(y))
    chain.SetClosed(True)
    z.Outline().AddOutline(chain)
    z.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)
    z.SetMinThickness(mm(0.2))
    b.Add(z)

pcbnew.SaveBoard(BOARD, b)
print(f"cal-board placement done — board {BW}x{BH} mm, {len(pad_fps)} pads, GND plane net: {gnd_name}")
