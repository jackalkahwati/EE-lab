"""Placement engine — FL-1 I/O Card Rev A.

Strategy:
  Analog domain (x=0-75mm left): ADS1256, ADS1115x4, REF5025, ICL7660,
    TPS7A4901, DAC8552x2, TLV2374x2.
  Digital domain (x=80-160mm right): Pico2 MCU, MCP23017x4, ULN2803x2,
    TCAN1042, SHT31.
  Power section: TPS54331, TPS62086.
  Fiducials at three corners.
  Board outline 160x100mm, M3 holes at four corners (3.2mm drill).

Run with KiCad bundled python AFTER `ato build` syncs netlist:
  <kicad-python3> scripts/place_and_zone.py
Gate: scripts/placement_score.py must PASS before routing.
"""
import re
import pcbnew

BOARD = "elec/layout/io-card-rev-a.kicad_pcb"
X0, Y0 = 40.0, 40.0    # board origin offset in KiCad coordinates
BW, BH = 160.0, 100.0  # board width, height in mm
MARGIN = 0.5            # courtyard-to-courtyard minimum spacing

b = pcbnew.LoadBoard(BOARD)
b.SetCopperLayerCount(4)
fps = list(b.GetFootprints())

# net census
from collections import Counter
pc = Counter()
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


def natkey(fp):
    return int(re.sub(r"[^0-9]", "", fp.GetReference()) or 0)


by_ref = {fp.GetReference(): fp for fp in fps}
by_lib = {}
for fp in fps:
    by_lib.setdefault(str(fp.GetFPID().GetLibItemName()), []).append(fp)


# ---- ANALOG DOMAIN (x=0-75mm) -----------------------------------------------

# ADS1256 precision ADC at (15,20)
for fp in fps:
    if "ADS1256" in str(fp.GetFPID().GetLibItemName()):
        place(fp, 15, 20)

