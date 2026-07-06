"""USB 2.0 high-speed demo board generator (Phase 5).

Builds a minimal but REAL USB-data board the diff-pair router can route + check:
a USB breakout (VBUS/D+/D-/GND), a USBLC6 ESD near it, and an MCU-side header,
placed so the D+/D- pads are aligned for a clean matched pair. Emits the board +
net names; scripts/route_diff_pairs.py then routes USB_DP/USB_DM together and
checks length/skew. Honest: the pair is really routed + checked; impedance stays
advisory (needs a board-house controlled-Z stackup).

  <kicad-python3> gen_highspeed_demo.py <out_board.kicad_pcb>
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "blocks"))
import compose  # noqa: E402

out = sys.argv[1]
nets = compose.Nets()
compose._DEVICES[:] = []
body = ""

X0, Y0, BW, BH = 20.0, 20.0, 46.0, 36.0

# USB breakout header (connector side): 1=VBUS 2=USB_DP 3=USB_DM 4=GND. The pair
# pads (2,3) are on the RIGHT, facing the MCU header.
body += compose.place("Connector_PinHeader_2.54mm", "PinHeader_1x04_P2.54mm_Vertical",
                      "J1", X0 + 4, Y0 + 8, 0,
                      {"1": "VBUS", "2": "USB_DP", "3": "USB_DM", "4": "GND"}, nets)
# USBLC6-2SC6 ESD protection (SOT-23-6) near the connector — required for a USB port
body += compose.place("Package_TO_SOT_SMD", "SOT-23-6", "U2", X0 + 14, Y0 + 20, 0,
                      {"1": "USB_DP", "2": "GND", "3": "USB_DM", "4": "USB_DM",
                       "5": "VBUS", "6": "USB_DP"}, nets)
# MCU-side header (USB device pins), aligned with J1 so D+/D- run parallel
body += compose.place("Connector_PinHeader_2.54mm", "PinHeader_1x04_P2.54mm_Vertical",
                      "J2", X0 + 38, Y0 + 8, 0,
                      {"1": "VBUS", "2": "USB_DP", "3": "USB_DM", "4": "GND"}, nets)
# decoupling on VBUS
body += compose.cap("C1", X0 + 22, Y0 + 30, "VBUS", "GND", nets)

compose._DEVICES.append({"ref": "J1", "type": "connector", "name": "USB breakout"})
compose._DEVICES.append({"ref": "U2", "type": "esd", "name": "USBLC6-2SC6",
                         "footprint": "SOT-23-6"})
compose._DEVICES.append({"ref": "J2", "type": "connector", "name": "MCU USB header"})
body = compose._unique_refs(body)

p = '(kicad_pcb (version 20240108) (generator "ee-lab-compose") (generator_version "8.0")\n'
p += '  (general (thickness 1.6))\n  (paper "A4")\n' + compose.LAYERS
p += '  (setup (pad_to_mask_clearance 0))\n'
for i, nm in enumerate(nets.order):
    p += '  (net {} "{}")\n'.format(i, nm)
p += ('  (gr_rect (start {} {}) (end {} {}) (stroke (width 0.15) (type default))'
      ' (fill none) (layer "Edge.Cuts") (uuid "{}"))\n').format(X0, Y0, X0 + BW, Y0 + BH, compose.U())
p += compose.gzone("GND", "In1.Cu", X0, Y0, X0 + BW, Y0 + BH, nets)
p += compose.gzone("GND", "B.Cu", X0, Y0, X0 + BW, Y0 + BH, nets)
p += body + ')\n'
open(out, "w").write(p)

base = os.path.splitext(out)[0]
import json  # noqa: E402
json.dump(compose._DEVICES, open(base + ".devices.json", "w"))
print("HSDEMO nets=%d devices=%d -> %s" % (len(nets.order) - 1, len(compose._DEVICES), out))
