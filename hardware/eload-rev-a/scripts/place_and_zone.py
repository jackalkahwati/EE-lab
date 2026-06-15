"""Placement engine — FL-1 Electronic Load + Discharge Board Rev A.

Strategy:
  4 load channel columns (40mm wide each):
    ch1: x=0-40, ch2: x=40-80, ch3: x=80-120, ch4: x=120-160
  Within each column:
    y=5-20mm:  DUT connector / input relay / discharge relay
    y=20-45mm: Power MOSFET (D2PAK — large copper pour for thermal)
    y=45-65mm: Op-amp + INA219 + passives
    y=65-80mm: Sense resistor + thermistor + decoupling
  Control strip (top): x=80-160mm, y=0-25mm — MCU (Pico2), watchdog, LEDs, fan FET
  Power strip:         x=0-80mm,   y=0-25mm — TPS54331, TPS62086, power INA219
  Telemetry row:       x=80-160mm, y=75-100mm — MCP4728 DAC, REF3033, EEPROM
  3 Fiducials: (10,90), (150,10), (150,90)
  Board outline: 160x100mm with M3 corner holes at 5mm from each corner

Run with KiCad bundled python AFTER `ato build` has synced the netlist:
  <kicad-python3> scripts/place_and_zone.py
Gate: scripts/placement_score.py must PASS before routing.
"""
import re
import pcbnew

BOARD  = "elec/layout/eload-rev-a.kicad_pcb"
X0, Y0 = 40.0, 40.0   # board origin offset in KiCad coordinates
BW, BH = 160.0, 100.0  # board width, height in mm
MARGIN = 0.5            # courtyard-to-courtyard minimum spacing

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


# ---- Load channel column placement -------------------------------------------
# 4 channels, each 40mm wide, MOSFETs at y=35 (column center)
CH_X = [20.0, 60.0, 100.0, 140.0]   # center x per channel

