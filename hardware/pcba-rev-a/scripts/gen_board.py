"""Generate the populated Rev A board (floorplan study) using REAL KiCad
library footprints (with 3D models), nets injected into their pads — so
pcbnew shows the architecture ratsnest and the 3D viewer shows actual
components. Reconciles against the atopile netlist after the 0.15
migration; until then this is the authoritative floorplan.

Run: python3 scripts/gen_board.py
"""
import os
import re
import uuid

FP_DIR = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints"

def U():
    return str(uuid.uuid4())

# ---- nets -------------------------------------------------------------------
NETS = ["", "GND", "+24V", "+5V_COIL", "+3V3_DIG", "+3V3_ANA",
        "SCOPE_A", "SCOPE_B", "DMM_HI", "DMM_LO", "DAQ_1", "DAQ_2",
        "LOGIC_1", "LOGIC_2", "PWR_INJ", "GND_REF",
        "SRCK", "RCK", "OE_N", "SDA", "SCL", "WDI", "SR_DATA"]
PROBES = ["P1", "P2", "P3", "P4", "KFP", "KFN", "KSP", "KSN"]
for p in PROBES:
    NETS += ["TIP_" + p, "NODE_" + p, "GBANK_" + p, "PBANK_" + p]
NET = {n: i for i, n in enumerate(NETS)}

_cache = {}

def load(lib, name):
    key = (lib, name)
    if key not in _cache:
        _cache[key] = open(os.path.join(FP_DIR, lib + ".pretty", name + ".kicad_mod")).read()
    return _cache[key]

def inject_nets(text, netmap):
    """Insert (net id "name") before the closing paren of each matching pad."""
    out, i = [], 0
    pad_re = re.compile(r'\(pad\s+"([^"]*)"')
    while True:
        m = pad_re.search(text, i)
        if not m:
            out.append(text[i:])
            break
        # find matching close paren of this (pad ...)
        depth, j = 0, m.start()
        while True:
            if text[j] == "(":
                depth += 1
            elif text[j] == ")":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        out.append(text[i:j])
        nn = netmap.get(m.group(1))
        if nn:
            out.append(' (net {} "{}")'.format(NET[nn], nn))
        out.append(")")
        i = j + 1
    return "".join(out)

def place(lib, name, ref, x, y, rot=0, netmap=None):
    t = load(lib, name)
    # strip lib header attrs that don't belong on a board instance
    t = re.sub(r'^\(footprint\s+"([^"]+)"', '(footprint "{}:{}"'.format(lib, "\\1"), t)
    # insert position after the first line
    nl = t.index("\n")
    t = t[:nl + 1] + "  (at {} {} {})\n".format(round(x, 3), round(y, 3), rot) + t[nl + 1:]
    t = t.replace('"REF**"', '"{}"'.format(ref), 1)
    if netmap:
        t = inject_nets(t, netmap)
    return "  " + t.strip() + "\n"

# custom SEAF (no KiCad lib equivalent) — pads only, no 3D
def seaf(ref, x, y):
    names = ["TIP_P1", "TIP_P2", "TIP_P3", "TIP_P4", "TIP_KFP", "TIP_KFN",
             "TIP_KSP", "TIP_KSN", "GND", "GND", "SDA", "SCL", "", "GND"]
    s = '  (footprint "EE:SEAF14" (layer "F.Cu") (uuid "{}")\n'.format(U())
    s += '    (at {} {} 90)\n'.format(x, y)
    s += ('    (fp_text reference "{}" (at 0 -8) (layer "F.SilkS") (uuid "{}")\n'
          '      (effects (font (size 0.7 0.7) (thickness 0.11))))\n').format(ref, U())
    s += ('    (fp_rect (start -6 -2.6) (end 6 2.6) (stroke (width 0.12) (type default))'
          ' (fill none) (layer "F.SilkS") (uuid "{}"))\n').format(U())
    for i, nn in enumerate(names):
        col, row = i % 7, i // 7
        netpart = ' (net {} "{}")'.format(NET[nn], nn) if nn else ""
        s += ('    (pad "{}" smd rect (at {} {}) (size 0.7 0.9)\n'
              '      (layers "F.Cu" "F.Paste" "F.Mask"){} (uuid "{}"))\n').format(
            i + 1, -3.81 + col * 1.27, -0.65 + row * 1.3, netpart, U())
    return s + "  )\n"

