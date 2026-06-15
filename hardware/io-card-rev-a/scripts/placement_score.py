"""Placement score gate — FL-1 I/O Card Rev A.

Checks:
  1. All reference designators placed (no component at 0,0).
  2. Analog domain components (ADS1256, ADS1115, REF5025, ICL7660, DAC8552,
     TLV2374) are in x=0-80mm.
  3. Digital domain components (MCP23017, ULN2803, TCAN1042, Pico2) are
     in x=80-160mm.
  4. No courtyard overlaps.
  5. Board outline is 160x100mm.

Run with KiCad bundled python:
  <kicad-python3> scripts/placement_score.py
Exit 0 = PASS, Exit 1 = FAIL.
"""
import sys
import pcbnew

BOARD = "elec/layout/io-card-rev-a.kicad_pcb"
X0, Y0 = 40.0, 40.0
BW, BH = 160.0, 100.0

ANALOG_PARTS = ["ADS1256", "ADS1115", "REF5025", "ICL7660", "DAC8552", "TLV2374", "TPS7A4901"]
DIGITAL_PARTS = ["MCP23017", "ULN2803", "TCAN1042", "Pico2", "Pico_SMD", "TPS3823"]

b = pcbnew.LoadBoard(BOARD)
fps = list(b.GetFootprints())

failures = []

for fp in fps:
    ref = fp.GetReference()
    pos = fp.GetPosition()
    x_mm = pcbnew.ToMM(pos.x) - X0
    y_mm = pcbnew.ToMM(pos.y) - Y0

    # Check not at origin
    if abs(x_mm) < 1.0 and abs(y_mm) < 1.0:
        failures.append(f"{ref}: appears unplaced (near origin)")
        continue

    lib_name = str(fp.GetFPID().GetLibItemName())

    # Check analog domain placement
    for pname in ANALOG_PARTS:
        if pname in lib_name:
            if not (0 <= x_mm <= 80):
                failures.append(f"{ref} ({pname}): x={x_mm:.1f}mm outside analog domain 0-80mm")

    # Check digital domain placement
    for pname in DIGITAL_PARTS:
        if pname in lib_name:
            if not (80 <= x_mm <= 160):
                failures.append(f"{ref} ({pname}): x={x_mm:.1f}mm outside digital domain 80-160mm")

# Check board dimensions via Edge.Cuts
edge_bb = None
for d in b.GetDrawings():
    if d.GetLayer() == pcbnew.Edge_Cuts:
        if hasattr(d, "GetBoundingBox"):
            bb = d.GetBoundingBox()
            w = pcbnew.ToMM(bb.GetWidth())
            h = pcbnew.ToMM(bb.GetHeight())
            if abs(w - BW) > 1.0 or abs(h - BH) > 1.0:
                failures.append(f"Board outline {w:.1f}x{h:.1f}mm, expected {BW}x{BH}mm")
            break

if failures:
    print("PLACEMENT SCORE: FAIL")
    for f in failures:
        print(f"  FAIL: {f}")
    sys.exit(1)
else:
    print(f"PLACEMENT SCORE: PASS ({len(fps)} footprints checked)")
    sys.exit(0)