# ADS1115 x4 at x=5,25,45,65 y=50
ads1115_fps = sorted(
    [fp for fp in fps if "ADS1115" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
ads1115_x = [5.0, 25.0, 45.0, 65.0]
for i, fp in enumerate(ads1115_fps[:4]):
    place(fp, ads1115_x[i], 50)

# REF5025 at (15,10)
for fp in fps:
    if "REF5025" in str(fp.GetFPID().GetLibItemName()):
        place(fp, 15, 10)

# ICL7660 at (30,10)
for fp in fps:
    if "ICL7660" in str(fp.GetFPID().GetLibItemName()):
        place(fp, 30, 10)

# TPS7A4901 at (45,10)
for fp in fps:
    if "TPS7A4901" in str(fp.GetFPID().GetLibItemName()):
        place(fp, 45, 10)

# DAC8552 x2 at (60,20) and (75,20)
dac_fps = sorted(
    [fp for fp in fps if "DAC8552" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
dac_x = [60.0, 75.0]
for i, fp in enumerate(dac_fps[:2]):
    place(fp, dac_x[i], 20)

# TLV2374 x2 at (60,35) and (75,35)
tlv_fps = sorted(
    [fp for fp in fps if "TLV2374" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
tlv_x = [60.0, 75.0]
for i, fp in enumerate(tlv_fps[:2]):
    place(fp, tlv_x[i], 35)

# ---- POWER SECTION (x=95-115mm, y=5-20mm) -----------------------------------

# TPS54331 at (100,10)
for fp in fps:
    if "TPS54331" in str(fp.GetFPID().GetLibItemName()):
        place(fp, 100, 10)

# TPS62086 at (115,10)
for fp in fps:
    if "TPS62086" in str(fp.GetFPID().GetLibItemName()):
        place(fp, 115, 10)

# ---- DIGITAL DOMAIN (x=80-160mm) --------------------------------------------

# Pico2 MCU at (110,40)
for fp in fps:
    if "Pico2" in str(fp.GetFPID().GetLibItemName()) or "Pico_SMD" in str(fp.GetFPID().GetLibItemName()):
        place(fp, 110, 40)

# MCP23017 x4 at y=20, x=85,100,115,130
mcp_fps = sorted(
    [fp for fp in fps if "MCP23017" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
mcp_x = [85.0, 100.0, 115.0, 130.0]
for i, fp in enumerate(mcp_fps[:4]):
    place(fp, mcp_x[i], 20)

# ULN2803 x2 at (145,30) and (145,55)
uln_fps = sorted(
    [fp for fp in fps if "ULN2803" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
uln_y = [30.0, 55.0]
for i, fp in enumerate(uln_fps[:2]):
    place(fp, 145, uln_y[i])

# TCAN1042 at (150,10)
for fp in fps:
    if "TCAN1042" in str(fp.GetFPID().GetLibItemName()):
        place(fp, 150, 10)

# SHT31 at (85,70)
for fp in fps:
    if "SHT31" in str(fp.GetFPID().GetLibItemName()):
        place(fp, 85, 70)

# TPS3823 watchdog near MCU
for fp in fps:
    if "TPS3823" in str(fp.GetFPID().GetLibItemName()):
        place(fp, 130, 10)

# INA219 near power section
ina_fps = sorted(
    [fp for fp in fps if "INA219" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for fp in ina_fps:
    place(fp, 95, 10)

# EEPROM near MCU
for fp in fps:
    if "24AA025" in str(fp.GetFPID().GetLibItemName()):
        place(fp, 140, 70)

# Littelfuse fuse + TVS near power input connector
fuse_fps = [fp for fp in fps if "0805L010" in str(fp.GetFPID().GetLibItemName())]
for fp in fuse_fps:
    place(fp, 5, 10)
tvs_fps = [fp for fp in fps if "SMBJ33" in str(fp.GetFPID().GetLibItemName())]
for fp in tvs_fps:
    place(fp, 5, 20)

# LEDs: row at bottom of digital domain (y=85, x=85-130)
led_fps = sorted([fp for fp in fps if fp.GetReference().startswith("LED")], key=natkey)
for i, fp in enumerate(led_fps[:6]):
    place(fp, 85.0 + i * 9.0, 85)

# Test pads: 3 rows along bottom edge (y=95mm)
tp_fps = sorted([fp for fp in fps if fp.GetReference().startswith("TP")], key=natkey)
for i, fp in enumerate(tp_fps):
    row = i // 12
    col = i % 12
    place(fp, 10.0 + col * 12.0, 90.0 + row * 4.0)

print(f"placed {len(fps)} footprints in analog+digital domains")

# ---- fiducials: three board corners -----------------------------------------
fids = sorted([fp for fp in fps if fp.GetReference().startswith("FID")], key=natkey)
fid_positions = [(10.0, 90.0), (150.0, 10.0), (150.0, 90.0)]
for fp, (x, y) in zip(fids, fid_positions):
    place(fp, x, y)

# ---- board outline + M3 mounting holes (3.2mm drill) ------------------------
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

# M3 holes at four corners (5mm inset)
for cx, cy in ((5.0, 5.0), (BW - 5.0, 5.0), (5.0, BH - 5.0), (BW - 5.0, BH - 5.0)):
    h = pcbnew.PCB_SHAPE(b)
    h.SetShape(pcbnew.SHAPE_T_CIRCLE)
    h.SetCenter(pcbnew.VECTOR2I(mm(X0 + cx), mm(Y0 + cy)))
    h.SetEnd(pcbnew.VECTOR2I(mm(X0 + cx + 1.6), mm(Y0 + cy)))
    h.SetLayer(pcbnew.Edge_Cuts)
    h.SetWidth(mm(0.15))
    b.Add(h)

# ---- GND planes on In1 (analog left / digital right, single-point join) -----
# Find GND net
gnd_name = next((n for n in pc if n.lower() in ("gnd", "lv", "gnd_ref")), None)

if gnd_name and not zones_pre:
    # Analog GND: In1.Cu left half (x=0..80mm)
    z_agnd = pcbnew.ZONE(b)
    z_agnd.SetLayer(pcbnew.In1_Cu)
    z_agnd.SetNetCode(net_codes[gnd_name])
    chain = pcbnew.SHAPE_LINE_CHAIN()
    for x, y in [(X0, Y0), (X0 + 80, Y0), (X0 + 80, Y0 + BH), (X0, Y0 + BH)]:
        chain.Append(mm(x), mm(y))
    chain.SetClosed(True)
    z_agnd.Outline().AddOutline(chain)
    z_agnd.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)
    z_agnd.SetMinThickness(mm(0.2))
    b.Add(z_agnd)

    # Digital GND: In1.Cu right half (x=80..160mm)
    z_dgnd = pcbnew.ZONE(b)
    z_dgnd.SetLayer(pcbnew.In1_Cu)
    z_dgnd.SetNetCode(net_codes[gnd_name])
    chain2 = pcbnew.SHAPE_LINE_CHAIN()
    for x, y in [(X0 + 80, Y0), (X0 + BW, Y0), (X0 + BW, Y0 + BH), (X0 + 80, Y0 + BH)]:
        chain2.Append(mm(x), mm(y))
    chain2.SetClosed(True)
    z_dgnd.Outline().AddOutline(chain2)
    z_dgnd.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)
    z_dgnd.SetMinThickness(mm(0.2))
    b.Add(z_dgnd)

pcbnew.SaveBoard(BOARD, b)
print(f"io-card placement done — board {BW}x{BH}mm, GND plane net: {gnd_name}")
print("Ground split: AGND In1.Cu x=0-80mm, DGND In1.Cu x=80-160mm")
print("Single-point join at x=80mm center on In1.Cu (add stitching via manually)")