# ---- placement (200 x 140 board, measured courtyard pitches) -----------------
X0, Y0 = 40.0, 40.0
BW, BH = 200.0, 146.0
body = ""
refn = {}

def nref(p):
    refn[p] = refn.get(p, 0) + 1
    return "{}{}".format(p, refn[p])

G6K = ("Relay_SMD", "Relay_DPDT_Omron_G6K-2F-Y")
REED = ("Relay_THT", "Relay_SPST_StandexMeder_SIL_Form1A")
R0805 = ("Resistor_SMD", "R_0805_2012Metric")
R0402 = ("Resistor_SMD", "R_0402_1005Metric")
R2512 = ("Resistor_SMD", "R_2512_6332Metric")
SOD323 = ("Diode_SMD", "D_SOD-323")
SOT23 = ("Package_TO_SOT_SMD", "SOT-23")
SOT235 = ("Package_TO_SOT_SMD", "SOT-23-5")
MSOP8 = ("Package_SO", "MSOP-8_3x3mm_P0.65mm")
SOIC8 = ("Package_SO", "SOIC-8_3.9x4.9mm_P1.27mm")
SOIC20 = ("Package_SO", "SOIC-20W_7.5x12.8mm_P1.27mm")
SMB = ("Diode_SMD", "D_SMB")
FUSE = ("Fuse", "Fuse_1812_4532Metric")
PICO = ("Module", "RaspberryPi_Pico_SMD_HandSolder")
BNCV = ("Connector_Coaxial", "BNC_Amphenol_031-5539_Vertical")
HDR = lambda n: ("Connector_PinHeader_2.54mm", "PinHeader_1x{:02d}_P2.54mm_Vertical".format(n))

# north: power row y 8 + J2
body += place(*FUSE, ref=nref("F"), x=X0 + 12, y=Y0 + 8, netmap={"1": "+24V", "2": "+24V"})
body += place(*SMB, ref=nref("D"), x=X0 + 20, y=Y0 + 8, netmap={"1": "+24V", "2": "GND"})
body += place(*SOIC8, ref=nref("U"), x=X0 + 30, y=Y0 + 8, netmap={
    "7": "+24V", "4": "GND", "8": "+5V_COIL"})
body += place(*R2512, ref=nref("R"), x=X0 + 40, y=Y0 + 8, netmap={"1": "+5V_COIL", "2": "+5V_COIL"})
body += place(*SOIC8, ref=nref("U"), x=X0 + 50, y=Y0 + 8, netmap={
    "1": "+5V_COIL", "4": "GND", "8": "+3V3_DIG"})
body += place(*MSOP8, ref=nref("U"), x=X0 + 59, y=Y0 + 8, netmap={
    "1": "+5V_COIL", "4": "GND", "8": "+3V3_ANA"})
body += place(*SOT235, ref=nref("U"), x=X0 + 67, y=Y0 + 8, netmap={
    "1": "SDA", "3": "SCL", "2": "GND", "5": "+3V3_DIG"})
body += place(*HDR(2), ref=nref("J"), x=X0 + 80, y=Y0 + 8, netmap={"1": "+24V", "2": "GND"})

# sinks row: 12x SOIC20 rot 0, pitch 13.5, y 26
for i in range(12):
    body += place(*SOIC20, ref=nref("U"), x=X0 + 30 + i * 12.4, y=Y0 + 26, netmap={
        "2": "+5V_COIL", "10": "GND", "3": "SR_DATA", "13": "SRCK", "12": "RCK", "9": "OE_N"})

