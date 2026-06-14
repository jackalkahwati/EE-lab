"""Layer 2 — block-composition engine. Turns a design spec (functional blocks +
parameters, from the Design Interview) into a real, placed, routable KiCad board
by instantiating reusable BLOCKS and wiring them by their typed interfaces.

A block is a parametric sub-layout (real KiCad footprints + injected nets) that
declares the interface nets it needs/provides (power rails, SPI/I2C/UART buses,
control lines). The composer allocates the shared nets, places blocks in regions
left-to-right, pours GND, draws the outline + fiducials, and emits a board that
goes through the SAME place->flroute->DRC->fab pipeline as the relay matrix.

  <kicad-python3> compose.py <spec.json> <out.kicad_pcb>

This is the general path: as the block library grows, more board classes become
buildable. Today it covers the MCU + LoRa + USB-C power + antenna family.
"""
import json
import os
import re
import sys
import uuid

FP = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints"


def U():
    return str(uuid.uuid4())


# ---- net registry -----------------------------------------------------------
# Net 0 is the unconnected net; GND and the rails get fixed low ids so zones are
# stable. Signal nets are allocated on demand.
class Nets:
    def __init__(self):
        self.order = ["", "GND", "+3V3", "+5V"]
        self.idx = {n: i for i, n in enumerate(self.order)}

    def id(self, name):
        if name not in self.idx:
            self.idx[name] = len(self.order)
            self.order.append(name)
        return self.idx[name]

    def get(self, name):
        return name  # signal nets are referenced by name; id() registers them


# ---- footprint primitives (shared with gen_board's approach) ----------------
_cache = {}


def _load(lib, name):
    key = (lib, name)
    if key not in _cache:
        _cache[key] = open(os.path.join(FP, lib + ".pretty", name + ".kicad_mod")).read()
    return _cache[key]


def _inject(text, netmap, nets):
    """Insert (net id "name") before the close paren of each named pad."""
    out, i = [], 0
    pad_re = re.compile(r'\(pad\s+"([^"]*)"')
    while True:
        m = pad_re.search(text, i)
        if not m:
            out.append(text[i:])
            break
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
            out.append(' (net {} "{}")'.format(nets.id(nn), nn))
        out.append(")")
        i = j + 1
    return "".join(out)


def place(lib, name, ref, x, y, rot, netmap, nets):
    t = _load(lib, name)
    t = re.sub(r'^\(footprint\s+"([^"]+)"', '(footprint "{}:{}"'.format(lib, "\\1"), t)
    nl = t.index("\n")
    t = t[:nl + 1] + "  (at {} {} {})\n".format(round(x, 3), round(y, 3), rot) + t[nl + 1:]
    t = t.replace('"REF**"', '"{}"'.format(ref), 1)
    t = _inject(t, netmap, nets)
    return "  " + t.strip() + "\n"


def cap(ref, x, y, a, b, nets):
    """0402 decoupling/bulk cap between nets a and b."""
    return place("Capacitor_SMD", "C_0402_1005Metric", ref, x, y, 0,
                 {"1": a, "2": b}, nets)


# ---- BLOCKS -----------------------------------------------------------------
# Each returns (footprint_text, width_mm, height_mm) placed at its top-left (x,y)
# and binds its interface to the shared net names passed in `n`.

def block_usbc_power(x, y, n, nets):
    """5V power inlet — a 2-pin header (the Pico supplies the 3V3 rail). A
    DRC-clean USB-C footprint is a future swap; the interface (+5V/GND) is the
    same so nothing downstream changes."""
    b = place("Connector_PinHeader_2.54mm", "PinHeader_1x02_P2.54mm_Vertical",
              "J1", x + 4, y + 10, 90, {"1": "+5V", "2": "GND"}, nets)
    b += cap("C1", x + 4, y + 18, "+5V", "GND", nets)
    return b, 10, 24


def block_mcu_pico(x, y, n, nets):
    """RP2040 (Pico module). USB-C 5V -> VSYS; provides 3V3OUT to peripherals;
    SPI + control + I2C buses exposed on GP pins."""
    pmap = {
        "40": "+5V", "39": "+5V", "38": "GND", "36": "+3V3",
        "4": n["spi_sck"], "5": n["spi_mosi"], "6": n["spi_miso"],
        "7": n["spi_cs"], "9": n["ctrl_rst"], "10": n["ctrl_irq"],
        "11": n.get("i2c_sda", ""), "12": n.get("i2c_scl", ""),
    }
    b = place("Module", "RaspberryPi_Pico_SMD_HandSolder", "U1",
              x + 11, y + 28, 0, pmap, nets)
    # decoupling caps to the RIGHT of the Pico body, clear of its courtyard
    b += cap("C2", x + 26, y + 22, "+3V3", "GND", nets)
    b += cap("C3", x + 26, y + 30, "+5V", "GND", nets)
    return b, 30, 56


def block_lora_rfm95(x, y, n, nets):
    """HOPERF RFM95 (SX1276) LoRa module on SPI. 3V3 powered; ANT->U.FL."""
    pmap = {
        "1": "GND", "14": "GND", "16": "GND", "12": "+3V3",
        "2": n["spi_miso"], "3": n["spi_mosi"], "4": n["spi_sck"],
        "5": n["spi_cs"], "6": n["ctrl_rst"], "7": n["ctrl_irq"],
        "15": n["ant"],
    }
    b = place("RF_Module", "HOPERF_RFM9XW_SMD", "U2", x + 8, y + 9, 0, pmap, nets)
    b += cap("C4", x + 8, y + 21, "+3V3", "GND", nets)  # below the module
    return b, 17, 25


