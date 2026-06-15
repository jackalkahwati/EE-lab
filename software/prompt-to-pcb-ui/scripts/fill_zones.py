"""Refill all copper zones on a board, in place.

After a targeted repair adds copper (stitch/reroute/clearance jog), the zones
must be refilled so KiCad's connectivity (and therefore the DRC unconnected
check) reflects the new copper. Run this before re-DRC.

  <kicad-python3> fill_zones.py <board.kicad_pcb>

Prints "FILLED <n>" sentinel; the KiCad 10.0.1 standalone swig interpreter may
segfault at teardown AFTER a clean save, so callers must key on the sentinel,
not the exit code.
"""
import sys

import pcbnew

board_path = sys.argv[1]
b = pcbnew.LoadBoard(board_path)
zones = b.Zones()
pcbnew.ZONE_FILLER(b).Fill(zones)
b.Save(board_path)
print("FILLED %d" % len(zones))
sys.stdout.flush()
