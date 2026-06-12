"""Generate the populated Rev A board (floorplan study) directly from the
design structure in elec/src/*.ato — every component placed per the
kicad-mcp placement plan, with the real net structure so the ratsnest
shows the architecture. This is the board the atopile netlist sync will
reconcile against once the 0.15 syntax migration lands; until then it is
the authoritative floorplan.

Run: python3 scripts/gen_board.py   (writes elec/layout/rev-a/rev-a.kicad_pcb)
"""
import uuid

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

def net(name):
    return '(net {} "{}")'.format(NET.get(name, 0), name if name in NET else "")

# ---- pad/footprint primitives ------------------------------------------------
def smd_pad(num, x, y, w, h, netname=""):
    return ('    (pad "{}" smd rect (at {} {}) (size {} {})\n'
            '      (layers "F.Cu" "F.Paste" "F.Mask") {} (uuid "{}"))\n').format(
        num, round(x, 3), round(y, 3), w, h, net(netname), U())

def th_pad(num, x, y, d, drill, netname=""):
    return ('    (pad "{}" thru_hole circle (at {} {}) (size {} {}) (drill {})\n'
            '      (layers "*.Cu" "*.Mask") {} (uuid "{}"))\n').format(
        num, round(x, 3), round(y, 3), d, d, drill, net(netname), U())

def outline(w, h):
    return ('    (fp_rect (start {} {}) (end {} {})\n'
            '      (stroke (width 0.12) (type default)) (fill none)\n'
            '      (layer "F.SilkS") (uuid "{}"))\n').format(
        -w / 2, -h / 2, w / 2, h / 2, U())

def footprint(name, ref, x, y, rot, body, pads):
    s = '  (footprint "EE:{}" (layer "F.Cu") (uuid "{}")\n'.format(name, U())
    s += '    (at {} {} {})\n'.format(round(x, 3), round(y, 3), rot)
    s += '    (attr smd exclude_from_pos_files)\n'
    s += ('    (fp_text reference "{}" (at 0 {}) (layer "F.SilkS") (uuid "{}")\n'
          '      (effects (font (size 0.7 0.7) (thickness 0.11))))\n').format(
        ref, -body[1] / 2 - 1.0, U())
    s += outline(*body)
    s += pads
    s += '  )\n'
    return s

# ---- component builders (pad coords are footprint-local) ----------------------
def relay_g6k(ref, x, y, nets):
    # nets: dict coil_p, coil_n, com, no, nc
    pads = ""
    pins = [("1", -3.0, -2.7, nets.get("coil_p", "")), ("8", 3.0, -2.7, nets.get("coil_n", "")),
            ("4", -1.0, 2.7, nets.get("com", "")), ("3", -3.0, 2.7, nets.get("no", "")),
            ("5", 1.0, 2.7, nets.get("nc", "")), ("6", 3.0, 2.7, "")]
    for num, px, py, nn in pins:
        pads += smd_pad(num, px, py, 1.1, 0.9, nn)
    return footprint("RELAY_G6K2FY", ref, x, y, 0, (7.4, 6.4), pads)

def reed_sip(ref, x, y, nets):
    pads = ""
    for i, (num, nn) in enumerate([("1", nets.get("coil_p", "")), ("2", nets.get("com", "")),
                                   ("3", nets.get("no", "")), ("4", nets.get("coil_n", ""))]):
        pads += th_pad(num, -3.81 + i * 2.54, 0, 1.6, 0.9, nn)
    return footprint("REED_SIP4", ref, x, y, 90, (12.0, 4.0), pads)

def soic20(ref, x, y, netmap):
    pads = ""
    for i in range(10):
        pads += smd_pad(str(i + 1), -5.715 + i * 1.27, -4.2, 0.6, 1.5, netmap.get(i + 1, ""))
        pads += smd_pad(str(20 - i), -5.715 + i * 1.27, 4.2, 0.6, 1.5, netmap.get(20 - i, ""))
    return footprint("SOIC20W", ref, x, y, 0, (13.0, 7.0), pads)

def small_ic(name, ref, x, y, n, pitch, netmap, body):
    pads = ""
    half = n // 2
    for i in range(half):
        pads += smd_pad(str(i + 1), (-(half - 1) / 2 + i) * pitch, -body[1] / 2 - 0.4, 0.5, 0.9,
                        netmap.get(i + 1, ""))
        pads += smd_pad(str(n - i), (-(half - 1) / 2 + i) * pitch, body[1] / 2 + 0.4, 0.5, 0.9,
                        netmap.get(n - i, ""))
    return footprint(name, ref, x, y, 0, body, pads)

