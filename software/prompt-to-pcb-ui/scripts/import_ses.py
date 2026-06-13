"""Import a routed SES session, refill zones, save.

  <kicad-python3> import_ses.py <board.kicad_pcb> <session.ses>

KiCad 10.0.1 standalone swig notes: container accessors break after board
mutation, and the interpreter may segfault at teardown AFTER all work is
done. Zones are captured pre-import, and the caller must treat the
IMPORT_OK sentinel (not the exit code) as success. Track/via stats come
from extract_stats.py in a fresh read-only process.
"""
import sys

import pcbnew

board_path, ses_path = sys.argv[1], sys.argv[2]
b = pcbnew.LoadBoard(board_path)
zones = list(b.Zones())  # pre-mutation capture

ok = pcbnew.ImportSpecctraSES(b, ses_path)
print(f"SES import: {ok}")
if not ok:
    sys.exit(1)

filler = pcbnew.ZONE_FILLER(b)
filler.Fill(zones)
pcbnew.SaveBoard(board_path, b)
print(f"zone fill: {len(zones)} zones")
print("IMPORT_OK")
