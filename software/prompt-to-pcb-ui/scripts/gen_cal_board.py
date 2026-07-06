"""Real FL-1 Calibration / Reference board generator (Phase 12 fix).

Not the ADS1115 measurement front-end relabeled — this board actually contains
the parts that define a calibration/reference board: a precision voltage
reference (REF3025), a resistor divider producing a known divided node, an ADS1115
measurement path reading BOTH the reference and the divided node, a board-ID I2C
EEPROM (24LC02), an FL-1 instrument-bus header, and labeled test points on every
reference/measurement node. All parts are ingested UCS components — nothing faked.

  <kicad-python3> gen_cal_board.py <out_board.kicad_pcb>
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "blocks"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import compose  # noqa: E402
import ingest_library  # noqa: E402

out = sys.argv[1]
nets = compose.Nets()
compose._DEVICES[:] = []
body = ""
X0, Y0 = 20.0, 20.0

REF = ingest_library.get("REF3025")
ADC = ingest_library.get("ADS1115IDGS")
EE = ingest_library.get("24LC02")
missing = [n for n, s in (("REF3025", REF), ("ADS1115", ADC), ("24LC02", EE)) if not s]
if missing:
    print("CAL_BLOCKED:" + json.dumps({"missing_required_parts": missing}))
    sys.exit(2)


def place(spec, ref, x, y, pmap):
    lib, name = spec["kicad_footprint"].split(":", 1)
    compose._DEVICES.append({"ref": ref, "type": spec["category"], "name": spec["mpn"],
                             "footprint": name})
    return compose.place(lib, name, ref, x, y, 0, pmap, nets)


# ---- controller: RP2040 top-left (I2C master; it already adds the pull-ups) ----
mb, mw, mh = compose.block_mcu_pico(X0 + 2, Y0 + 2, {"i2c_sda": "I2C_SDA", "i2c_scl": "I2C_SCL"}, nets)
body += mb
compose._DEVICES.append({"ref": "U1", "type": "mcu", "name": "RP2040"})
xr = X0 + 42                       # analog chain to the RIGHT of the Pico block

# ---- precision reference: REF3025 -> REF_OUT ----------------------------------
body += place(REF, "U2", xr, Y0 + 8, {"1": "+3V3", "2": "REF_OUT", "3": "GND"})
body += compose.cap("C10", xr, Y0 + 30, "+3V3", "GND", nets)
# resistor divider: REF_OUT -> REF_DIV -> GND (a known, measurable node)
body += compose.res("RCAL1", xr, Y0 + 18, "REF_OUT", "REF_DIV", nets)
body += compose.res("RCAL2", xr, Y0 + 24, "REF_DIV", "GND", nets)

# ---- measurement path: ADS1115 reads REF_OUT + REF_DIV (fine-pitch, room around)
body += place(ADC, "U3", xr + 26, Y0 + 10, {
    "1": "GND", "3": "GND", "8": "+3V3", "9": "I2C_SDA", "10": "I2C_SCL",
    "4": "REF_OUT", "5": "REF_DIV", "6": "GND", "7": "GND", "2": "GND"})
body += compose.cap("C11", xr + 26, Y0 + 30, "+3V3", "GND", nets)

# ---- board-ID EEPROM: 24LC02 (I2C, address 0x50) -----------------------------
body += place(EE, "U4", xr + 52, Y0 + 10, {
    "1": "GND", "2": "GND", "3": "GND", "4": "GND", "5": "I2C_SDA",
    "6": "I2C_SCL", "7": "GND", "8": "+3V3"})
body += compose.cap("C12", xr + 52, Y0 + 30, "+3V3", "GND", nets)

# ---- FL-1 instrument-bus header + labeled test points (below the analog chain) --
py = Y0 + 44
body += compose.place("Connector_PinHeader_2.54mm", "PinHeader_2x03_P2.54mm_Vertical",
                      "J1", xr + 6, py, 0,
                      {"1": "+5V", "2": "+3V3", "3": "I2C_SDA", "4": "I2C_SCL",
                       "5": "GND", "6": "TRIG"}, nets)
compose._DEVICES.append({"ref": "J1", "type": "connector", "name": "FL-1 instrument bus"})
# test points on the reference + measurement nodes (labeled cal nodes)
for i, net in enumerate(["REF_OUT", "REF_DIV", "I2C_SDA", "I2C_SCL"]):
    body += compose.tp("TP%d" % (i + 1), xr + 30 + i * 7, py, net, nets)

BW, BH = 124.0, 58.0
body = compose._unique_refs(body)
p = '(kicad_pcb (version 20240108) (generator "ee-lab-compose") (generator_version "8.0")\n'
p += '  (general (thickness 1.6))\n  (paper "A4")\n' + compose.LAYERS
p += '  (setup (pad_to_mask_clearance 0))\n'
for i, nm in enumerate(nets.order):
    p += '  (net {} "{}")\n'.format(i, nm)
p += ('  (gr_rect (start {} {}) (end {} {}) (stroke (width 0.15) (type default))'
      ' (fill none) (layer "Edge.Cuts") (uuid "{}"))\n').format(X0, Y0, X0 + BW, Y0 + BH, compose.U())
for lyr, net in (("F.Cu", "GND"), ("B.Cu", "GND"), ("In1.Cu", "GND"), ("In2.Cu", "+3V3")):
    p += compose.gzone(net, lyr, X0, Y0, X0 + BW, Y0 + BH, nets)
p += body + ')\n'
open(out, "w").write(p)

base = os.path.splitext(out)[0]
# a fine-pitch board needs the fab_6mil rule + finer via class (like synth)
open(base + ".kicad_dru", "w").write('(version 1)\n(rule "fab_6mil"\n  (constraint clearance (min 0.13mm)))\n')
open(base + ".kicad_pro", "w").write(json.dumps({
    "board": {"design_settings": {"rules": {"min_clearance": 0.0, "min_via_diameter": 0.35,
              "min_hole_clearance": 0.2, "min_hole_to_hole": 0.2, "min_via_annular_width": 0.05,
              "min_through_hole_diameter": 0.2, "min_microvia_diameter": 0.2, "min_microvia_drill": 0.1}}},
    "net_settings": {"classes": [{"name": "Default", "clearance": 0.2, "track_width": 0.2,
                     "via_diameter": 0.6, "via_drill": 0.3, "microvia_diameter": 0.3,
                     "microvia_drill": 0.1, "diff_pair_gap": 0.25, "diff_pair_width": 0.2,
                     "priority": 2147483647}]},
    "meta": {"filename": os.path.basename(base) + ".kicad_pro", "version": 3}}))
json.dump(compose._DEVICES, open(base + ".devices.json", "w"))
print("CAL_BOARD parts=%d nets=%d required=[REF3025,ADS1115,24LC02,divider,EEPROM,bus,testpoints] -> %s"
      % (len(compose._DEVICES), len(nets.order) - 1, out))