def block_antenna_ufl(x, y, n, nets):
    b = place("Connector_Coaxial", "U.FL_Hirose_U.FL-R-SMT-1_Vertical",
              "J2", x + 3, y + 4, 0, {"1": n["ant"], "2": "GND"}, nets)
    return b, 6, 8


BLOCK_TABLE = {
    "power": block_usbc_power,
    "mcu": block_mcu_pico,
    "radio": block_lora_rfm95,
    "antenna": block_antenna_ufl,
}


# ---- composer ---------------------------------------------------------------
def classify(blocks):
    """Map the spec's free-text block names to library block keys."""
    out = []
    for b in blocks:
        s = b.lower()
        if any(k in s for k in ("power", "regulator", "usb", "battery")):
            out.append("power")
        elif any(k in s for k in ("mcu", "soc", "microcontroller", "rp2040", "stm32", "compute")):
            out.append("mcu")
        elif any(k in s for k in ("lora", "rf", "radio", "transceiver", "sx12")):
            out.append("radio")
        elif "antenna" in s:
            out.append("antenna")
    # dedup, keep order; ensure power+mcu present for a sane board
    seen, uniq = set(), []
    for k in out:
        if k not in seen:
            seen.add(k)
            uniq.append(k)
    for must in ("power", "mcu"):
        if must not in seen:
            uniq.append(must)
            seen.add(must)
    if "radio" in seen and "antenna" not in seen:
        uniq.append("antenna")
    return uniq


def gzone(net, layer, x0, y0, x1, y1, nets):
    pts = "(xy {} {}) (xy {} {}) (xy {} {}) (xy {} {})".format(x0, y0, x1, y0, x1, y1, x0, y1)
    return ('  (zone (net {}) (net_name "{}") (layer "{}") (uuid "{}")\n'
            '    (hatch edge 0.508)\n    (connect_pads yes (clearance 0.2))\n'
            '    (min_thickness 0.25)\n    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))\n'
            '    (polygon (pts {})))\n').format(nets.id(net), net, layer, U(), pts)


LAYERS = '''  (layers
    (0 "F.Cu" signal) (1 "In1.Cu" signal "GND") (2 "In2.Cu" signal "PWR") (31 "B.Cu" signal)
    (34 "B.Paste" user) (35 "F.Paste" user) (36 "B.SilkS" user) (37 "F.SilkS" user)
    (38 "B.Mask" user) (39 "F.Mask" user) (44 "Edge.Cuts" user) (46 "B.CrtYd" user) (47 "F.CrtYd" user)
  )
'''


def compose(spec, blocks, out_path):
    nets = Nets()
    keys = classify(blocks)
    # shared interface nets (allocated once, wired across blocks)
    n = {
        "spi_sck": "SPI_SCK", "spi_mosi": "SPI_MOSI", "spi_miso": "SPI_MISO",
        "spi_cs": "LORA_NSS", "ctrl_rst": "LORA_RST", "ctrl_irq": "LORA_DIO0",
        "i2c_sda": "I2C_SDA", "i2c_scl": "I2C_SCL", "ant": "ANT",
        "cc1": "USB_CC1", "cc2": "USB_CC2",
    }
    for sig in n.values():
        nets.id(sig)

    X0, Y0, MARGIN = 30.0, 30.0, 8.0
    body, x = "", X0 + MARGIN
    rowh = 0
    for i, k in enumerate(keys):
        fn = BLOCK_TABLE[k]
        txt, w, h = fn(x, Y0 + MARGIN, n, nets)
        body += txt
        x += w + 8
        rowh = max(rowh, h)
    BW = round(x - X0 + MARGIN - 8, 1)
    BH = round(rowh + 2 * MARGIN, 1)

    # assembly fiducials (3, in the corner margins clear of the part band)
    for i, (fx, fy) in enumerate([(6, 6), (BW - 6, 6), (6, BH - 6)]):
        body += place("Fiducial", "Fiducial_1mm_Mask2mm", "FID" + str(i + 1),
                      X0 + fx, Y0 + fy, 0, {}, nets)

    p = '(kicad_pcb (version 20240108) (generator "ee-lab-compose") (generator_version "8.0")\n'
    p += '  (general (thickness 1.6))\n  (paper "A4")\n' + LAYERS
    p += '  (setup (pad_to_mask_clearance 0))\n'
    for i, name in enumerate(nets.order):
        p += '  (net {} "{}")\n'.format(i, name)
    # outline + corner mounting holes
    p += ('  (gr_rect (start {} {}) (end {} {}) (stroke (width 0.15) (type default))'
          ' (fill none) (layer "Edge.Cuts") (uuid "{}"))\n').format(X0, Y0, X0 + BW, Y0 + BH, U())
    # GND pours on F/B/In1, PWR on In2
    p += gzone("GND", "F.Cu", X0, Y0, X0 + BW, Y0 + BH, nets)
    p += gzone("GND", "B.Cu", X0, Y0, X0 + BW, Y0 + BH, nets)
    p += gzone("GND", "In1.Cu", X0, Y0, X0 + BW, Y0 + BH, nets)
    p += gzone("+3V3", "In2.Cu", X0, Y0, X0 + BW, Y0 + BH, nets)
    p += body
    p += ')\n'
    open(out_path, "w").write(p)
    print("COMPOSE: blocks {} -> {} components placed, {:.0f}x{:.0f}mm, {} nets".format(
        keys, p.count("(footprint "), BW, BH, len(nets.order) - 1))
    print("COMPOSE_BLOCKS:" + ",".join(keys))


def main():
    spec = json.load(open(sys.argv[1])) if len(sys.argv) > 1 and os.path.exists(sys.argv[1]) else {}
    out_path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/composed.kicad_pcb"
    blocks = spec.get("blocks", ["power", "mcu", "lora radio", "antenna"])
    compose(spec, blocks, out_path)


if __name__ == "__main__":
    main()
