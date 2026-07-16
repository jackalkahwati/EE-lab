# tools/blocks/tests/eps_parts_check.py
"""EPS block pin-anchor verification — run before trusting block_eps's pin maps.

Fetches datasheet pins via the registry/datasheet path used by source_part
and asserts the exact pins block_eps wires. A mismatch means the sourced
package differs from the plan's assumption: STOP and fix the pmap.

Resolved parts (2026-07-15, JLCPCB catalog via tools/parts/registry.py):
  C16581  TP4056-42-ESOP8   TOPPOWER  ESOP-8      (charger)
  C351410 DW01A             PUOLOP    SOT-23-6L   (protector)
  C908265 FS8205A           FUXINSEMI SOT-23-6L   (dual N-FET)
  C51118  AP2112K-3.3TRG1   Diodes    SOT-25-5    (3.3V LDO)
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "parts"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "hardware", "blocks"))
import registry

# id -> {pin_number: expected_name_regex}
ANCHORS = {
    "C16581": {"3": "GND", "4": "VCC", "5": "BAT", "2": "PROG",
               "7": "CHRG", "6": "STDBY", "1": "TEMP", "8": "CE"},
    # PUOLOP names the current-sense pin "VM" (other vendors call it "CS") —
    # same pin-2 function: sense input to pack minus via series R.
    "C351410": {"1": "OD", "2": "VM|CS", "3": "OC", "5": "VCC", "6": "GND"},
    # FS8205A SOT-23-6 (FUXINSEMI datasheet): 1=G1 2=S1 3=D1/D2 4=D1/D2 5=G2 6=S2
    "C908265": {"1": "G1", "2": "S1", "3": r"D1|D2", "4": r"D1|D2",
                "5": "G2", "6": "S2"},
    "C51118": {"1": "VIN", "2": "GND", "3": "EN", "5": "VOUT"},
}

import re
fail = 0
for pid, anchors in ANCHORS.items():
    e = registry.get(pid)
    pins = {str(p.get("number")): str(p.get("name", "")) for p in (e.get("pins") or [])}
    if not pins:
        print(f"{pid}: NO PINS in registry — run the datasheet fetch first"); fail += 1; continue
    for num, pat in anchors.items():
        got = pins.get(num, "<missing>")
        ok = re.search(pat, got, re.I)
        print(f"{pid} pin {num}: want /{pat}/ got {got!r} {'OK' if ok else 'FAIL'}")
        fail += 0 if ok else 1
sys.exit(1 if fail else 0)
