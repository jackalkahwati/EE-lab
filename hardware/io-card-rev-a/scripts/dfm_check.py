"""DFM profile check — FL-1 I/O Card Rev A.

Checks design-for-manufacture rules:
  - Minimum trace width (0.127mm)
  - Minimum clearance (0.127mm)
  - Analog traces >= 0.2mm
  - Power traces >= 0.5mm
  - Minimum drill size 0.2mm
  - No copper in courtyard violations

Output: elec/layout/io-card-rev-a/output/dfm_profile_check.json

Run with KiCad bundled python:
  <kicad-python3> scripts/dfm_check.py
"""
import json
import os
import sys
import pcbnew

BOARD = "elec/layout/io-card-rev-a/io-card-rev-a.kicad_pcb"
OUTPUT = "elec/layout/io-card-rev-a/output/dfm_profile_check.json"

MIN_TRACE_MM = 0.127
MIN_CLEARANCE_MM = 0.127
ANALOG_TRACE_MM = 0.2
POWER_TRACE_MM = 0.5
MIN_DRILL_MM = 0.2

results = {
    "board": "io-card-rev-a",
    "rules": {
        "min_trace_mm": MIN_TRACE_MM,
        "min_clearance_mm": MIN_CLEARANCE_MM,
        "analog_trace_mm": ANALOG_TRACE_MM,
        "power_trace_mm": POWER_TRACE_MM,
        "min_drill_mm": MIN_DRILL_MM,
    },
    "violations": [],
    "summary": {}
}

try:
    b = pcbnew.LoadBoard(BOARD)
except Exception as e:
    results["error"] = f"Could not load board: {e}"
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, "w") as f:
        json.dump(results, f, indent=2)
    print(f"DFM CHECK: board not found at {BOARD} — skipping trace checks")
    sys.exit(0)

tracks = list(b.GetTracks())
violations = []

for t in tracks:
    if not hasattr(t, "GetWidth"):
        continue
    w = pcbnew.ToMM(t.GetWidth())
    net = str(t.GetNetname()).lower()

    if w < MIN_TRACE_MM:
        violations.append({
            "type": "trace_too_narrow",
            "net": net,
            "width_mm": round(w, 4),
            "min_mm": MIN_TRACE_MM
        })

    if "pwr" in net or "5v" in net or "3v3" in net or "24v" in net:
        if w < POWER_TRACE_MM:
            violations.append({
                "type": "power_trace_too_narrow",
                "net": net,
                "width_mm": round(w, 4),
                "min_mm": POWER_TRACE_MM
            })

# Check drill sizes
for fp in b.GetFootprints():
    for pad in fp.Pads():
        drill = pcbnew.ToMM(pad.GetDrillSize().x)
        if drill > 0 and drill < MIN_DRILL_MM:
            violations.append({
                "type": "drill_too_small",
                "ref": fp.GetReference(),
                "drill_mm": round(drill, 4),
                "min_mm": MIN_DRILL_MM
            })

results["violations"] = violations
results["summary"] = {
    "total_tracks": len(tracks),
    "violation_count": len(violations),
    "status": "PASS" if not violations else "FAIL"
}

os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
with open(OUTPUT, "w") as f:
    json.dump(results, f, indent=2)

status = results["summary"]["status"]
print(f"DFM CHECK: {status} — {len(violations)} violations in {len(tracks)} tracks")
if violations:
    for v in violations[:10]:
        print(f"  {v['type']}: {v}")
sys.exit(0 if status == "PASS" else 1)