# west: J10 + 8 protection channels (y 44..107, pitch 9)
body += seaf(nref("J"), X0 + 7, Y0 + 75)
for i, p in enumerate(PROBES):
    y = Y0 + 44 + i * 9
    body += place(*R0805, ref=nref("F"), x=X0 + 14, y=y, netmap={"1": "TIP_" + p, "2": "NODE_" + p})
    body += place(*SOT23, ref=nref("D"), x=X0 + 19, y=y, netmap={"1": "NODE_" + p, "3": "+3V3_ANA"})
    body += place(*SOD323, ref=nref("D"), x=X0 + 23.5, y=y, netmap={"1": "NODE_" + p, "2": "GND"})
    body += place(*MSOP8, ref=nref("U"), x=X0 + 29, y=y,
                  netmap={"1": "NODE_" + p, "8": "+3V3_ANA", "4": "GND"})

# center: 8 lane-selector trees, relays rot 90 (12.3 wide x 9.3 tall):
# col pitch 13, row pitch 10 -> rows y 44..114
LANES_G = ["SCOPE_A", "SCOPE_B", "DAQ_1", "DAQ_2", "LOGIC_1", "LOGIC_2", "PWR_INJ"]
for i, p in enumerate(PROBES):
    cx = X0 + 42 + i * 13
    body += place(*G6K, ref=nref("K"), x=cx, y=Y0 + 44, rot=90, netmap={
        "1": "+5V_COIL", "4": "NODE_" + p, "3": "GBANK_" + p, "5": "PBANK_" + p})
    for j, lane in enumerate(LANES_G):
        body += place(*G6K, ref=nref("K"), x=cx, y=Y0 + 54 + j * 9.4, rot=90, netmap={
            "1": "+5V_COIL", "4": "GBANK_" + p, "3": lane})

# south: reed bank, 3 rows of 9 (24 matrix + 3 reference), pitch 20.5 x 8
LANES_P = ["DMM_HI", "DMM_LO", "GND_REF"]
reed_jobs = []
for i, p in enumerate(PROBES):
    for lane in LANES_P:
        reed_jobs.append({"1": "+5V_COIL", "2": "PBANK_" + p, "3": lane})
for i in range(3):  # reference block reeds
    reed_jobs.append({"1": "+5V_COIL", "2": "DMM_HI", "3": "GND"})
for k, nm in enumerate(reed_jobs):
    row, col = divmod(k, 9)
    body += place(*REED, ref=nref("K"), x=X0 + 16 + col * 20.5, y=Y0 + 121 + row * 8, netmap=nm)
body += place(*R0805, ref=nref("R"), x=X0 + 16, y=Y0 + 112, netmap={"1": "DMM_HI", "2": "GND"})
body += place(*R0805, ref=nref("R"), x=X0 + 24, y=Y0 + 112, netmap={"1": "DMM_HI", "2": "GND"})

# east: Pico 2 vertical + supervisors
body += place(*PICO, ref=nref("U"), x=X0 + 160, y=Y0 + 78, rot=0, netmap={
    "39": "+24V", "38": "GND", "4": "SRCK", "5": "SR_DATA", "6": "RCK",
    "7": "OE_N", "9": "SDA", "10": "SCL", "11": "WDI", "36": "+3V3_DIG"})
body += place(*SOT235, ref=nref("U"), x=X0 + 143, y=Y0 + 50, netmap={
    "1": "OE_N", "2": "GND", "4": "WDI", "5": "+3V3_DIG"})
body += place(*SOT235, ref=nref("U"), x=X0 + 143, y=Y0 + 58, netmap={
    "1": "SCL", "2": "GND", "3": "SDA", "5": "+3V3_DIG"})

# far east: instrument connectors
body += place(*BNCV, ref=nref("J"), x=X0 + 188, y=Y0 + 14, netmap={"1": "SCOPE_A", "2": "GND"})
body += place(*BNCV, ref=nref("J"), x=X0 + 188, y=Y0 + 36, netmap={"1": "SCOPE_B", "2": "GND"})
body += place(*HDR(4), ref=nref("J"), x=X0 + 190, y=Y0 + 54, rot=0, netmap={
    "1": "DMM_HI", "2": "DMM_LO", "3": "GND_REF", "4": "GND"})