# MOSFET (D2PAK) — dominant thermal component per channel
mosfets = sorted(
    [fp for fp in fps if "TO-252" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for i, fp in enumerate(mosfets[:4]):
    place(fp, CH_X[i], 35.0, rot=0)

print(f"placed {len(mosfets[:4])} MOSFETs")

# Input relays (G5LE) — 2 per channel (input + discharge)
relays = sorted(
    [fp for fp in fps if fp.GetReference().startswith("K")],
    key=natkey,
)
relay_pairs = [relays[i*2:(i+1)*2] for i in range(4)]
for ch_idx, pair in enumerate(relay_pairs):
    for j, fp in enumerate(pair):
        place(fp, CH_X[ch_idx] - 8 + j * 16, 12.0)

print(f"placed {len(relays)} relays")

# Sense resistors (2512) — one per channel at y=70
sense_rs = sorted(
    [fp for fp in fps if "R2512" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for i, fp in enumerate(sense_rs[:4]):
    place(fp, CH_X[i], 70.0)

print(f"placed {len(sense_rs[:4])} sense resistors")

# Op-amps (SOIC-8 dual) — one per channel at y=52
opamps = sorted(
    [fp for fp in fps
     if "SOIC-8" in str(fp.GetFPID().GetLibItemName())
     and "MCP6" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for i, fp in enumerate(opamps[:4]):
    place(fp, CH_X[i] - 8, 52.0)

print(f"placed {len(opamps[:4])} op-amps")

# INA219 (SOT-23-8) — one per channel at y=60
inas = sorted(
    [fp for fp in fps
     if "SOT-23-8" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for i, fp in enumerate(inas[:4]):
    place(fp, CH_X[i] + 5, 58.0)

print(f"placed {len(inas[:4])} INA219s (channel)")

# Thermistors (0402 NTC) — one per channel at y=75
thermistors = sorted(
    [fp for fp in fps if fp.GetReference().startswith("RT")],
    key=natkey,
)
for i, fp in enumerate(thermistors[:4]):
    place(fp, CH_X[i] + 8, 75.0)

# ---- MCU + watchdog (top control strip, x=80-160, y=0-25) -------------------
mcus = [fp for fp in fps if "RaspberryPi_Pico" in str(fp.GetFPID().GetLibItemName())]
for fp in mcus:
    place(fp, 120.0, 12.0)

wdts = [fp for fp in fps if "TPS3823" in str(fp.GetFPID().GetLibItemName())]
for fp in wdts:
    place(fp, 90.0, 8.0)

# Fan FET (SOT-23)
fan_fets = sorted(
    [fp for fp in fps
     if "SOT-23_L2.9" in str(fp.GetFPID().GetLibItemName())
     and fp.GetReference().startswith("Q")],
    key=natkey,
)
for fp in fan_fets:
    place(fp, 88.0, 20.0)

# ---- Power block (top left, x=0-80, y=0-25) ---------------------------------
bucks = sorted(
    [fp for fp in fps if "TPS54331" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for fp in bucks:
    place(fp, 20.0, 10.0)

buck5s = sorted(
    [fp for fp in fps if "TPS62086" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for fp in buck5s:
    place(fp, 40.0, 10.0)

# INA219 for coil monitor (5th INA — distinguish by higher reference number)
if len(inas) > 4:
    place(inas[4], 55.0, 18.0)

# ---- Telemetry row (bottom right, x=80-160, y=75-100) ----------------------
dacs = sorted(
    [fp for fp in fps if "MCP4728" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for i, fp in enumerate(dacs[:2]):
    place(fp, 100.0 + i * 20, 88.0)

vrefs = sorted(
    [fp for fp in fps if "REF3033" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for fp in vrefs:
    place(fp, 142.0, 88.0)

# EEPROM
eeproms = [fp for fp in fps if "24AA025" in str(fp.GetFPID().GetLibItemName())]
for fp in eeproms:
    place(fp, 155.0, 88.0)

# ---- LEDs (near MCU, row at y=22) ------------------------------------------
leds = sorted([fp for fp in fps if fp.GetReference().startswith("LED")], key=natkey)
for i, fp in enumerate(leds[:7]):
    place(fp, 96.0 + i * 7, 22.0)

# ---- Flyback diodes (near relays) -------------------------------------------
diodes = sorted([fp for fp in fps if fp.GetReference().startswith("D")], key=natkey)
for i, fp in enumerate(diodes[:8]):
    ch = i // 2
    slot = i % 2
    place(fp, CH_X[ch] - 6 + slot * 12, 20.0)

# ---- Fiducials: three board corners -----------------------------------------
fids = sorted([fp for fp in fps if fp.GetReference().startswith("FID")], key=natkey)
fid_positions = [(10.0, 90.0), (150.0, 10.0), (150.0, 90.0)]
for fp, (x, y) in zip(fids, fid_positions):
    place(fp, x, y)

# ---- Board outline + M3 mounting holes --------------------------------------
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

# M3 mounting holes at four corners (3.2mm drill)
for cx, cy in ((5.0, 5.0), (BW - 5.0, 5.0), (5.0, BH - 5.0), (BW - 5.0, BH - 5.0)):
    h = pcbnew.PCB_SHAPE(b)
    h.SetShape(pcbnew.SHAPE_T_CIRCLE)
    h.SetCenter(pcbnew.VECTOR2I(mm(X0 + cx), mm(Y0 + cy)))
    h.SetEnd(pcbnew.VECTOR2I(mm(X0 + cx + 1.6), mm(Y0 + cy)))
    h.SetLayer(pcbnew.Edge_Cuts)
    h.SetWidth(mm(0.15))
    b.Add(h)

# ---- GND plane on In1_Cu ----------------------------------------------------
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

# ---- 5V power plane on In2_Cu -----------------------------------------------
pwr_name = next((n for n in pc if "5v" in n.lower() or "v5_coil" in n.lower()), None)
if pwr_name and not zones_pre:
    zp = pcbnew.ZONE(b)
    zp.SetLayer(pcbnew.In2_Cu)
    zp.SetNetCode(net_codes[pwr_name])
    chain2 = pcbnew.SHAPE_LINE_CHAIN()
    for x, y in [(X0, Y0), (X0 + BW, Y0), (X0 + BW, Y0 + BH), (X0, Y0 + BH)]:
        chain2.Append(mm(x), mm(y))
    chain2.SetClosed(True)
    zp.Outline().AddOutline(chain2)
    zp.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)
    zp.SetMinThickness(mm(0.2))
    b.Add(zp)

pcbnew.SaveBoard(BOARD, b)
print(f"eload-rev-a placement done — board {BW}x{BH} mm, GND net: {gnd_name}, 5V net: {pwr_name}")