def passive(name, ref, x, y, rot, l, w, n1, n2):
    pads = smd_pad("1", -l / 2, 0, w * 0.9, w, n1) + smd_pad("2", l / 2, 0, w * 0.9, w, n2)
    return footprint(name, ref, x, y, rot, (l, w), pads)

def pico2(ref, x, y):
    pads = ""
    m = {39: "+24V", 38: "GND", 4: "SRCK", 5: "SR_DATA", 6: "RCK", 7: "OE_N",
         9: "SDA", 10: "SCL", 11: "WDI", 36: "+3V3_DIG"}
    for i in range(20):
        pads += th_pad(str(i + 1), -24.13 + i * 2.54, -8.89, 1.7, 1.0, m.get(i + 1, ""))
        pads += th_pad(str(40 - i), -24.13 + i * 2.54, 8.89, 1.7, 1.0, m.get(40 - i, ""))
    return footprint("PICO2_MODULE", ref, x, y, 0, (51.0, 21.0), pads)

def bnc(ref, x, y, sig):
    pads = th_pad("1", 0, 0, 2.2, 1.3, sig) + th_pad("2", 0, 5.08, 3.0, 2.0, "GND")
    return footprint("BNC_TH", ref, x, y, 90, (14.0, 14.0), pads)

def header(ref, x, y, names):
    pads = ""
    for i, nn in enumerate(names):
        pads += th_pad(str(i + 1), -((len(names) - 1) / 2) * 2.54 + i * 2.54, 0, 1.7, 1.0, nn)
    return footprint("HDR{}".format(len(names)), ref, x, y, 90, (len(names) * 2.54 + 2, 5.0), pads)

def seaf(ref, x, y):
    names = ["TIP_P1", "TIP_P2", "TIP_P3", "TIP_P4", "TIP_KFP", "TIP_KFN",
             "TIP_KSP", "TIP_KSN", "GND", "GND", "SDA", "SCL", "", "GND"]
    pads = ""
    for i, nn in enumerate(names):
        col, row = i % 7, i // 7
        pads += smd_pad(str(i + 1), -3.81 + col * 1.27, -0.65 + row * 1.3, 0.7, 0.9, nn)
    return footprint("SEAF14", ref, x, y, 90, (12.0, 5.0), pads)

# ---- board ---------------------------------------------------------------------
X0, Y0 = 50.0, 50.0
body = ""
refn = {"K": 0, "U": 0, "R": 0, "D": 0, "F": 0, "J": 0, "C": 0}

def nref(p):
    refn[p] += 1
    return "{}{}".format(p, refn[p])

# west: J10 + 8 protection channels
body += seaf(nref("J"), X0 + 6, Y0 + 50)
for i, p in enumerate(PROBES):
    y = Y0 + 16 + i * 9
    body += passive("PTC0805", nref("F"), X0 + 13, y, 0, 2.0, 1.25, "TIP_" + p, "NODE_" + p)
    body += small_ic("SOT23", nref("D"), X0 + 17.5, y, 4, 1.9, {1: "NODE_" + p}, (2.9, 1.3))
    body += passive("SOD323", nref("D"), X0 + 21.5, y, 0, 1.7, 1.25, "NODE_" + p, "GND")
    body += small_ic("MSOP8", nref("U"), X0 + 26, y, 8, 0.65, {8: "+3V3_ANA", 4: "GND"}, (3.0, 3.0))

# center: 8 lane-selector trees (8 G6K + 3 reed each)
LANES_G = ["SCOPE_A", "SCOPE_B", "DAQ_1", "DAQ_2", "LOGIC_1", "LOGIC_2", "PWR_INJ"]
LANES_P = ["DMM_HI", "DMM_LO", "GND_REF"]
for i, p in enumerate(PROBES):
    cx = X0 + 36 + i * 8.6
    body += relay_g6k(nref("K"), cx, Y0 + 16,
                      {"coil_p": "+5V_COIL", "com": "NODE_" + p,
                       "nc": "GBANK_" + p, "no": "PBANK_" + p})
    for j, lane in enumerate(LANES_G):
        body += relay_g6k(nref("K"), cx, Y0 + 24 + j * 7.6,
                          {"coil_p": "+5V_COIL", "com": "GBANK_" + p, "no": lane})
    for j, lane in enumerate(LANES_P):
        body += reed_sip(nref("K"), cx, Y0 + 80 + j * 4.6,
                         {"coil_p": "+5V_COIL", "com": "PBANK_" + p, "no": lane})