body += place(*HDR(8), ref=nref("J"), x=X0 + 190, y=Y0 + 74, rot=0, netmap={
    "1": "DAQ_1", "2": "DAQ_2", "3": "LOGIC_1", "4": "LOGIC_2",
    "5": "GND", "6": "GND", "7": "GND", "8": "GND"})
body += place(*HDR(2), ref=nref("J"), x=X0 + 190, y=Y0 + 96, rot=0, netmap={
    "1": "PWR_INJ", "2": "GND"})

# ---- assemble ------------------------------------------------------------------
def grect(x0, y0, x1, y1, layer, w=0.15):
    return ('  (gr_rect (start {} {}) (end {} {})\n'
            '    (stroke (width {}) (type default)) (fill none)\n'
            '    (layer "{}") (uuid "{}"))\n').format(x0, y0, x1, y1, w, layer, U())

def gcircle(cx, cy, r, layer):
    return ('  (gr_circle (center {} {}) (end {} {})\n'
            '    (stroke (width 0.15) (type default)) (fill none)\n'
            '    (layer "{}") (uuid "{}"))\n').format(cx, cy, cx + r, cy, layer, U())

def gtext(s, x, y, layer, size=1.5, bold=False):
    b = " (bold yes)" if bold else ""
    return ('  (gr_text "{}" (at {} {} 0) (layer "{}") (uuid "{}")\n'
            '    (effects (font (size {} {}) (thickness {}){})))\n').format(
        s, x, y, layer, U(), size, size, round(size * 0.15, 3), b)

p = '(kicad_pcb (version 20240108) (generator "ee-lab-boardgen") (generator_version "8.0")\n'
p += '  (general (thickness 1.6) (legacy_teardrops no))\n  (paper "A3")\n'
p += '''  (layers
    (0 "F.Cu" signal)
    (1 "In1.Cu" signal "GND")
    (2 "In2.Cu" signal "PWR")
    (31 "B.Cu" signal)
    (32 "B.Adhes" user "B.Adhesive")
    (33 "F.Adhes" user "F.Adhesive")
    (34 "B.Paste" user)
    (35 "F.Paste" user)
    (36 "B.SilkS" user "B.Silkscreen")
    (37 "F.SilkS" user "F.Silkscreen")
    (38 "B.Mask" user)
    (39 "F.Mask" user)
    (40 "Dwgs.User" user "User.Drawings")
    (41 "Cmts.User" user "User.Comments")
    (42 "Eco1.User" user "User.Eco1")
    (43 "Eco2.User" user "User.Eco2")
    (44 "Edge.Cuts" user)
    (45 "Margin" user)
    (46 "B.CrtYd" user "B.Courtyard")
    (47 "F.CrtYd" user "F.Courtyard")
    (48 "B.Fab" user)
    (49 "F.Fab" user)
  )
'''
p += '  (setup (pad_to_mask_clearance 0) (allow_soldermask_bridges_in_footprints no)\n'
p += '    (pcbplotparams (layerselection 0x00010fc_ffffffff) (plot_on_all_layers_selection 0x0000000_00000000)))\n'
for i, n in enumerate(NETS):
    p += '  (net {} "{}")\n'.format(i, n)
p += grect(X0, Y0, X0 + BW, Y0 + BH, "Edge.Cuts")
for cx, cy in ((5, 5), (BW - 5, 5), (5, BH - 5), (BW - 5, BH - 5)):
    p += gcircle(X0 + cx, Y0 + cy, 1.6, "Edge.Cuts")
p += gtext("FIRSTLIGHT FL-1 - RELAY/PROBE MATRIX REV A - FLOORPLAN", X0 + BW / 2, Y0 - 5, "Dwgs.User", 2.2, True)
p += gtext("ANALOG ISLAND - reed bank + references", X0 + 100, Y0 + 136, "Cmts.User", 1.4)
p += body
p += ')\n'

out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "elec", "layout", "rev-a", "rev-a.kicad_pcb")
open(os.path.abspath(out), "w").write(p)
print("written:", os.path.abspath(out))
print("components:", sum(refn.values()), "| nets:", len(NETS))
