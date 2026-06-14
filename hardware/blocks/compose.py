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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import resolve_part  # general KiCad-library part resolver
import source_part   # DigiKey -> datasheet -> resolved part (cache-first)

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


def res(ref, x, y, a, b, nets):
    """0402 resistor between nets a and b."""
    return place("Resistor_SMD", "R_0402_1005Metric", ref, x, y, 0,
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
    """RP2040 (Pico module). 5V -> VSYS/VBUS; provides 3V3OUT to peripherals.
    Buses are wired only where a peripheral actually uses them: the pin map is
    built from whichever interface nets `n` carries (SPI for a radio, I2C for a
    sensor, PWM for motors), so the MCU has no dangling stub nets."""
    # physical Pico pin -> the interface-net key it carries (mapped only if present)
    opt = {
        "4": "spi_sck", "5": "spi_mosi", "6": "spi_miso", "7": "spi_cs",
        "9": "ctrl_rst", "10": "ctrl_irq", "11": "i2c_sda", "12": "i2c_scl",
        "14": "mot1", "15": "mot2", "16": "mot3", "17": "mot4",
        "1": "uart_gps_tx", "2": "uart_gps_rx",          # UART0 -> GNSS
        "19": "uart_cell_tx", "20": "uart_cell_rx",      # UART1 -> cellular modem
        "21": "cell_pwrkey", "22": "cell_rst",           # modem power control
    }
    pmap = {"40": "+5V", "39": "+5V", "38": "GND", "36": "+3V3"}
    for pin, key in opt.items():
        if key in n:
            pmap[pin] = n[key]
    b = place("Module", "RaspberryPi_Pico_SMD_HandSolder", "U1",
              x + 11, y + 28, 0, pmap, nets)
    # decoupling caps to the RIGHT of the Pico body, clear of its courtyard
    b += cap("C2", x + 26, y + 22, "+3V3", "GND", nets)
    b += cap("C3", x + 26, y + 30, "+5V", "GND", nets)
    return b, 30, 56


def block_imu(x, y, n, nets):
    """6-axis IMU (MPU-6050) as a GY-521-style breakout module on the I2C bus.
    This is a module-integration board (the MCU and radio are modules too), so
    the IMU is a 0.1" module header — it carries the same I2C interface as the
    bare chip but its pads escape cleanly on two signal layers, where a raw
    0.5mm-pitch QFN's inner pads cannot without via-in-pad fanout.
    Header pinout (GY-521): 1 VCC, 2 GND, 3 SCL, 4 SDA, 5 XDA, 6 XCL, 7 AD0,
    8 INT."""
    pmap = {
        "1": "+3V3", "2": "GND", "3": n["i2c_scl"], "4": n["i2c_sda"],
        "7": "GND", "8": n["imu_int"],  # AD0->GND (addr 0x68); XDA/XCL unused
    }
    # the 1x08 header is a vertical pad strip (~3.5mm wide, ~21mm tall); the
    # decoupling cap goes to the SIDE of the strip, clear of its courtyard.
    b = place("Connector_PinHeader_2.54mm", "PinHeader_1x08_P2.54mm_Vertical",
              "U3", x + 4, y + 6, 0, pmap, nets)
    b += cap("C5", x + 11, y + 12, "+3V3", "GND", nets)  # local decoupling
    return b, 15, 30


def block_motors(x, y, n, nets):
    """4-channel ESC/motor output header — PWM1..4 from the MCU + a GND return.
    ESC power comes from the flight battery, so only the signals route here."""
    b = place("Connector_PinHeader_2.54mm", "PinHeader_1x05_P2.54mm_Vertical",
              "J3", x + 4, y + 8, 90,
              {"1": n["mot1"], "2": n["mot2"], "3": n["mot3"],
               "4": n["mot4"], "5": "GND"}, nets)
    return b, 18, 12


def block_usbc(x, y, n, nets):
    """DRC-clean USB-C sink inlet — GCT USB4085 receptacle, VBUS -> +5V, dual
    5.1k CC pulldowns (correct UFP/sink termination), shield + GND to GND."""
    pmap = {
        "A1": "GND", "A12": "GND", "B1": "GND", "B12": "GND",
        "A4": "+5V", "A9": "+5V", "B4": "+5V", "B9": "+5V",
        "A5": "USB_CC1", "B5": "USB_CC2",
        "S1": "GND", "S2": "GND", "S3": "GND", "S4": "GND",
    }
    b = place("Connector_USB", "USB_C_Receptacle_GCT_USB4085", "J1",
              x + 6, y + 6, 0, pmap, nets)
    # passives below the receptacle courtyard (extends to ~y+15.1)
    b += res("R1", x + 4, y + 18, "USB_CC1", "GND", nets)   # CC1 5.1k Rd
    b += res("R2", x + 8, y + 18, "USB_CC2", "GND", nets)   # CC2 5.1k Rd
    b += cap("C1", x + 12, y + 18, "+5V", "GND", nets)      # VBUS bulk
    return b, 16, 22


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


def block_gnss(x, y, n, nets):
    """GNSS receiver — Quectel L80-R with an integrated patch antenna (so no RF
    routing on this board). UART to the MCU; VCC + VCC_RTC backup on 3V3.
    L80-R pinout: 1 VCC_RTC, 2 VCC, 3 RXD, 4 TXD, 5/8/10/12 GND."""
    pmap = {
        "1": "+3V3", "2": "+3V3", "3": n["uart_gps_tx"], "4": n["uart_gps_rx"],
        "5": "GND", "8": "GND", "10": "GND", "12": "GND",
    }
    b = place("RF_GPS", "Quectel_L80-R", "U4", x + 10, y + 11, 0, pmap, nets)
    b += cap("C7", x + 10, y + 22, "+3V3", "GND", nets)  # below the patch module
    return b, 20, 28


def block_cellular(x, y, n, nets):
    """Cellular modem (LTE-M / NB-IoT) as a breakout module — a 1x06 header
    carrying the modem's UART + power-control lines. The SIM holder and the RF
    front end live on the breakout, so nothing fine-pitch routes on this board.
    Header: 1 VCC(5V), 2 GND, 3 modem TXD, 4 modem RXD, 5 PWRKEY, 6 RESET."""
    pmap = {
        "1": "+5V", "2": "GND", "3": n["uart_cell_rx"], "4": n["uart_cell_tx"],
        "5": n["cell_pwrkey"], "6": n["cell_rst"],
    }
    b = place("Connector_PinHeader_2.54mm", "PinHeader_1x06_P2.54mm_Vertical",
              "U5", x + 4, y + 6, 0, pmap, nets)
    b += cap("C8", x + 11, y + 10, "+5V", "GND", nets)
    return b, 16, 24


def block_tempsensor(x, y, n, nets):
    """I2C temperature sensor — NOT a hardcoded block. source_part sources a
    real, in-stock, routable part from DigiKey, reads its datasheet for the
    pinout + package, and resolves a verified footprint (cache-first; falls back
    to the KiCad-symbol path offline). The board uses whatever real part fits the
    interface, with MPN/price/stock/verification reported."""
    r = source_part.source("I2C temperature sensor", "i2c_sensor", {
        "power": "+3V3", "gnd": "GND",
        "i2c_scl": n["i2c_scl"], "i2c_sda": n["i2c_sda"], "int": "TEMP_OS"})
    if "error" in r:
        raise RuntimeError("tempsensor source failed: " + r["error"])
    b = place(r["lib"], r["footprint"], "U6", x + 6, y + 6, 0, r["pmap"], nets)
    b += cap("C9", x + 6, y + 14, "+3V3", "GND", nets)  # decoupling per power pin
    print("SOURCED:" + json.dumps({
        "ref": "U6", "mpn": r.get("mpn"), "manufacturer": r.get("manufacturer"),
        "price": r.get("price"), "stock": r.get("stock"),
        "footprint": r["lib"] + ":" + r["footprint"],
        "verified": r.get("verified"), "via": r.get("source")}))
    return b, 16, 20


BLOCK_TABLE = {
    "power": block_usbc_power,
    "usbc": block_usbc,
    "mcu": block_mcu_pico,
    "radio": block_lora_rfm95,
    "antenna": block_antenna_ufl,
    "imu": block_imu,
    "motors": block_motors,
    "gnss": block_gnss,
    "cellular": block_cellular,
    "tempsensor": block_tempsensor,
}


# ---- composer ---------------------------------------------------------------
def _block_keys(s):
    """All library keys a (possibly COMPOUND) block maps to. Independent checks,
    not first-match, so 'sensors (6-axis IMU + digital temperature)' yields BOTH
    imu and tempsensor instead of silently dropping one. Power is suppressed when
    a USB-C inlet is already the power path (same category — avoids a duplicate
    inlet). Returns [] for an unsupported block."""
    s = s.lower()
    out = []

    def add(k):
        if k not in out:
            out.append(k)

    if any(k in s for k in ("usb-c", "usb c", "type-c", "type c", "usbc")):
        add("usbc")
    if any(k in s for k in ("cellular", "lte", "nb-iot", "nbiot", "gsm", "gprs",
                            "modem", "sim7", "bg96", "bg95", "sara", "sim card", "sim_")):
        add("cellular")
    if any(k in s for k in ("gnss", "gps", "glonass", "galileo", "beidou",
                            "positioning", "geoloc", "l80", "l76", "neo-6", "neo-8", "ublox gps")):
        add("gnss")
    if any(k in s for k in ("mcu", "soc", "microcontroller", "rp2040", "stm32",
                            "compute", "flight controller", "fc ", "processor")):
        add("mcu")
    if any(k in s for k in ("lora", "radio", "transceiver", "sx12", "telemetry", "rfm", "433", "915", "868")):
        add("radio")
    if "antenna" in s:
        add("antenna")
    if any(k in s for k in ("temperature", "temp sensor", "thermometer", "thermal sensor",
                            "lm75", "tmp102", "tmp117", "mcp9808")):
        add("tempsensor")
    if any(k in s for k in ("imu", "gyro", "accel", "mpu", "mpu6050", "inertial",
                            "6-axis", "6 axis", "9-axis", "9 axis")):
        add("imu")
    if any(k in s for k in ("motor", "esc", "actuator", "servo", "propeller", "prop ")):
        add("motors")
    if "usbc" not in out and any(k in s for k in ("power", "regulator", "battery", "vin",
                                                  "5v", "3v3", "charg", "ldo", "buck",
                                                  "usb power", "usb-c power")):
        add("power")
    return out


def classify(blocks):
    """Map the spec's free-text block names to library keys. Returns
    (mapped_keys, dropped_blocks): dropped = requested blocks with NO buildable
    function, so the caller can report exactly what was and was NOT built. A
    compound block contributes every function it mentions (see _block_keys)."""
    seen, uniq, dropped = set(), [], []
    for b in blocks:
        ks = _block_keys(b)
        if not ks:
            dropped.append(b)
        for k in ks:
            if k not in seen:
                seen.add(k)
                uniq.append(k)
    # ensure a usable baseline: every board needs an MCU + a power inlet
    if "mcu" not in seen:
        uniq.append("mcu")
        seen.add("mcu")
    if not (seen & {"power", "usbc"}):
        uniq.append("power")
        seen.add("power")
    # The standalone U.FL block exists only to carry the LoRa ANT net; cellular
    # and GNSS modules carry their own antennas. So make the antenna block track
    # the radio exactly: add it with a radio, drop a bare antenna without one.
    if "radio" in seen and "antenna" not in seen:
        uniq.append("antenna")
        seen.add("antenna")
    elif "antenna" in seen and "radio" not in seen:
        uniq.remove("antenna")
        seen.discard("antenna")
    return uniq, dropped


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


# ---- floorplan ---------------------------------------------------------------
# Region-based placement: a function-grouped flow rather than one flat row.
# ROW puts compute/RF/sensors on the top band and bulky edge connectors
# (motors) on their own band below; within a row COL orders blocks so power is
# on the left, the MCU is central, sensors sit next to it (short I2C), and the
# radio + antenna land on the right edge (best RF practice). Rows wrap if a band
# grows past the width budget, so the layout scales as blocks are added.
ROW = {"power": 0, "usbc": 0, "mcu": 0, "imu": 0, "radio": 0, "antenna": 0,
       "gnss": 0, "cellular": 0, "tempsensor": 0, "motors": 1}
COL = {"power": 0, "usbc": 0, "mcu": 2, "imu": 3, "tempsensor": 3, "gnss": 4,
       "radio": 5, "cellular": 6, "antenna": 9, "motors": 1}
ROW_BUDGET = 170.0  # mm — wrap a band wider than this


def _unique_refs(body):
    """Renumber duplicate reference designators across the composed footprints so
    every part is unique (the board is invalid otherwise). Bumps the number of
    each repeated ref to the next free one for its prefix and rewrites that ref
    everywhere inside the footprint block."""
    parts = re.split(r"(?=^  \(footprint )", body, flags=re.M)
    used = set()
    out = []
    for blk in parts:
        m = re.search(r'\(property "Reference" "([^"]+)"', blk)
        pm = re.match(r"([A-Za-z]+)(\d+)$", m.group(1)) if m else None
        if not pm:
            out.append(blk)
            continue
        prefix, num = pm.group(1), int(pm.group(2))
        while (prefix, num) in used:
            num += 1
        used.add((prefix, num))
        newref = "{}{}".format(prefix, num)
        if newref != m.group(1):
            blk = blk.replace('"{}"'.format(m.group(1)), '"{}"'.format(newref))
        out.append(blk)
    return "".join(out)


def compose(spec, blocks, out_path):
    nets = Nets()
    keys, dropped = classify(blocks)

    # shared interface nets — allocated only for the buses that are actually
    # used, so the MCU and netlist carry no dangling stubs.
    n = {}
    if "radio" in keys:
        n.update({"spi_sck": "SPI_SCK", "spi_mosi": "SPI_MOSI", "spi_miso": "SPI_MISO",
                  "spi_cs": "LORA_NSS", "ctrl_rst": "LORA_RST", "ctrl_irq": "LORA_DIO0",
                  "ant": "ANT"})
    if "imu" in keys or "tempsensor" in keys:        # shared I2C bus
        n.update({"i2c_sda": "I2C_SDA", "i2c_scl": "I2C_SCL"})
    if "imu" in keys:
        n["imu_int"] = "IMU_INT"
    if "motors" in keys:
        n.update({"mot1": "MOTOR1", "mot2": "MOTOR2", "mot3": "MOTOR3", "mot4": "MOTOR4"})
    if "gnss" in keys:
        n.update({"uart_gps_tx": "GPS_TX", "uart_gps_rx": "GPS_RX"})
    if "cellular" in keys:
        n.update({"uart_cell_tx": "CELL_TX", "uart_cell_rx": "CELL_RX",
                  "cell_pwrkey": "CELL_PWRKEY", "cell_rst": "CELL_RST"})
    for sig in n.values():
        nets.id(sig)

    X0, Y0, MARGIN, GAP, ROWGAP = 30.0, 30.0, 8.0, 8.0, 10.0

    # group blocks into bands, then flow each band left->right by COL priority
    bands = {}
    for k in keys:
        bands.setdefault(ROW.get(k, 0), []).append(k)

    body = ""
    ytop = Y0 + MARGIN
    maxright = X0 + MARGIN
    for r in sorted(bands):
        rkeys = sorted(bands[r], key=lambda k: COL.get(k, 5))
        x = X0 + MARGIN
        rowh = 0
        for k in rkeys:
            txt, w, h = BLOCK_TABLE[k](x, ytop, n, nets)
            # wrap to a new sub-row if this band overflows the width budget
            if x > X0 + MARGIN and (x + w - X0) > ROW_BUDGET:
                maxright = max(maxright, x - GAP)  # capture this sub-row's reach
                x = X0 + MARGIN
                ytop += rowh + ROWGAP
                rowh = 0
                txt, w, h = BLOCK_TABLE[k](x, ytop, n, nets)
            body += txt
            x += w + GAP
            rowh = max(rowh, h)
        maxright = max(maxright, x - GAP)
        ytop += rowh + ROWGAP

    BW = round(maxright + MARGIN - X0, 1)
    BH = round(ytop - ROWGAP - (Y0 + MARGIN) + 2 * MARGIN, 1)

    # assembly fiducials (3, in the corner margins clear of the part band)
    for i, (fx, fy) in enumerate([(6, 6), (BW - 6, 6), (6, BH - 6)]):
        body += place("Fiducial", "Fiducial_1mm_Mask2mm", "FID" + str(i + 1),
                      X0 + fx, Y0 + fy, 0, {}, nets)

    # blocks hardcode their reference designators, so two similar blocks (e.g. a
    # USB-C inlet + a header power block) can both emit J1/C1. Renumber any
    # duplicate references to keep every footprint unique — KiCad rejects a board
    # with collisions and DSN export fails. Defensive: works no matter what mix
    # of blocks the classifier produced.
    body = _unique_refs(body)

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

    # Fine-pitch parts (USB-C receptacle, QFN/VSSOP/DFN, any sub-0.8mm-pitch
    # sourced part) have intrinsic pad gaps below the 0.2mm house clearance.
    # Detect them from the ACTUAL placed footprints (not the block type, since a
    # sourced part can be any package) and emit a matching design-rules file
    # allowing 0.13mm (6-mil) pad-to-pad — a clearance every standard fab
    # supports. kicad-cli auto-loads <board>.kicad_dru.
    fine_pitch = re.search(
        r"P0\.[1-7]\d*mm|QFN|DFN|WSON|USON|VSSOP|VQFN|UQFN|UFQFPN|BGA|"
        r"LGA|SON_|USB_C_Receptacle", p)
    if fine_pitch:
        dru = os.path.splitext(out_path)[0] + ".kicad_dru"
        open(dru, "w").write(
            "(version 1)\n"
            "# Fine-pitch parts make this a 6-mil fab class; 0.13mm (5-mil) copper\n"
            "# clearance is supported by every standard 2-layer fab.\n"
            '(rule "fab_6mil"\n'
            "  (constraint clearance (min 0.13mm)))\n")

    print("COMPOSE: blocks {} -> {} components placed, {:.0f}x{:.0f}mm, {} nets".format(
        keys, p.count("(footprint "), BW, BH, len(nets.order) - 1))
    print("COMPOSE_BLOCKS:" + ",".join(keys))
    # coverage: what the spec asked for vs. what the library could build. The
    # pipeline surfaces `dropped` loudly so an incomplete board never reads as a
    # silent clean pass.
    print("COMPOSE_COVERAGE:" + json.dumps({"mapped": keys, "dropped": dropped}))


def main():
    spec = json.load(open(sys.argv[1])) if len(sys.argv) > 1 and os.path.exists(sys.argv[1]) else {}
    out_path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/composed.kicad_pcb"
    blocks = spec.get("blocks", ["power", "mcu", "lora radio", "antenna"])
    compose(spec, blocks, out_path)


if __name__ == "__main__":
    main()