# east: instrument connectors
body += bnc(nref("J"), X0 + 150, Y0 + 18, "SCOPE_A")
body += bnc(nref("J"), X0 + 150, Y0 + 34, "SCOPE_B")
body += header(nref("J"), X0 + 150, Y0 + 48, ["DMM_HI", "DMM_LO", "GND_REF", "GND"])
body += header(nref("J"), X0 + 150, Y0 + 62, ["DAQ_1", "DAQ_2", "LOGIC_1", "LOGIC_2",
                                              "GND", "GND", "GND", "GND"])
body += header(nref("J"), X0 + 150, Y0 + 76, ["PWR_INJ", "GND"])
body += header(nref("J"), X0 + 118, Y0 + 6, ["+24V", "GND"])  # J2 24V in, north

# north strip: power + 12 coil sinks
body += passive("FUSE1812", nref("F"), X0 + 12, Y0 + 6, 0, 4.5, 3.2, "+24V", "+24V")
body += passive("SMB", nref("D"), X0 + 19, Y0 + 6, 0, 4.3, 3.6, "+24V", "GND")
body += small_ic("SOIC8_BUCK", nref("U"), X0 + 27, Y0 + 6, 8, 1.27, {7: "+24V", 9: "GND", 8: "+5V_COIL"}, (4.9, 3.9))
body += passive("R2512", nref("R"), X0 + 34, Y0 + 6, 0, 6.3, 3.2, "+5V_COIL", "+5V_COIL")
body += small_ic("SON8", nref("U"), X0 + 41, Y0 + 6, 8, 0.5, {1: "+5V_COIL", 2: "GND", 8: "+3V3_DIG"}, (2.0, 2.0))
body += small_ic("MSOP8", nref("U"), X0 + 47, Y0 + 6, 8, 0.65, {1: "+5V_COIL", 2: "GND", 8: "+3V3_ANA"}, (3.0, 3.0))
body += small_ic("SOT23_8", nref("U"), X0 + 53, Y0 + 6, 8, 0.65, {6: "+3V3_DIG", 5: "GND", 1: "SDA", 2: "SCL"}, (2.9, 1.6))
for i in range(12):
    body += soic20(nref("U"), X0 + 64 + i * 8, Y0 + 6,
                   {2: "+5V_COIL", 10: "GND", 3: "SR_DATA", 13: "SRCK", 12: "RCK", 9: "OE_N"})

# south: Pico 2 + watchdog + EEPROM + reference block
body += pico2(nref("U"), X0 + 30, Y0 + 93)
body += small_ic("SOT23_5W", nref("U"), X0 + 60, Y0 + 93, 4, 0.95, {1: "OE_N", 2: "GND", 4: "WDI"}, (2.9, 1.6))
body += small_ic("SOT23_5E", nref("U"), X0 + 66, Y0 + 93, 4, 0.95, {5: "+3V3_DIG", 2: "GND", 3: "SDA", 1: "SCL"}, (2.9, 1.6))
body += passive("R0805", nref("R"), X0 + 118, Y0 + 91, 0, 2.0, 1.25, "DMM_HI", "GND")
body += passive("R0805", nref("R"), X0 + 124, Y0 + 91, 0, 2.0, 1.25, "DMM_HI", "GND")
for i in range(3):
    body += reed_sip(nref("K"), X0 + 132 + i * 5, Y0 + 93, {"coil_p": "+5V_COIL", "com": "DMM_HI", "no": "GND"})

# ---- assemble file --------------------------------------------------------------
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
p += grect(X0, Y0, X0 + 160, Y0 + 100, "Edge.Cuts")
for cx, cy in ((5, 5), (155, 5), (5, 95), (155, 95)):
    p += gcircle(X0 + cx, Y0 + cy, 1.6, "Edge.Cuts")
p += gtext("FIRSTLIGHT FL-1 - RELAY/PROBE MATRIX REV A - FLOORPLAN", X0 + 80, Y0 - 5, "Dwgs.User", 2.2, True)
p += gtext("ANALOG ISLAND - moat, guard DMM_HI/LO", X0 + 128, Y0 + 99, "Cmts.User", 1.2)
p += body
p += ')\n'

import os
out = os.path.join(os.path.dirname(__file__), "..", "elec", "layout", "rev-a", "rev-a.kicad_pcb")
open(os.path.abspath(out), "w").write(p)
print("written:", os.path.abspath(out))
print("components:", sum(refn.values()), "| nets:", len(NETS))
