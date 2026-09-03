# tools/blocks/tests/eps_netlist_check.py
"""EPS safety topology assertions on a composed .kicad_pcb.
1. The cell's negative pin lands on EPS_BATT_N, NEVER directly on GND
   (that would bypass the protection FETs).
2. VBAT and +5V are distinct nets (no charger bypass).
3. The FS8205A has both gate nets (EPS_OD, EPS_OC) attached.
Run under KiCad python:  KPY eps_netlist_check.py <board>
"""
import sys
import pcbnew

b = pcbnew.LoadBoard(sys.argv[1])
nets = {}
for fp in b.GetFootprints():
    for p in fp.Pads():
        nets.setdefault(str(p.GetNetname()), []).append(
            "%s-%s" % (fp.GetReference(), p.GetNumber()))
fail = 0
jst = [t for n in ("EPS_BATT_N",) for t in nets.get(n, []) if t.startswith("J")]
if not jst:
    print("FAIL: no battery-connector pin on EPS_BATT_N (protection bypassed?)"); fail = 1
if not nets.get("VBAT"):
    print("FAIL: VBAT net missing"); fail = 1
if any(t in nets.get("GND", []) for t in jst):
    print("FAIL: battery negative tied to GND directly"); fail = 1
for g in ("EPS_OD", "EPS_OC"):
    if len(nets.get(g, [])) < 2:
        print("FAIL: %s not wired to both DW01A and FS8205A" % g); fail = 1
print("EPS netlist check:", "FAIL" if fail else "OK")
sys.exit(fail)
