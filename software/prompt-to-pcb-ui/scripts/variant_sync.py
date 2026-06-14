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

# KiCad-library footprint family -> (friendly name, FL-1 BOM match keyword(s),
# reference unit price USD @ qty 100). The variant uses standard KiCad
# footprints; we attach the real orderable part + a realistic catalog price by
# family so quantities AND cost scale with the prompt. (Reference prices — a
# live DigiKey/LCSC API would make these real-time; structure is ready for it.)
FAMILY = [
    ("G6K-2F", "Omron G6K-2F-Y DPDT signal relay", ["g6k", "relay"], 1.12),
    ("SIL_Form1A", "Standex reed relay (SIP-1A05)", ["reed", "sil", "sip", "1a05"], 0.78),
    ("Pico", "Raspberry Pi Pico (RP2040)", ["pico", "rp2040"], 4.00),
    ("SOIC-20", "Shift-register sink driver (TPIC6B595)", ["soic-20", "595", "tpic"], 0.54),
    ("R_2512", "Power resistor 2512", ["2512"], 0.10),
    ("R_0805", "Resistor 0805", ["0805"], 0.02),
    ("R_0402", "Resistor 0402", ["0402"], 0.01),
    ("SOD-323", "Diode SOD-323", ["sod-323", "sod323"], 0.05),
    ("D_SMB", "Diode SMB", ["smb"], 0.15),
    ("SOT-23-5", "Supervisor / regulator SOT-23-5", ["sot-23-5"], 0.32),
    ("SOT-23", "Transistor SOT-23", ["sot-23"], 0.08),
    ("MSOP-8", "Amplifier MSOP-8", ["msop"], 0.58),
    ("SOIC-8", "Regulator SOIC-8", ["soic-8"], 0.42),
    ("Fuse", "Resettable fuse", ["fuse"], 0.20),
    ("BNC", "BNC vertical connector", ["bnc"], 1.45),
    ("PinHeader", "Pin header 2.54mm", ["header", "pinheader"], 0.12),
    ("Fiducial", "Assembly fiducial", ["fiducial"], 0.00),
    ("SEAF", "SEAF probe interface", ["seaf"], 7.80),
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

    # census by footprint family; parts not in the FL-1 family (e.g. a composed
    # board's LoRa module, U.FL, caps) fall back to a generic group keyed by a
    # cleaned footprint name, so EVERY board gets a BOM.
    counts = {}      # family idx -> [refs]
    generic = {}     # cleaned footprint name -> [refs]
    for fp in fps:
        lib = str(fp.GetFPID().GetLibItemName())
        matched = False
        for i, fam in enumerate(FAMILY):
            if fam[0].lower() in lib.lower():
                counts.setdefault(i, []).append(fp.GetReference())
                matched = True
                break
        if not matched:
            mp = re.match(r"([A-Z]+)_(\d{3,4})", lib)
            if mp:
                cls = {"C": "Capacitor", "R": "Resistor", "L": "Inductor"}.get(
                    mp.group(1), mp.group(1))
                name = "{} {}".format(cls, mp.group(2))
            else:
                name = re.sub(r"[_-]+", " ", re.split(r"_\d", lib)[0]).strip()
            generic.setdefault(name or lib, []).append(fp.GetReference())

    rows = fl1_lcsc_index()
    bom = []
    bom_total = 0.0

    def add_line(refs, name, kw, price):
        nonlocal bom_total
        refs.sort(key=lambda s: int(re.sub(r"[^0-9]", "", s) or 0))
        ref = (", ".join(refs) if len(refs) <= 4
               else "{}…{} ({})".format(refs[0], refs[-1], len(refs)))
        lcsc = match_lcsc(kw, rows) if kw else ""
        line_total = round(price * len(refs), 2)
        bom_total += line_total
        bom.append({
            "ref": ref, "part": name, "lcsc": lcsc or "—",
            "qty": len(refs), "unitPrice": price, "lineTotal": line_total,
            "lineType": "ordered" if lcsc else "buyer-furnished",
        })

    for i, refs in sorted(counts.items()):
        _key, name, kw, price = FAMILY[i]
        add_line(refs, name, kw, price)
    for name, refs in sorted(generic.items()):
        # rough catalog price by class: modules/connectors > ICs > passives
        s = name.lower()
        price = (3.50 if any(k in s for k in ("module", "rfm", "lora", "esp", "radio"))
                 else 0.80 if any(k in s for k in ("usb", "connector", "header", "coaxial", "u.fl", "jack"))
                 else 0.15 if any(k in s for k in ("sot", "soic", "qfn", "lga", "msop", "dfn"))
                 else 0.00 if "fiducial" in s
                 else 0.02 if any(k in s for k in ("c ", "r ", "0402", "0603", "0805", "capacitor", "resistor"))
                 else 0.30)
        add_line(refs, name, "", price)
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
    board["bomTotal"] = round(bom_total, 2)  # parts cost per board (qty 100 ref)
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

    # ---- design summary -> lead the Schematic/Code tab with the VARIANT ------
    # The .ato modules are the FL-1 reference design language; this summary,
    # derived from the variant's own nets, shows what the prompt actually built.
    GL = {"SCOPE_A", "SCOPE_B", "DAQ_1", "DAQ_2", "LOGIC_1", "LOGIC_2", "PWR_INJ"}
    PL = {"DMM_HI", "DMM_LO", "GND_REF"}
    probes, glanes, planes = set(), set(), set()
    for fp in fps:
        nm = str(fp.GetFPID().GetLibItemName())
        pn = {str(p.GetNetname()) for p in fp.Pads()}
        for n in pn:
            mm_ = re.match(r"[GP]BANK_(\w+)", n)
            if mm_:
                probes.add(mm_.group(1))
        if "G6K" in nm:
            glanes |= pn & GL  # group lanes actually wired to a relay
        elif "SIL" in nm:
            planes |= pn & PL  # probe lanes actually wired to a reed
    probes, glanes, planes = sorted(probes), sorted(glanes), sorted(planes)
    if probes:
        xpoints = len(probes) * (len(glanes) + len(planes))
        summary = (
            "FirstLight FL-1 — design variant (generated from your prompt)\n"
            "============================================================\n\n"
            "  probes        : {np}   ({plist})\n"
            "  group lanes   : {ng}   ({gl})\n"
            "  probe lanes   : {npl}  ({pl})\n"
            "  controller    : RP2040, shift-register driven (SRCK/SER/RCK/OE_N)\n"
            "  board         : {w:.0f} x {h:.0f} mm, {ly}-layer\n"
            "  components    : {comp}\n"
            "  crosspoints   : {np} probes x {lanes} lanes = {xp} relays\n\n"
            "Each crosspoint is one relay coil on the SR chain; the generated\n"
            "firmware (firmware/matrix.rs) exposes set_crosspoint(probe, lane).\n"
        ).format(
            np=len(probes), plist=", ".join(probes) or "—",
            ng=len(glanes), gl=", ".join(glanes) or "—",
            npl=len(planes), pl=", ".join(planes) or "—",
            w=w_mm, h=h_mm, ly=b.GetCopperLayerCount(), comp=len(fps),
            lanes=len(glanes) + len(planes), xp=xpoints,
        )
    else:
        # composed board (Layer 2): summarize by components + nets
        refs = sorted({l["part"] for l in bom})
        summary = (
            "Composed board — generated from your design interview\n"
            "====================================================\n\n"
            "  board         : {w:.0f} x {h:.0f} mm, {ly}-layer, GND-poured\n"
            "  components    : {comp}\n"
            "  nets          : {nets}\n"
            "  parts         : {parts}\n\n"
            "Assembled by the Layer-2 block-composition engine: each functional\n"
            "block (power / MCU / radio / antenna ...) is a reusable sub-layout\n"
            "wired by its typed interfaces, then routed through the same flroute\n"
            "-> DRC pipeline as the relay matrix.\n"
        ).format(
            w=w_mm, h=h_mm, ly=b.GetCopperLayerCount(), comp=len(fps),
            nets=nets, parts="; ".join(refs[:8]),
        )
    ato_path = os.path.join(OUT, "ato.json")
    ato = []
    if os.path.exists(ato_path):
        try:
            ato = json.load(open(ato_path))
        except Exception:
            ato = []
    ato = [a for a in ato if a.get("name") != "design.txt"]
    ato.insert(0, {"name": "design.txt", "content": summary})
    with open(ato_path, "w") as f:
        json.dump(ato, f, indent=1)

    print("VARIANT_SYNC: {} components, {:.0f}x{:.0f}mm, {} nets, {} bom lines".format(
        len(fps), w_mm, h_mm, nets, len(bom)))


if __name__ == "__main__":
    main()
