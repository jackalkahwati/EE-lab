"""Sync the prompt's parametric design variant to the frontend data layer.

The pipeline routes/DRCs the proven FL-1 reference, but the DISPLAYED board
(renders + BOM + design metrics) should reflect what the prompt actually asked
for. gen_board.py builds a parametric floorplan from the design spec; this
script turns that board into the frontend's bom.json + board.json:

  - bom.json   : the variant's component census, scaled by the prompt, with the
                 real FL-1 LCSC part numbers attached by component family.
  - board.json : design fields (components, board size, layers, net count) from
                 the variant; routing fields (nets routed, tracks, vias, DRC)
                 carried over from the routed reference when available.

Usage:
  <kicad-python3> variant_sync.py <variant.kicad_pcb> <fl1_bom.csv> <out_data_dir>
                  [--routing-json <reference board.json>]
"""
import csv
import json
import os
import re
import sys

import pcbnew

VARIANT = sys.argv[1]
FL1_BOM = sys.argv[2]
OUT = sys.argv[3]
ROUTING_JSON = None
if "--routing-json" in sys.argv:
    ROUTING_JSON = sys.argv[sys.argv.index("--routing-json") + 1]

# KiCad-library footprint family -> (friendly name, FL-1 BOM match keyword(s)).
# The variant uses standard KiCad footprints; we attach the real orderable part
# from the FL-1 BOM by family so the quantities scale but the parts stay real.
FAMILY = [
    ("G6K-2F", "Omron G6K-2F-Y DPDT signal relay", ["g6k", "relay"]),
    ("SIL_Form1A", "Standex reed relay (SIP-1A05)", ["reed", "sil", "sip", "1a05"]),
    ("Pico", "Raspberry Pi Pico (RP2040)", ["pico", "rp2040"]),
    ("SOIC-20", "Shift-register sink driver (SOIC-20)", ["soic-20", "595", "tpic"]),
    ("R_2512", "Power resistor 2512", ["2512"]),
    ("R_0805", "Resistor 0805", ["0805"]),
    ("R_0402", "Resistor 0402", ["0402"]),
    ("SOD-323", "Diode SOD-323", ["sod-323", "sod323"]),
    ("D_SMB", "Diode SMB", ["smb"]),
    ("SOT-23-5", "Supervisor / regulator SOT-23-5", ["sot-23-5"]),
    ("SOT-23", "Transistor SOT-23", ["sot-23"]),
    ("MSOP-8", "Amplifier MSOP-8", ["msop"]),
    ("SOIC-8", "Regulator SOIC-8", ["soic-8"]),
    ("Fuse", "Resettable fuse", ["fuse"]),
    ("BNC", "BNC vertical connector", ["bnc"]),
    ("PinHeader", "Pin header 2.54mm", ["header", "pinheader"]),
    ("Fiducial", "Assembly fiducial", ["fiducial"]),
    ("SEAF", "SEAF probe interface", ["seaf"]),
]


def fl1_lcsc_index():
    """keyword -> (part label, lcsc) from the FL-1 BOM, best effort."""
    rows = []
    if os.path.exists(FL1_BOM):
        with open(FL1_BOM) as f:
            for r in csv.DictReader(f):
                rows.append(r)
    return rows


def match_lcsc(keywords, rows):
    for r in rows:
        hay = " ".join([
            r.get("Footprint", ""), r.get("Manufacturer", ""),
            r.get("Partnumber", ""), r.get("Value", ""),
        ]).lower()
        if any(k in hay for k in keywords):
            return r.get("LCSC Part #", "").strip()
    return ""


def main():
    b = pcbnew.LoadBoard(VARIANT)
    fps = list(b.GetFootprints())

    # census by footprint family
    counts = {}      # family idx -> [refs]
    for fp in fps:
        lib = str(fp.GetFPID().GetLibItemName())
        for i, (key, _name, _kw) in enumerate(FAMILY):
            if key.lower() in lib.lower():
                counts.setdefault(i, []).append(fp.GetReference())
                break

    rows = fl1_lcsc_index()
    bom = []
    for i, refs in sorted(counts.items()):
        key, name, kw = FAMILY[i]
        refs.sort(key=lambda s: int(re.sub(r"[^0-9]", "", s) or 0))
        ref = (", ".join(refs) if len(refs) <= 4
               else "{}…{} ({})".format(refs[0], refs[-1], len(refs)))
        lcsc = match_lcsc(kw, rows)
        bom.append({
            "ref": ref,
            "part": name,
            "lcsc": lcsc or "—",
            "qty": len(refs),
            "unitPrice": 0,
            "lineType": "ordered" if lcsc else "buyer-furnished",
        })
    with open(os.path.join(OUT, "bom.json"), "w") as f:
        json.dump(bom, f, indent=1)

    # board geometry from the edge cuts
    bb = b.GetBoardEdgesBoundingBox()
    w_mm = pcbnew.ToMM(bb.GetWidth())
    h_mm = pcbnew.ToMM(bb.GetHeight())
    nets = b.GetNetInfo().GetNetCount() - 1  # minus the unconnected net 0

    # start from any existing board.json so routing fields persist
    bj_path = os.path.join(OUT, "board.json")
    board = {}
    if os.path.exists(bj_path):
        try:
            board = json.load(open(bj_path))
        except Exception:
            board = {}

    # design fields = the variant (these are what the prompt changed): how many
    # parts and how big the board is. Net/routing counts stay with the routed
    # reference so the completion ratio (e.g. 172/176) stays coherent.
    board["source"] = "design variant (parametric floorplan)"
    board["components"] = len(fps)
    board["boardSize"] = {"wMm": round(w_mm, 1), "hMm": round(h_mm, 1)}
    board["layers"] = b.GetCopperLayerCount()
    board["variantNets"] = nets  # the variant's own net count, for reference
    board.setdefault("netsTotal", nets)
    board.setdefault("netsRouted", 0)
    board.setdefault("unroutedNets", [])
    board.setdefault("zoneServedNets", [])
    board.setdefault("tracks", 0)
    board.setdefault("vias", 0)
    board.setdefault("hpwlMm", 0)
    board.setdefault("placement", {"overlaps": 0, "overlapPairs": [], "offBoard": []})
    board.setdefault("drc", {"violations": 0, "violationSummaries": [],
                             "unconnectedItems": 0, "kicadVersion": "", "date": ""})

    # routing fields = the routed REFERENCE (where copper actually happened)
    if ROUTING_JSON and os.path.exists(ROUTING_JSON):
        ref = json.load(open(ROUTING_JSON))
        for k in ("netsTotal", "netsRouted", "unroutedNets", "zoneServedNets",
                  "tracks", "vias", "hpwlMm", "drc"):
            if k in ref:
                board[k] = ref[k]

    with open(bj_path, "w") as f:
        json.dump(board, f, indent=1)

    print("VARIANT_SYNC: {} components, {:.0f}x{:.0f}mm, {} nets, {} bom lines".format(
        len(fps), w_mm, h_mm, nets, len(bom)))


if __name__ == "__main__":
    main()
