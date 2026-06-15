"""Placement engine — FL-1 DUT Power + Fast-Trip Board Rev A.

Strategy: 4 rail columns (each ~38 mm wide), control strip across the top,
bottom strip for telemetry ICs and connectors.

Column layout per rail (x offsets: 0, 40, 80, 120 mm):
  y=25: buck IC (TPS54331) + inductor
  y=35: MOSFET (AO4407A) + BSS84 + comparator (TLV1701) + SR latch (74HC74)
  y=45: sense resistor (10 mΩ) + INA219 (in bottom strip)
  y=65: output relay (G5LE) + discharge relay (G6K)

Control strip (y=0–20):
  x=5:   control power (TPS54331 + TPS62086)
  x=80:  Raspberry Pi Pico 2
  x=140: LEDs + USB-C connector

Bottom strip (y=85–100):
  INA219 × 4, DAC × 4 MCP4728, EEPROM, backplane connectors

Run with KiCad bundled python AFTER `ato build` has synced the netlist:
  <kicad-python3> scripts/place_and_zone.py
Gate: scripts/placement_score.py must PASS before routing.
"""
import re
import pcbnew

BOARD  = "elec/layout/dut-power-rev-a.kicad_pcb"
X0, Y0 = 40.0, 40.0   # board origin offset in KiCad coordinates
BW, BH = 160.0, 100.0  # board width × height (mm)
MARGIN = 0.5           # courtyard-to-courtyard minimum spacing

b   = pcbnew.LoadBoard(BOARD)
b.SetCopperLayerCount(4)
fps = list(b.GetFootprints())

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

# Column X centres for 4 rails
RAIL_X = [12.0, 52.0, 92.0, 132.0]

# ---- Control power tree: x=5, y=5–18 ----------------------------------------
ctrl_bucks = [fp for fp in fps if "TPS54331" in str(fp.GetFPID().GetLibItemName())
              or "TPS62086" in str(fp.GetFPID().GetLibItemName())]
ctrl_bucks_sorted = sorted(ctrl_bucks, key=natkey)
for i, fp in enumerate(ctrl_bucks_sorted[:2]):
    place(fp, 5.0 + i * 8, 8.0)

print(f"placed {len(ctrl_bucks_sorted[:2])} control power ICs")

# ---- Raspberry Pi Pico 2: centre x=80, y=8 -----------------------------------
picos = [fp for fp in fps if "Pico2" in str(fp.GetFPID().GetLibItemName())]
for fp in picos:
    place(fp, 80.0, 8.0)
print(f"placed {len(picos)} Pico2")

# ---- LEDs: right side of control strip x=140–155, y=5–18 --------------------
leds = sorted([fp for fp in fps if fp.GetReference().startswith("LED")
               or ("LED" in str(fp.GetFPID().GetLibItemName()))], key=natkey)
