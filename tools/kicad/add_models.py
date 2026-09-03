#!/usr/bin/env python3
"""Attach stock KiCad 3D models to the chip-scale board's generic footprints so it
renders as a populated PCBA (component bodies on the board), not a bare PCB.

circuit-json-to-kicad emits footprints with pads but no 3D model reference, so
kicad-cli's --subst-models has nothing to place. This pass matches each footprint
(by the parts list: reference -> footprint type + kind) to a stock KiCad .step
model — a QFN body for ICs, an 0402 chip body for passives — and attaches it. The
model sits at the footprint origin the way KiCad expects, and inherits the
footprint's placement + rotation. Approximate bodies for VISUALIZATION (so the
board reads as an assembly), not a manufacturing-accurate model.

Usage: <kicad-python> add_models.py <in.kicad_pcb> <out.kicad_pcb> <parts.json>
  parts.json = [{"name":"U1","footprint":"qfn32","kind":"chip"}, ...]
Prints one JSON line: {"models": N}
"""
import sys
import os
import re
import json
import pcbnew

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "hardware", "blocks"))
import toolchain  # noqa: E402

inp, outp, partsf = sys.argv[1], sys.argv[2], sys.argv[3]
parts = {p["name"]: p for p in json.load(open(partsf))}

MDL = toolchain.kicad_3dmodels()
# QFN/DFN bodies by pin count (the nearest available size is used for any count)
QFN = {
    6: f"{MDL}/Package_DFN_QFN.3dshapes/DFN-6-1EP_2x2mm_P0.5mm_EP0.61x1.42mm.step",
    16: f"{MDL}/Package_DFN_QFN.3dshapes/QFN-16-1EP_3x3mm_P0.5mm_EP1.7x1.7mm.step",
    24: f"{MDL}/Package_DFN_QFN.3dshapes/QFN-24-1EP_3x3mm_P0.4mm_EP1.75x1.6mm.step",
    32: f"{MDL}/Package_DFN_QFN.3dshapes/QFN-32-1EP_4x4mm_P0.4mm_EP2.65x2.65mm.step",
    48: f"{MDL}/Package_DFN_QFN.3dshapes/QFN-48-1EP_7x7mm_P0.5mm_EP5.15x5.15mm.step",
}
CAP = f"{MDL}/Capacitor_SMD.3dshapes/C_0402_1005Metric.step"
RES = f"{MDL}/Resistor_SMD.3dshapes/R_0402_1005Metric.step"
IND = f"{MDL}/Inductor_SMD.3dshapes/L_0402_1005Metric.step"


def model_for(part):
    fp = str(part.get("footprint", ""))
    kind = str(part.get("kind", ""))
    m = re.match(r"qfn(\d+)", fp)
    if m:
        n = int(m.group(1))
        best = min(QFN, key=lambda a: abs(a - n))  # nearest available body
        return QFN[best]
    if fp in ("0402", "0201", "0603"):
        if kind == "resistor":
            return RES
        if kind == "capacitor":
            return CAP
        return IND  # inductor / antenna / LED / generic chip passive
    return None


def norm_ref(ref):
    # freerouting's DSN round-trip mangles "U1" -> "U1_source_component_0"
    return ref.split("_source_component")[0] if "_source_component" in ref else ref


board = pcbnew.LoadBoard(inp)
added = 0
for fp in board.GetFootprints():
    ref = fp.GetReference()
    part = parts.get(ref) or parts.get(norm_ref(ref))
    if not part:
        continue
    path = model_for(part)
    if not path or not os.path.exists(path):
        continue
    m = pcbnew.FP_3DMODEL()
    m.m_Filename = path  # scale (1,1,1) + show=True are the defaults
    fp.Models().push_back(m)
    added += 1

pcbnew.SaveBoard(outp, board)
print(json.dumps({"models": added}))
