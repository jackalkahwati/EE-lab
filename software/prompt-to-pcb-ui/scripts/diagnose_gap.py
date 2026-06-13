"""Differential diagnosis: flroute's claimed-routed nets vs KiCad's
connectivity verdict. Classifies each gap net by failure signature.

  <kicad-python3> diagnose_gap.py <board.kicad_pcb> <board.ses> <drc.json>

The per-net open verdict comes from the DRC report's unconnected_items
(GetRatsnestForNet is unavailable in KiCad 10.0.1 standalone swig).
"""
import json
import re
import sys
from collections import defaultdict

import pcbnew

board_path, ses_path = sys.argv[1], sys.argv[2]
b = pcbnew.LoadBoard(board_path)

# --- what the SES file claims (flroute's emitted nets) ------------------------
ses = open(ses_path).read()
ses_nets = set(re.findall(r'\(net\s+"?([^"\s)]+)"?', ses))
# wire count per net in the SES
ses_wires = defaultdict(int)
for m in re.finditer(r'\(net\s+"?([^"\s)]+)"?', ses):
    ses_wires[m.group(1)] += 1

# --- what the board actually has (post-import) --------------------------------
net_pads = defaultdict(int)
for fp in b.GetFootprints():
    for pad in fp.Pads():
        if pad.GetNetCode() > 0:
            net_pads[str(pad.GetNetname())] += 1

net_tracks = defaultdict(int)
net_vias = defaultdict(int)
for t in b.GetTracks():
    name = str(t.GetNetname())
    if t.GetClass() == "PCB_VIA":
        net_vias[name] += 1
    else:
        net_tracks[name] += 1

zone_nets = {str(z.GetNetname()) for z in b.Zones() if z.GetNetCode() > 0}

# --- KiCad's per-net unconnected verdict (from the DRC referee) ---------------
drc = json.load(open(sys.argv[3]))
open_nets = set()
open_pairs = defaultdict(int)
for u in drc.get("unconnected_items", []):
    for it in u.get("items", []):
        m = re.search(r"\[(.*?)\]", it.get("description", ""))
        if m:
            open_nets.add(m.group(1))
            open_pairs[m.group(1)] += 1

print(f"SES nets emitted by flroute: {len(ses_nets)}")
print(f"board nets with >=2 pads:   {sum(1 for n,c in net_pads.items() if c>=2)}")
print(f"KiCad open nets:            {len(open_nets - zone_nets)} (excl zone-served)")
print()

# --- classify the gap: claimed routed but open ---------------------------------
gap = sorted((open_nets - zone_nets) & ses_nets)
missing_from_ses = sorted(open_nets - zone_nets - ses_nets)

classes = defaultdict(list)
for n in gap:
    if net_tracks[n] == 0 and net_vias[n] == 0:
        classes["IMPORT_DROPPED (in SES, zero copper on board)"].append(n)
    elif net_pads[n] > 2:
        classes["MULTIPIN_PARTIAL (copper present, >2 pads)"].append(n)
    else:
        classes["PAD_ENTRY_GAP (copper present, 2 pads, still open)"].append(n)

for cls, nets in sorted(classes.items()):
    print(f"{cls}: {len(nets)}")
    for n in nets[:8]:
        print(f"   {n}  pads={net_pads[n]} tracks={net_tracks[n]} vias={net_vias[n]} ses_wires={ses_wires[n]}")
    if len(nets) > 8:
        print(f"   … +{len(nets)-8} more")
    print()

print(f"OPEN BUT NEVER IN SES (flroute also says failed/skipped): {len(missing_from_ses)}")
for n in missing_from_ses[:10]:
    print(f"   {n}  pads={net_pads[n]} tracks={net_tracks[n]}")

out = {
    "gap_classes": {k: v for k, v in classes.items()},
    "missing_from_ses": missing_from_ses,
}
json.dump(out, open("/tmp/board-sync/gap_diagnosis.json", "w"), indent=1)
print("\nwrote /tmp/board-sync/gap_diagnosis.json")