for i, fp in enumerate(leds[:6]):
    place(fp, 140.0 + (i % 3) * 5, 5.0 + (i // 3) * 5)
print(f"placed {len(leds[:6])} LEDs")

# ---- Rail buck ICs (TPS54331 × 4 for DUT rails): y=25 -----------------------
# After control TPS54331s, remaining are DUT rail bucks
dut_bucks = sorted(
    [fp for fp in fps if "TPS54331" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
# Skip the first one (control power)
dut_rail_bucks = dut_bucks[1:]  # rails 1-4
for i, fp in enumerate(dut_rail_bucks[:4]):
    place(fp, RAIL_X[i], 25.0)
print(f"placed {min(4, len(dut_rail_bucks))} DUT rail buck ICs")

# ---- Inductors: near their buck IC (y=30) ------------------------------------
inductors = sorted(
    [fp for fp in fps if fp.GetReference().startswith("L")],
    key=natkey,
)
for i, fp in enumerate(inductors[:5]):
    if i == 0:
        place(fp, 12.0, 12.0)  # control power inductor
    else:
        place(fp, RAIL_X[i - 1] + 5, 25.0)
print(f"placed {len(inductors[:5])} inductors")

# ---- AO4407A power MOSFETs: y=38 --------------------------------------------
pfets = sorted(
    [fp for fp in fps if "AO4407A" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for i, fp in enumerate(pfets[:4]):
    place(fp, RAIL_X[i], 38.0)
print(f"placed {min(4, len(pfets))} AO4407A MOSFETs")

# ---- BSS84 level-shift helpers: near each PFET (x+5) ------------------------
bss84s = sorted(
    [fp for fp in fps if "BSS84" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for i, fp in enumerate(bss84s[:4]):
    place(fp, RAIL_X[i] + 6, 38.0)
print(f"placed {min(4, len(bss84s))} BSS84s")

# ---- TLV1701 comparators: y=43 -----------------------------------------------
comps = sorted(
    [fp for fp in fps if "TLV1701" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for i, fp in enumerate(comps[:4]):
    place(fp, RAIL_X[i], 43.0)
print(f"placed {min(4, len(comps))} TLV1701 comparators")

# ---- SN74HC74D SR latches: y=48 ----------------------------------------------
latches = sorted(
    [fp for fp in fps if "74HC74" in str(fp.GetFPID().GetLibItemName())
     or "SN74HC74" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for i, fp in enumerate(latches[:4]):
    place(fp, RAIL_X[i] + 7, 43.0)
print(f"placed {min(4, len(latches))} 74HC74 latches")

# ---- 10 mΩ sense resistors: y=52 ---------------------------------------------
sense_rs = sorted(
    [fp for fp in fps if "FC2512" in str(fp.GetFPID().GetLibItemName())
     or "0R010" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for i, fp in enumerate(sense_rs[:4]):
    place(fp, RAIL_X[i], 52.0)
print(f"placed {min(4, len(sense_rs))} sense resistors")

# ---- G5LE output relays: y=65 ------------------------------------------------
relays_out = sorted(
    [fp for fp in fps if "G5LE" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for i, fp in enumerate(relays_out[:4]):
    place(fp, RAIL_X[i], 65.0)
print(f"placed {min(4, len(relays_out))} G5LE output relays")

# ---- G6K discharge relays: y=72 (offset from output relay) ------------------
relays_disch = sorted(
    [fp for fp in fps if "G6K" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for i, fp in enumerate(relays_disch[:4]):
    place(fp, RAIL_X[i] + 12, 65.0)
print(f"placed {min(4, len(relays_disch))} G6K discharge relays")

# ---- INA219s (bottom strip): y=90, pitched 20mm starting x=10 ---------------
inas = sorted(
    [fp for fp in fps if "INA219" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for i, fp in enumerate(inas[:5]):   # 4 rail + 1 coil monitor
    place(fp, 10.0 + i * 20, 90.0)
print(f"placed {min(5, len(inas))} INA219s")

# ---- MCP4728 DACs: y=90, x starting at 110 ----------------------------------
dacs = sorted(
    [fp for fp in fps if "MCP4728" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for i, fp in enumerate(dacs[:4]):
    place(fp, 110.0 + i * 10, 90.0)
print(f"placed {min(4, len(dacs))} MCP4728 DACs")

# ---- EEPROM: x=155, y=90 ----------------------------------------------------
eeproms = sorted(
    [fp for fp in fps if "24AA025" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for fp in eeproms[:1]:
    place(fp, 155.0, 90.0)
print(f"placed {len(eeproms[:1])} EEPROM")

# ---- REF3033 voltage reference: x=150, y=82 ---------------------------------
refs = sorted(
    [fp for fp in fps if "REF3033" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for fp in refs[:1]:
    place(fp, 150.0, 82.0)

# ---- TPS3823 watchdog: near MCU, x=70, y=5 ----------------------------------
wdts = sorted(
    [fp for fp in fps if "TPS3823" in str(fp.GetFPID().GetLibItemName())],
    key=natkey,
)
for fp in wdts[:1]:
    place(fp, 70.0, 5.0)

# ---- Passives (R, C, L leftover): grid fill in their rail column ------
all_r = sorted([fp for fp in fps if fp.GetReference().startswith("R")
                and fp not in sense_rs], key=natkey)
all_c = sorted([fp for fp in fps if fp.GetReference().startswith("C")], key=natkey)

# Distribute remaining passives across rail columns
# 4 columns × passives per column, spread in 3 mm pitch
PASS_Y_START = 57.0
PASS_PITCH   = 2.5

for i, fp in enumerate(all_r):
    col = i % 4
    row = i // 4
    place(fp, RAIL_X[col] + (row % 3) * 5 - 5, PASS_Y_START + (row // 3) * PASS_PITCH)

for i, fp in enumerate(all_c):
    col = i % 4
    row = i // 4
    place(fp, RAIL_X[col] + (row % 3) * 5 - 3, PASS_Y_START + 10 + (row // 3) * PASS_PITCH)

print(f"distributed {len(all_r)} resistors, {len(all_c)} capacitors")

# ---- Board outline -----------------------------------------------------------
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

# M3 mounting holes at four corners (3.2 mm drill)
for cx, cy in ((5.0, 5.0), (BW - 5.0, 5.0), (5.0, BH - 5.0), (BW - 5.0, BH - 5.0)):
    h = pcbnew.PCB_SHAPE(b)
    h.SetShape(pcbnew.SHAPE_T_CIRCLE)
    h.SetCenter(pcbnew.VECTOR2I(mm(X0 + cx), mm(Y0 + cy)))
    h.SetEnd(pcbnew.VECTOR2I(mm(X0 + cx + 1.6), mm(Y0 + cy)))
    h.SetLayer(pcbnew.Edge_Cuts)
    h.SetWidth(mm(0.15))
    b.Add(h)

# ---- Zone fills: GND (In1.Cu) + 5V_COIL (In2.Cu) ---------------------------
gnd_name = next(
    (n for n in pc if n.lower() in ("gnd", "lv", "gnd_ref", "v28_ctrl_in.lv")), None
)
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

v5_name = next(
    (n for n in pc if "5V" in n.upper() or "v5_coil" in n.lower()), None
)
if v5_name and not zones_pre:
    z5 = pcbnew.ZONE(b)
    z5.SetLayer(pcbnew.In2_Cu)
    z5.SetNetCode(net_codes[v5_name])
    chain5 = pcbnew.SHAPE_LINE_CHAIN()
    for x, y in [(X0, Y0), (X0 + BW, Y0), (X0 + BW, Y0 + BH), (X0, Y0 + BH)]:
        chain5.Append(mm(x), mm(y))
    chain5.SetClosed(True)
    z5.Outline().AddOutline(chain5)
    z5.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)
    z5.SetMinThickness(mm(0.2))
    b.Add(z5)

pcbnew.SaveBoard(BOARD, b)
print(f"dut-power placement done — board {BW}×{BH} mm, GND net: {gnd_name}, 5V net: {v5_name}")
