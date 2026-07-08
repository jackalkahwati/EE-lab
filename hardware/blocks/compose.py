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

# Device manifest: what each placed IC/module actually IS, so firmware drives the
# right part instead of guessing from nets (an I2C temp sensor and an I2C IMU
# look identical on the bus). Blocks append; compose() resets + writes it.
_DEVICES = []


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
    if rot:
        # KiCad stores PAD angles as ABSOLUTE (footprint rotation already summed
        # in). A library footprint's pads carry their local angle, so placing at
        # rot without adding it left rotated parts with sideways, mutually
        # OVERLAPPING pads (positions rotate, orientations don't) — the hidden
        # source of the fine-pitch "residual shorts" on every rotated board.
        def _pad_rot(m):
            ang = (float(m.group(3) or 0) + rot) % 360
            a = ("%g" % ang)
            return "{} {})".format(m.group(1), a)
        t = re.sub(r'(\(pad\s+"[^"]*"[^()]*?\(at\s+[-0-9.]+\s+[-0-9.]+)(\s+([-0-9.]+))?\)',
                   _pad_rot, t)
    t = _inject(t, netmap, nets)
    return "  " + t.strip() + "\n"


BOX_WRL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "generic_module.wrl")


def with_body(fp_text, w, d, h):
    """Inject a generic box 3D body into a footprint whose real model is missing
    from the library, so it shows up in the 3D render instead of appearing as
    bare pads. Electrically irrelevant — purely the visualization. w×d×h in mm,
    centered on the footprint origin and sitting on the board.
    KiCad treats VRML model units as 0.1 inch for (scale), so divide by 2.54."""
    f = 2.54
    model = ('  (model "{}"\n'
             '    (offset (xyz 0 0 {:.3f}))\n'
             '    (scale (xyz {:.4f} {:.4f} {:.4f}))\n'
             '    (rotate (xyz 0 0 0))\n'
             '  )\n').format(BOX_WRL, h / 2.0, w / f, d / f, h / f)
    s = fp_text.rstrip()
    idx = s.rfind(")")
    return s[:idx] + model + s[idx:] + "\n"


def cap(ref, x, y, a, b, nets):
    """0402 decoupling/bulk cap between nets a and b."""
    return place("Capacitor_SMD", "C_0402_1005Metric", ref, x, y, 0,
                 {"1": a, "2": b}, nets)


def res(ref, x, y, a, b, nets):
    """0402 resistor between nets a and b."""
    return place("Resistor_SMD", "R_0402_1005Metric", ref, x, y, 0,
                 {"1": a, "2": b}, nets)


def tp(ref, x, y, net, nets):
    """FL-1 dedicated probe pad (1.5mm). NOTE: the default test plan probes
    existing component pads directly (FL-1's gantry needs no dedicated pads,
    and TP stubs proved a routing burden) — use this only for nets with no
    probeable pad, e.g. buried mid-signals."""
    return place("TestPoint", "TestPoint_Pad_1.5x1.5mm", ref, x, y, 0,
                 {"1": net}, nets)


# functional silkscreen labels (Phase 15.6): blocks register labels here so the
# board carries CONNECTOR/SIGNAL names, not just reference designators. compose()
# resets the list per board and emits every entry as F.SilkS gr_text.
_SILK = []


def label(text, x, y, size=1.0):
    _SILK.append((text, round(x, 2), round(y, 2), size))


def _silk_text(text, x, y, size):
    return ('  (gr_text "{}" (at {} {}) (layer "F.SilkS") (uuid "{}")\n'
            '    (effects (font (size {} {}) (thickness 0.15))))\n').format(
        text, x, y, U(), size, size)


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
    label("PWR 5V/GND", x + 4, y + 4)
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
        "24": "can_txd", "25": "can_rxd",                # CAN comms head
        "26": "step", "27": "dir", "29": "en",           # stepper motion controller
        "31": "fault", "32": "interlock", "34": "trig",  # FL-1 bus safety/sync lines
    }
    # pin-sharing role primitives: these reuse pins whose primary block is absent
    # on FL-1 core boards (documented conflict, resolved by absence):
    if "gp_a" in n and "mot1" not in n:                  # GPIO bank vs motors
        opt.update({"14": "gp_a", "15": "gp_b", "16": "gp_c", "17": "gp_d"})
    if "rst_out" in n and "step" not in n:               # RESET line vs stepper EN
        opt["29"] = "rst_out"
    if "sr_oe" in n and "cell_rst" not in n:             # relay OE gate vs modem reset
        opt["22"] = "sr_oe"
    pmap = {"40": "+5V", "39": "+5V", "38": "GND", "36": "+3V3"}
    for pin, key in opt.items():
        if key in n:
            pmap[pin] = n[key]
    b = place("Module", "RaspberryPi_Pico_SMD_HandSolder", "U1",
              x + 11, y + 28, 0, pmap, nets)
    # decoupling caps to the RIGHT of the Pico body, clear of its courtyard
    b += cap("C2", x + 26, y + 22, "+3V3", "GND", nets)
    b += cap("C3", x + 26, y + 30, "+5V", "GND", nets)
    # I2C bus pull-ups (4.7k to 3V3) — the bus master carries them; an open-drain
    # I2C bus is non-functional without them. Only when the board has an I2C bus.
    if "i2c_sda" in n:
        b += res("R10", x + 26, y + 38, n["i2c_sda"], "+3V3", nets)
        b += res("R11", x + 26, y + 44, n["i2c_scl"], "+3V3", nets)
    _DEVICES.append({"ref": "U1", "type": "mcu"})
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
    _DEVICES.append({"ref": "U3", "type": "imu"})
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
    # the RFM95 module has no 3D model in KiCad — give it a body for the render
    b = with_body(place("RF_Module", "HOPERF_RFM9XW_SMD", "U2", x + 8, y + 9, 0, pmap, nets),
                  16, 16, 3)
    b += cap("C4", x + 8, y + 21, "+3V3", "GND", nets)  # below the module
    _DEVICES.append({"ref": "U2", "type": "radio"})
    return b, 17, 25


def block_antenna_ufl(x, y, n, nets):
    b = place("Connector_Coaxial", "U.FL_Hirose_U.FL-R-SMT-1_Vertical",
              "J2", x + 3, y + 4, 0, {"1": n["ant"], "2": "GND"}, nets)
    # ESD protection at the antenna port: ultra-low-capacitance TVS (0402,
    # RCLAMP0502B class) shunting the RF line to GND right at the connector.
    b += place("Diode_SMD", "D_0402_1005Metric", "D_ANT", x + 3, y + 9, 0,
               {"1": n["ant"], "2": "GND"}, nets)
    return b, 6, 12


def block_gnss(x, y, n, nets):
    """GNSS receiver — Quectel L80-R with an integrated patch antenna (so no RF
    routing on this board). UART to the MCU; VCC + VCC_RTC backup on 3V3.
    L80-R pinout: 1 VCC_RTC, 2 VCC, 3 RXD, 4 TXD, 5/8/10/12 GND."""
    pmap = {
        "1": "+3V3", "2": "+3V3", "3": n["uart_gps_tx"], "4": n["uart_gps_rx"],
        "5": "GND", "8": "GND", "10": "GND", "12": "GND",
    }
    # the L80-R has no 3D model in KiCad's library, so give it a generic body
    # (16x13x6mm patch module) for the render
    b = with_body(place("RF_GPS", "Quectel_L80-R", "U4", x + 10, y + 11, 0, pmap, nets),
                  16, 13, 6)
    b += cap("C7", x + 10, y + 22, "+3V3", "GND", nets)  # below the patch module
    _DEVICES.append({"ref": "U4", "type": "gnss"})
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
    _DEVICES.append({"ref": "U5", "type": "cellular"})
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
    _DEVICES.append({"ref": "U6", "type": "i2c_tempsensor", "mpn": r.get("mpn"), "name": r.get("mpn") or r.get("symbol") or "I2C temperature sensor"})
    print("SOURCED:" + json.dumps({
        "ref": "U6", "mpn": r.get("mpn"), "manufacturer": r.get("manufacturer"),
        "price": r.get("price"), "stock": r.get("stock"),
        "footprint": r["lib"] + ":" + r["footprint"],
        "verified": r.get("verified"), "via": r.get("source")}))
    return b, 16, 20


def block_sourced_sensor(x, y, n, nets, desc, key):
    """ANY I2C sensor by plain-language description — pressure, humidity, light,
    ToF, gas, magnetometer, ... source_part finds a real in-stock part on
    DigiKey, reads its datasheet for pinout + package, and resolves a verified
    footprint. The block library no longer bounds what sensors a board can
    carry; the datasheet does."""
    r = source_part.source(desc, "i2c_sensor", {
        "power": "+3V3", "gnd": "GND",
        "i2c_scl": n["i2c_scl"], "i2c_sda": n["i2c_sda"],
        "int": key.upper() + "_INT"})
    if "error" in r:
        raise RuntimeError("sensor source failed (%s): %s" % (desc, r["error"]))
    b = place(r["lib"], r["footprint"], "U6", x + 6, y + 6, 0, r["pmap"], nets)
    b += cap("C9", x + 6, y + 14, "+3V3", "GND", nets)
    _DEVICES.append({"ref": "U6", "type": "i2c_sensor", "desc": desc,
                     "mpn": r.get("mpn"), "name": r.get("mpn") or r.get("symbol") or desc})
    print("SOURCED:" + json.dumps({
        "ref": "U6", "desc": desc, "mpn": r.get("mpn"),
        "manufacturer": r.get("manufacturer"),
        "price": r.get("price"), "stock": r.get("stock"),
        "footprint": r["lib"] + ":" + r["footprint"],
        "verified": r.get("verified"), "via": r.get("source")}))
    return b, 16, 20


def sourced_ic(desc, interface, netmap, ref, x, y, rot, nets):
    """Block-layer core: resolve ANY IC via a generalized contract
    (spi_device, stepper_driver, can_transceiver, current_sense, ...), place it,
    and report it. The caller supplies netmap (contract net-key -> board net)
    and adds board-level support (decoupling, connectors, termination, sense
    resistors) around it. Returns (body, resolved_dict). Raises on resolve
    failure so an unbuildable board never silently ships."""
    r = source_part.source(desc, interface, netmap)
    if "error" in r:
        raise RuntimeError("%s source failed (%s/%s): %s"
                           % (ref, desc, interface, r["error"]))
    b = place(r["lib"], r["footprint"], ref, x, y, rot, r["pmap"], nets)
    name = r.get("mpn") or r.get("symbol") or desc
    _DEVICES.append({"ref": ref, "type": interface, "desc": desc,
                     "mpn": r.get("mpn"), "name": name})
    print("SOURCED:" + json.dumps({
        "ref": ref, "desc": desc, "interface": interface, "mpn": r.get("mpn"),
        "manufacturer": r.get("manufacturer"), "price": r.get("price"),
        "stock": r.get("stock"), "footprint": r["lib"] + ":" + r["footprint"],
        "verified": r.get("verified"), "via": r.get("source")}))
    return b, r


def block_comms_can(x, y, n, nets):
    """CAN communications head: an MCU-driven CAN transceiver on a bus header.
    The transceiver is RESOLVED from the can_transceiver contract (SN65HVD230
    class), not hardcoded. TXD/RXD come from the shared MCU nets; CANH/CANL go
    to a 3-pin bus header with 120-ohm termination. First board built on the
    generalized part-resolution + block layer."""
    b, r = sourced_ic("CAN bus transceiver 3.3V", "can_transceiver", {
        "power": "+3V3", "gnd": "GND",
        "can_txd": n["can_txd"], "can_rxd": n["can_rxd"],
        "canh": "CANH", "canl": "CANL"}, "U7", x + 6, y + 7, 0, nets)
    b += cap("C20", x + 6, y + 14, "+3V3", "GND", nets)      # transceiver decoupling
    b += res("R20", x + 13, y + 10, "CANH", "CANL", nets)    # 120-ohm bus termination
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x03_P2.54mm_Vertical",
               "J7", x + 13, y + 16, 0, {"1": "CANH", "2": "CANL", "3": "GND"}, nets)
    label("CAN H/L/G", x + 13, y + 24, 0.7)
    return b, 20, 26


def block_motion_controller(x, y, n, nets):
    """Stepper motion controller: MCU-driven stepper driver (TMC2209 class),
    resolved from the stepper_driver contract, with its part-specific support
    (charge-pump caps, RDSon sense to GND, 5V-out and rail decoupling), a motor
    power inlet, and a 4-pin bipolar motor output. STEP/DIR/EN come from the
    shared MCU nets. First board that carries a resolved IC's non-trivial
    support circuit, not just its bus interface."""
    # motor power inlet (VMOTOR / GND) — separate from the +5V logic rail
    b = place("Connector_PinHeader_2.54mm", "PinHeader_1x02_P2.54mm_Vertical",
              "J8", x + 4, y + 8, 90, {"1": "VMOTOR", "2": "GND"}, nets)
    b += cap("C21", x + 4, y + 16, "VMOTOR", "GND", nets)   # motor supply bulk
    # the driver, resolved + placed, with every support-pin net named
    b2, r = sourced_ic("TMC2209 stepper motor driver", "stepper_driver", {
        "power": "+3V3", "gnd": "GND", "vmotor": "VMOTOR",
        "step": n["step"], "dir": n["dir"], "en": n["en"],
        "motor_a1": "M_A1", "motor_a2": "M_A2",
        "motor_b1": "M_B1", "motor_b2": "M_B2",
        "cp_out": "CP_OUT", "cp_in": "CP_IN", "vcp": "VCP", "reg_out": "REG_5V",
    }, "U8", x + 14, y + 10, 0, nets)
    b += b2
    b += cap("C22", x + 22, y + 8, "CP_OUT", "CP_IN", nets)    # charge-pump flying cap
    b += cap("C23", x + 22, y + 14, "VCP", "VMOTOR", nets)     # charge-pump reservoir
    b += cap("C24", x + 22, y + 20, "REG_5V", "GND", nets)     # 5VOUT internal-reg decoupling
    b += cap("C25", x + 14, y + 20, "+3V3", "GND", nets)       # VCC_IO decoupling
    # 4-pin bipolar motor output (coil A, coil B)
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x04_P2.54mm_Vertical",
               "J9", x + 30, y + 12, 0,
               {"1": "M_A1", "2": "M_A2", "3": "M_B1", "4": "M_B2"}, nets)
    return b, 40, 30


def block_dc_measure(x, y, n, nets):
    """Instrument DC-measurement front-end: an I2C current/power monitor
    (INA228 class) sensing across a shunt in the bus path. Resolved from the
    current_sense contract; the shunt is the sense element, IN/OUT terminals
    carry the measured rail. First instrument-board building block (FL-1 B-9),
    on a leaded package that routes cleanly where a leadless QFN does not."""
    b, r = sourced_ic("INA228 current power monitor", "current_sense", {
        "power": "+3V3", "gnd": "GND",
        "i2c_scl": n["i2c_scl"], "i2c_sda": n["i2c_sda"],
        "shunt_hi": "VIN_BUS", "shunt_lo": "VOUT_LOAD"}, "U8", x + 15, y + 9, 0, nets)
    b += cap("C21", x + 15, y + 16, "+3V3", "GND", nets)          # decoupling
    b += res("R21", x + 15, y + 3, "VIN_BUS", "VOUT_LOAD", nets)  # sense shunt (the element)
    # bus in (from supply) and bus out (to load); current is measured across R21
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x02_P2.54mm_Vertical",
               "J8", x + 4, y + 9, 90, {"1": "VIN_BUS", "2": "GND"}, nets)
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x02_P2.54mm_Vertical",
               "J9", x + 26, y + 9, 90, {"1": "VOUT_LOAD", "2": "GND"}, nets)
    return b, 32, 28


def block_dut_monitor(x, y, n, nets):
    """PCM-1 DUT power/current monitor (Phase 18.6): conservative shunt+ADS1115
    path on the PROVEN cal-board measurement chain. Low-side 0402 shunt
    (monitor-only, low current), 11:1 divider for DUT voltage, series-R
    protected ADC inputs. NOT a DMM, NOT a supply — labels say so."""
    # DUT input: V+ / RTN (through shunt to GND) / GND reference
    b = place("Connector_PinHeader_2.54mm", "PinHeader_1x03_P2.54mm_Vertical",
              "J20", x + 3, y + 8, 0,
              {"1": "DUT_V", "2": "SHUNT_HI", "3": "GND"}, nets)
    # low-side shunt: DUT return -> SHUNT_HI --R85(shunt)-- GND
    b += res("R85", x + 3, y + 20, "SHUNT_HI", "GND", nets)
    # divider DUT_V -> VSENSE_DIV -> GND (11:1, 0-24V in -> 0-2.2V at ADC)
    b += res("R86", x + 9, y + 4, "DUT_V", "VSENSE_DIV", nets)
    b += res("R87", x + 9, y + 9, "VSENSE_DIV", "GND", nets)
    # series protection into the ADC pins
    b += res("R88", x + 9, y + 14, "VSENSE_DIV", "VSENSE_ADC", nets)
    b += res("R89", x + 9, y + 19, "SHUNT_HI", "ISENSE_ADC", nets)
    # ADS1115 (validated UCS pin map), fine-pitch escape handled by fanout
    b += place("Package_SO", "TSSOP-10_3x3mm_P0.5mm", "U15", x + 17, y + 10, 0, {
        "1": "GND",            # ADDR -> 0x48
        "3": "GND", "8": "+3V3",
        "4": "VSENSE_ADC", "5": "ISENSE_ADC", "6": "GND", "7": "GND",
        "9": n.get("i2c_sda", "I2C_SDA"), "10": n.get("i2c_scl", "I2C_SCL")}, nets)
    b += cap("C30", x + 21, y + 17, "+3V3", "GND", nets)
    # probe points the validation workflows name explicitly
    b += tp("TP30", x + 26, y + 10, "DUT_V", nets)
    b += tp("TP31", x + 26, y + 15, "SHUNT_HI", nets)
    b += tp("TP32", x + 26, y + 20, "VSENSE_ADC", nets)
    b += tp("TP33", x + 30, y + 10, "ISENSE_ADC", nets)
    b += tp("TP34", x + 30, y + 15, "GND", nets)
    label("DUT IN 0-24V 0-500mA MAX", x + 14, y + 1, 0.7)
    label("MONITOR-ONLY  no supply  no DMM claim", x + 14, y + 25, 0.6)
    label("J20: V+ / RTN(shunt) / GND", x + 3, y + 4, 0.6)
    label("SHUNT R85 low-side  TP31=SHUNT_HI TP34=SHUNT_LO/GND", x + 16, y + 23, 0.6)
    _DEVICES.append({"ref": "U15", "type": "adc", "name": "ADS1115",
                     "i2c_address": "0x48",
                     "role": "DUT V/I monitor (AIN0=VSENSE, AIN1=ISENSE)"})
    _DEVICES.append({"ref": "R85", "type": "shunt", "name": "low-side shunt",
                     "note": "monitor-only; value+rating recorded in safety model"})
    return b, 34, 28


def block_calref(x, y, n, nets):
    """Calibration/Reference chain as a compose block (Phase 18.8): REF3025
    (validated UCS pins: 1 IN, 2 OUT, 3 GND) + divider ladder + a dedicated
    ADS1115 measuring REF_OUT/REF_DIV. Same chain the cal board proved on the
    synth path. NO calibration claim until a traceable chain exists post-fab."""
    b = place("Package_TO_SOT_SMD", "SOT-23", "U16", x + 4, y + 6, 0,
              {"1": "+3V3", "2": "REF_OUT", "3": "GND"}, nets)
    b += cap("C31", x + 4, y + 12, "+3V3", "GND", nets)
    # divider REF_OUT -> REF_DIV -> GND (cal ladder point 1)
    b += res("R90", x + 10, y + 4, "REF_OUT", "REF_DIV", nets)
    b += res("R91", x + 10, y + 9, "REF_DIV", "GND", nets)
    # ADS1115 #2 at ADDR=VDD (0x49) so it coexists with the monitor ADC at 0x48
    b += place("Package_SO", "TSSOP-10_3x3mm_P0.5mm", "U17", x + 18, y + 10, 0, {
        "1": "+3V3", "3": "GND", "8": "+3V3",
        "4": "REF_OUT", "5": "REF_DIV", "6": "GND", "7": "GND",
        "9": n.get("i2c_sda", "I2C_SDA"), "10": n.get("i2c_scl", "I2C_SCL")}, nets)
    b += cap("C32", x + 24, y + 17, "+3V3", "GND", nets)
    b += tp("TP40", x + 28, y + 5, "REF_OUT", nets)
    b += tp("TP41", x + 28, y + 10, "REF_DIV", nets)
    label("REF_OUT / REF_DIV cal nodes", x + 14, y + 1, 0.6)
    label("UNCALIBRATED until traceable chain", x + 14, y + 24, 0.6)
    _DEVICES.append({"ref": "U16", "type": "voltage_reference", "name": "REF3025"})
    _DEVICES.append({"ref": "U17", "type": "adc", "name": "ADS1115",
                     "i2c_address": "0x49", "role": "reference measurement"})
    return b, 32, 27


def block_calref_expansion(x, y, n, nets):
    """Calibration expansion (Full-16 fn 16): extends the reference ladder with
    two more tapped points measured by the SAME cal ADC channel via test points.
    Reduced scope, honestly labeled — more KNOWN nodes, zero accuracy claim."""
    b = res("R92", x + 3, y + 5, "REF_DIV", "REF_DIV2", nets)
    b += res("R93", x + 3, y + 10, "REF_DIV2", "GND", nets)
    b += tp("TP42", x + 8, y + 5, "REF_DIV2", nets)
    label("CAL LADDER EXT (uncal)", x + 6, y + 1, 0.6)
    return b, 12, 14


def block_mcu_bare(x, y, n, nets):
    """BARE RP2040 subsystem (Phase 18.8 stress test) — QFN-56 0.4mm + W25Q16
    QSPI flash + 12MHz 3225 crystal + AMS1117-3.3 regulator + SWD/BOOT/RESET +
    decoupling. NO Pico module. HONESTY: the RP2040/W25Q16 pin maps are MANUAL
    datasheet transcriptions (no validated UCS exists) — ingestion validation is
    a recorded blocker; USB is brought to advisory test pads ONLY (no impedance
    claim); QSPI timing and crystal layout are UNVALIDATED. This block exists to
    generate real fanout/routing evidence, not a buildable product claim."""
    gpio_pin = {  # RP2040 GPIOn -> QFN-56 pin (manual transcription)
        0: "2", 1: "3", 2: "4", 3: "5", 4: "6", 5: "7", 6: "8", 7: "9",
        8: "11", 9: "12", 10: "13", 11: "14", 12: "15", 13: "16", 14: "18",
        15: "19", 16: "27", 17: "28", 18: "29", 19: "30", 20: "31", 21: "32",
        22: "34", 23: "35", 24: "36", 25: "37", 26: "38", 27: "39", 28: "40",
        29: "41"}
    role_gpio = {  # same net contract as block_mcu_pico, on bare GPIOs
        "uart_gps_tx": 0, "uart_gps_rx": 1,
        "spi_sck": 2, "spi_mosi": 3, "spi_miso": 4, "spi_cs": 5,
        "i2c_sda": 8, "i2c_scl": 9,
        "gp_a": 10, "gp_b": 11, "gp_c": 12, "gp_d": 13,
        "can_txd": 18, "can_rxd": 19, "sr_oe": 17,
        "rst_out": 22, "fault": 26, "interlock": 27, "trig": 28,
    }
    pmap = {  # power/system pins (manual transcription; EP = pad 57)
        "1": "+3V3", "10": "+3V3", "17": "+3V3", "23": "+3V3", "33": "+3V3",
        "42": "+3V3", "49": "+3V3", "43": "+3V3", "44": "+3V3", "48": "+3V3",
        "45": "RP_DVDD", "50": "RP_DVDD", "20": "GND", "57": "GND",
        "21": "RP_XIN", "22": "RP_XOUT",
        "24": "RP_SWCLK", "25": "RP_SWDIO", "26": "RP_RUN",
        "46": "RP_USB_DM", "47": "RP_USB_DP",
        "51": "QSPI_SD3", "52": "QSPI_SCLK", "53": "QSPI_SD0",
        "54": "QSPI_SD2", "55": "QSPI_SD1", "56": "QSPI_SS",
    }
    for key, g in role_gpio.items():
        if key in n:
            pmap[gpio_pin[g]] = n[key]
    b = place("Package_DFN_QFN", "QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm", "U30",
              x + 14, y + 14, 0, pmap, nets)
    # QSPI flash W25Q16 SOIC-8 (manual transcription: 1 /CS 2 DO 3 /WP 4 GND
    # 5 DI 6 CLK 7 /HOLD 8 VCC)
    b += place("Package_SO", "SOIC-8_3.9x4.9mm_P1.27mm", "U31", x + 32, y + 10, 0, {
        "1": "QSPI_SS", "2": "QSPI_SD1", "3": "QSPI_SD2", "4": "GND",
        "5": "QSPI_SD0", "6": "QSPI_SCLK", "7": "QSPI_SD3", "8": "+3V3"}, nets)
    # 12MHz crystal (3225: pads 1/3 crystal, 2/4 GND) + load caps
    b += place("Crystal", "Crystal_SMD_3225-4Pin_3.2x2.5mm", "Y1", x + 6, y + 26, 0,
               {"1": "RP_XIN", "2": "GND", "3": "RP_XOUT", "4": "GND"}, nets)
    b += cap("C40", x + 2, y + 31, "RP_XIN", "GND", nets)
    b += cap("C41", x + 10, y + 31, "RP_XOUT", "GND", nets)
    # 3V3 regulator (AMS1117-3.3 SOT-223: 1 GND 2 VOUT 3 VIN, tab=VOUT)
    b += place("Package_TO_SOT_SMD", "SOT-223-3_TabPin2", "U32", x + 33, y + 26, 0,
               {"1": "GND", "2": "+3V3", "3": "+5V"}, nets)
    b += cap("C42", x + 40, y + 30, "+5V", "GND", nets)
    b += cap("C43", x + 40, y + 34, "+3V3", "GND", nets)
    # DVDD (1.1V core from internal VREG) decoupling
    b += cap("C44", x + 24, y + 24, "RP_DVDD", "GND", nets)
    b += cap("C45", x + 6, y + 6, "+3V3", "GND", nets)
    b += cap("C46", x + 24, y + 6, "+3V3", "GND", nets)
    # boot/reset straps + headers
    b += res("R30", x + 33, y + 18, "QSPI_SS", "+3V3", nets)
    b += res("R31", x + 28, y + 32, "RP_RUN", "+3V3", nets)
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x02_P2.54mm_Vertical",
               "J30", x + 4, y + 40, 90, {"1": "QSPI_SS", "2": "GND"}, nets)
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x02_P2.54mm_Vertical",
               "J31", x + 14, y + 40, 90, {"1": "RP_RUN", "2": "GND"}, nets)
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x03_P2.54mm_Vertical",
               "J32", x + 26, y + 40, 90,
               {"1": "RP_SWCLK", "2": "GND", "3": "RP_SWDIO"}, nets)
    # USB: ADVISORY test pads only — no connector, no impedance claim
    b += tp("TP50", x + 38, y + 40, "RP_USB_DM", nets)
    b += tp("TP51", x + 42, y + 40, "RP_USB_DP", nets)
    # I2C pull-ups (the Pico block carries these when it is the MCU)
    if "i2c_sda" in n:
        b += res("R32", x + 44, y + 10, n["i2c_sda"], "+3V3", nets)
        b += res("R33", x + 44, y + 15, n["i2c_scl"], "+3V3", nets)
    label("BARE RP2040 (STRESS TEST)", x + 20, y + 2, 0.8)
    label("J30 BOOTSEL  J31 RESET  J32 SWD", x + 20, y + 45, 0.6)
    label("USB pads ADVISORY ONLY no impedance claim", x + 30, y + 48, 0.6)
    _DEVICES.append({"ref": "U30", "type": "mcu", "name": "RP2040 (bare QFN-56)",
                     "honesty": "pin map manually transcribed; ingestion "
                                "validation REQUIRED; unvalidated subsystem"})
    _DEVICES.append({"ref": "U31", "type": "qspi_flash", "name": "W25Q16 class"})
    return b, 48, 52


def block_backplane6(x, y, n, nets):
    """FL-1 six-slot PASSIVE backplane (Phase 19): six bus-v2 2x07 slot
    connectors sharing power/I2C/safety/sync, with per-slot board-ID straps —
    slot k ties ID_An to +3V3 where bit n of k is 1, else leaves it floating
    (the plugin card's pull-downs read it as 0). Bench default stays 0x50 on a
    bare card; slots resolve 0x50-0x55. No MCU, no logic: pure copper."""
    b = ""
    for k in range(6):
        pm = {"1": "+5V", "2": "+3V3",
              "3": n.get("i2c_sda", "I2C_SDA"), "4": n.get("i2c_scl", "I2C_SCL"),
              "5": "FAULT", "6": "INTERLOCK", "7": "RST_OUT", "8": "TRIG",
              "12": "GND", "13": "GND", "14": "GND"}
        for bit, pin in ((0, "9"), (1, "10"), (2, "11")):  # ID_A0..A2 straps
            if k & (1 << bit):
                pm[pin] = "+3V3"
        b += place("Connector_PinHeader_2.54mm", "PinHeader_2x07_P2.54mm_Vertical",
                   "J4%d" % k, x + 6 + k * 22, y + 10, 0, pm, nets)
        label("SLOT %d  ID 0x5%d" % (k, k), x + 6 + k * 22, y + 4, 0.7)
    # SYSTEM I2C pull-ups live on the backplane (defined bus even with no
    # cards inserted). Known Rev B item recorded in the pinout compatibility
    # report: populated cards stack their own pull-ups (see fl1-pinout-
    # compatibility-report) — card-side DNP option planned.
    b += res("R94", x + 40, y + 34, n.get("i2c_sda", "I2C_SDA"), "+3V3", nets)
    b += res("R95", x + 48, y + 34, n.get("i2c_scl", "I2C_SCL"), "+3V3", nets)
    b += tp("TP60", x + 6, y + 34, "FAULT", nets)
    b += tp("TP61", x + 14, y + 34, "INTERLOCK", nets)
    b += tp("TP62", x + 22, y + 34, "TRIG", nets)
    b += tp("TP63", x + 30, y + 34, "RST_OUT", nets)
    label("FL-1 BUS v2 BACKPLANE  slots 0-5", x + 60, y + 38, 0.9)
    for k in range(6):
        _DEVICES.append({"ref": "J4%d" % k, "type": "connector",
                         "name": "FL-1 slot %d (bus v2, ID 0x5%d)" % (k, k)})
    return b, 138, 42


def block_status_led(x, y, n, nets):
    """Generic power-indicator status LED (Phase 22.1): LED + series R from the
    3V3 rail. Zero MCU coupling — lights whenever the board is powered. A
    GPIO-driven status LED is a future generic primitive."""
    b = place("LED_SMD", "LED_0603_1608Metric", "D1", x + 3, y + 4, 0,
              {"1": "LED_K", "2": "+3V3"}, nets)
    b += res("R96", x + 3, y + 9, "LED_K", "GND", nets)
    label("PWR LED", x + 3, y + 1, 0.6)
    return b, 8, 12


# BME280 pin map — JIT-ACQUIRED from the KiCad Sensor library symbol (trusted
# library import, extracted programmatically, never from memory):
#   1 GND, 2 CSB, 3 SDI, 4 SCK, 5 SDO, 6 VDDIO, 7 GND, 8 VDD
# I2C-mode strapping (CSB=VDDIO -> I2C; SDO=GND -> 0x76) is a datasheet
# reference circuit: REVIEW-REQUIRED, recorded in the acquisition record.
_BME280_FP = ("Package_LGA", "Bosch_LGA-8_2.5x2.5mm_P0.65mm_ClockwisePinNumbering")


def _bme280_pmap(n):
    return {"1": "GND", "7": "GND", "8": "+3V3", "6": "+3V3",   # VDD + VDDIO
            "2": "+3V3",                                         # CSB high = I2C
            "5": "GND",                                          # SDO low = 0x76
            "3": n.get("i2c_sda", "I2C_SDA"), "4": n.get("i2c_scl", "I2C_SCL")}


def block_bme280(x, y, n, nets):
    """BME280 T/H/P sensor on the shared I2C bus (JIT primitive, evidence state
    tracked in the fleet ledger — sandbox-routed, NOT physically validated).
    No accuracy/calibration claim."""
    b = place(_BME280_FP[0], _BME280_FP[1], "U18", x + 5, y + 6, 0,
              _bme280_pmap(n), nets)
    b += cap("C33", x + 12, y + 14, "+3V3", "GND", nets)  # VDD decoupling
    b += cap("C34", x + 16, y + 10, "+3V3", "GND", nets)  # VDDIO decoupling
    b += tp("TP45", x + 5, y + 14, n.get("i2c_sda", "I2C_SDA"), nets)
    label("BME280 T/H/P 0x76 (uncal)", x + 8, y + 1, 0.6)
    _DEVICES.append({"ref": "U18", "type": "i2c_envsensor", "name": "BME280",
                     "i2c_address": "0x76",
                     "jit": "sandbox-routed primitive; accuracy uncalibrated"})
    return b, 18, 18


def block_bme280_breakout(x, y, n, nets):
    """Standalone BME280 sandbox breakout (no MCU): sensor + I2C header + THIS
    BOARD OWNS the bus pull-ups (single-owner rule, explicit) + TPs."""
    b = place(_BME280_FP[0], _BME280_FP[1], "U18", x + 5, y + 8, 0,
              _bme280_pmap(n), nets)
    b += cap("C33", x + 2, y + 21, "+3V3", "GND", nets)
    b += cap("C34", x + 8, y + 21, "+3V3", "GND", nets)
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x04_P2.54mm_Vertical",
               "J22", x + 20, y + 8, 0,
               {"1": "+3V3", "2": "GND",
                "3": n.get("i2c_sda", "I2C_SDA"), "4": n.get("i2c_scl", "I2C_SCL")}, nets)
    # breakout OWNS its pull-ups (no MCU on board; explicit single owner)
    b += res("R97", x + 27, y + 5, n.get("i2c_sda", "I2C_SDA"), "+3V3", nets)
    b += res("R98", x + 27, y + 10, n.get("i2c_scl", "I2C_SCL"), "+3V3", nets)
    b += tp("TP46", x + 5, y + 16, n.get("i2c_sda", "I2C_SDA"), nets)
    b += tp("TP47", x + 11, y + 16, n.get("i2c_scl", "I2C_SCL"), nets)
    label("BME280 BREAKOUT 0x76", x + 14, y + 1, 0.7)
    label("J22: 3V3 GND SDA SCL (pullups on board)", x + 16, y + 20, 0.6)
    _DEVICES.append({"ref": "U18", "type": "i2c_envsensor", "name": "BME280",
                     "i2c_address": "0x76", "jit": "SANDBOX breakout article"})
    return b, 34, 24


# =============================================================================
# Phase 23.2 — synthesized generic subcircuits. Low-risk ordinary PCB structure
# generated from functional intent instead of hand-written blocks. ALL
# synthesized subcircuits are REVIEW-REQUIRED and never count as physically
# validated. High-current/HV/RF/high-speed/safety-critical kinds do not exist
# here by design.
# Each emitter: (x, y, p, n, nets) -> (footprint_text, w, h); p = params dict.
_SC_REF = [0]


def _scref(prefix):
    _SC_REF[0] += 1
    return "%s%d" % (prefix, 300 + _SC_REF[0])


def sc_pullup(x, y, p, n, nets):
    b = res(_scref("R"), x + 2, y + 3, p["net"], p.get("rail", "+3V3"), nets)
    return b, 6, 7


def sc_pulldown(x, y, p, n, nets):
    b = res(_scref("R"), x + 2, y + 3, p["net"], "GND", nets)
    return b, 6, 7


def sc_divider(x, y, p, n, nets):
    b = res(_scref("R"), x + 2, y + 3, p["top"], p["mid"], nets)
    b += res(_scref("R"), x + 2, y + 8, p["mid"], p.get("bottom", "GND"), nets)
    return b, 6, 12


def sc_led_indicator(x, y, p, n, nets):
    knet = "%s_K" % p.get("name", "LED")
    b = place("LED_SMD", "LED_0603_1608Metric", _scref("D"), x + 2, y + 3, 0,
              {"1": knet, "2": p.get("rail", "+3V3")}, nets)
    b += res(_scref("R"), x + 2, y + 8, knet, "GND", nets)
    label(p.get("label", "LED"), x + 2, y + 1, 0.6)
    return b, 7, 11


def sc_button(x, y, p, n, nets):
    b = place("Button_Switch_SMD", "SW_SPST_EVQP0", _scref("SW"), x + 3, y + 4, 0,
              {"1": p["net"], "2": "GND"}, nets)
    b += res(_scref("R"), x + 3, y + 9, p["net"], p.get("rail", "+3V3"), nets)
    label(p.get("label", "BTN"), x + 3, y + 1, 0.6)
    return b, 9, 12


def sc_decoupling(x, y, p, n, nets):
    b, cnt = "", int(p.get("count", 2))
    for i in range(cnt):
        b += cap(_scref("C"), x + 2 + i * 4, y + 3, p.get("rail", "+3V3"), "GND", nets)
    return b, 2 + cnt * 4 + 2, 7


def sc_testpoints(x, y, p, n, nets):
    b = ""
    for i, tnet in enumerate(p["nets"]):
        b += tp(_scref("TP"), x + 3 + i * 6, y + 4, tnet, nets)
        label(tnet, x + 3 + i * 6, y + 1, 0.5)
    return b, 3 + len(p["nets"]) * 6 + 2, 8


def _sc_header(x, y, p, n, nets, pins, label_txt):
    fp = "PinHeader_1x%02d_P2.54mm_Vertical" % len(pins)
    b = place("Connector_PinHeader_2.54mm", fp, _scref("J"), x + 3, y + 5, 0,
              {str(i + 1): net for i, net in enumerate(pins)}, nets)
    label(label_txt, x + 3, y + 1, 0.6)
    return b, 10, 6 + len(pins) * 2.6


def sc_i2c_header(x, y, p, n, nets):
    return _sc_header(x, y, p, n, nets,
                      ["+3V3", "GND", n.get("i2c_sda", "I2C_SDA"),
                       n.get("i2c_scl", "I2C_SCL")], "I2C 3V3 GND SDA SCL")


def sc_spi_header(x, y, p, n, nets):
    return _sc_header(x, y, p, n, nets,
                      ["+3V3", "GND", n.get("spi_sck", "SPI_SCK"),
                       n.get("spi_mosi", "SPI_MOSI"), n.get("spi_miso", "SPI_MISO"),
                       n.get("spi_cs", "SPI_CS")], "SPI")


def sc_uart_header(x, y, p, n, nets):
    return _sc_header(x, y, p, n, nets,
                      [n.get("uart_gps_tx", "UART_TX"), n.get("uart_gps_rx", "UART_RX"),
                       "+3V3", "GND"], "UART TX RX 3V3 GND")


def sc_gpio_header(x, y, p, n, nets):
    return _sc_header(x, y, p, n, nets, p.get("nets", ["GPIO0", "GPIO1", "GND"]),
                      p.get("label", "GPIO"))


def sc_debug_header(x, y, p, n, nets):
    return _sc_header(x, y, p, n, nets, p.get("nets", ["RUN", "GND"]),
                      p.get("label", "DEBUG/RESET"))


def sc_power_header(x, y, p, n, nets):
    b, w, h = _sc_header(x, y, p, n, nets, [p.get("rail", "+5V"), "GND"],
                         p.get("label", "PWR IN"))
    b += cap(_scref("C"), x + 3, y + int(h), p.get("rail", "+5V"), "GND", nets)
    return b, w, h + 5


def sc_solder_jumper(x, y, p, n, nets):
    b = place("Jumper", "SolderJumper-2_P1.3mm_Open_Pad1.0x1.5mm", _scref("JP"),
              x + 3, y + 4, 0, {"1": p["a"], "2": p["b"]}, nets)
    label(p.get("label", "SEL"), x + 3, y + 1, 0.5)
    return b, 8, 8


def sc_rc_filter(x, y, p, n, nets):
    b = res(_scref("R"), x + 2, y + 3, p["in"], p["out"], nets)
    b += cap(_scref("C"), x + 2, y + 8, p["out"], "GND", nets)
    return b, 6, 12


def sc_voltage_monitor(x, y, p, n, nets):
    return sc_divider(x, y, {"top": p["rail"], "mid": p["tap"],
                             "bottom": "GND"}, n, nets)


SUBCIRCUITS = {
    "pullup": sc_pullup, "pulldown": sc_pulldown, "divider": sc_divider,
    "led_indicator": sc_led_indicator, "button": sc_button,
    "decoupling_cluster": sc_decoupling, "testpoint_cluster": sc_testpoints,
    "i2c_header": sc_i2c_header, "spi_header": sc_spi_header,
    "uart_header": sc_uart_header, "gpio_header": sc_gpio_header,
    "debug_header": sc_debug_header, "power_header": sc_power_header,
    "address_jumper": sc_solder_jumper, "config_jumper": sc_solder_jumper,
    "rc_filter": sc_rc_filter, "voltage_monitor": sc_voltage_monitor,
    # mounting holes / fiducials / board-name silk are universal primitives
    # emitted for every board already (Phase 15.6) — intent maps to those.
}


def block_usbc_sink(x, y, n, nets):
    """USB-C 5V SINK power entry (JIT primitive, Phase 23.2 benchmark): GCT
    USB4125 6-pin POWER-ONLY receptacle — no data pins EXIST on this part, so
    no data claim is possible by construction. CC1/CC2 get 5.1k pull-downs
    (UFP sink advertisement). HONESTY: no USB compliance claim, no PD claim,
    no charger — 5V/USB-default-current sink only, review-required."""
    b = place("Connector_USB", "USB_C_Receptacle_GCT_USB4125-xx-x_6P_TopMnt_Horizontal",
              "J25", x + 6, y + 8, 0,
              {"A9": "+5V", "B9": "+5V", "A12": "GND", "B12": "GND",
               "A5": "USB_CC1", "B5": "USB_CC2", "SH": "GND"}, nets)
    b += res("R99", x + 14, y + 4, "USB_CC1", "GND", nets)
    b += res("R100", x + 14, y + 9, "USB_CC2", "GND", nets)
    b += cap("C35", x + 14, y + 14, "+5V", "GND", nets)
    b += tp("TP55", x + 3, y + 18, "+5V", nets)
    label("USB-C 5V SINK ONLY (no PD, no data)", x + 10, y + 1, 0.6)
    _DEVICES.append({"ref": "J25", "type": "connector",
                     "name": "USB-C 5V sink (USB4125 power-only)",
                     "jit": "no compliance/PD/data claims"})
    return b, 22, 22


def block_standalone_marker(x, y, n, nets):
    """No-op: marks a board as intentionally MCU-less (breakouts, passive
    boards). Emits nothing."""
    return "", 0, 0


def block_relay_matrix(x, y, n, nets):
    """FL-1 relay / instrument-routing matrix (B-4) — Compose's native domain,
    built entirely from the block layer on coarse resolved parts. An MCU shifts a
    select word into a 74HC595, a ULN2803 buffers those bits to relay coils, and
    each DPDT relay multiplexes a probe point onto the shared instrument bus.
    All SOIC/through-hole (>=1.27mm), so it routes clean."""
    # 74HC595: SPI serial in -> 8 parallel select lines. SAFE DEFAULT: /OE is
    # gated on SR_OE with a pull-up, so outputs are Hi-Z (relays OFF, ULN inputs
    # float low) from power-up until the MCU loads a safe word and drives SR_OE
    # low. Without this the register powers up random with outputs enabled and
    # relay coils can chatter during boot.
    b, _ = sourced_ic("74HC595 8-bit shift register", "shift_register", {
        "power": "+5V", "gnd": "GND", "sr_oe": n.get("sr_oe", "SR_OE"),
        "sr_ser": n["spi_mosi"], "sr_srclk": n["spi_sck"], "sr_rclk": n["spi_cs"],
        "sr_q0": "SR_Q0", "sr_q1": "SR_Q1", "sr_q2": "SR_Q2", "sr_q3": "SR_Q3"},
        "U7", x + 8, y + 10, 0, nets)
    b += cap("C20", x + 8, y + 18, "+5V", "GND", nets)
    b += res("R21", x + 2, y + 10, n.get("sr_oe", "SR_OE"), "+5V", nets)  # OE pull-up: off at boot
    # ULN2803: buffer the select bits to relay-coil sinks (COM -> +5V flyback)
    b2, _ = sourced_ic("ULN2803 octal darlington driver", "darlington_array", {
        "gnd": "GND", "drv_com": "+5V",
        "drv_in0": "SR_Q0", "drv_in1": "SR_Q1", "drv_in2": "SR_Q2", "drv_in3": "SR_Q3",
        "drv_out0": "COIL0", "drv_out1": "COIL1", "drv_out2": "COIL2", "drv_out3": "COIL3"},
        "U8", x + 26, y + 10, 0, nets)
    b += b2
    # 4 DPDT signal relays (Omron G6K, compact SMD): coil pin 8->+5V, pin 1->
    # driver sink; pole 1 COM(3)->instrument bus, NO(4)->its probe; pole 2 COM(6)
    # /NO(5)->the Kelvin-sense bus + same probe. Energise a relay to route that
    # probe onto the shared instrument bus.
    for i in range(4):
        rx = x + 10 + i * 15
        b += place("Relay_SMD", "Relay_DPDT_Omron_G6K-2F-Y", "K%d" % (i + 1),
                   rx, y + 36, 0, {
                       "8": "+5V", "1": "COIL%d" % i,
                       "3": "INSTR_BUS", "4": "PROBE%d" % i,
                       "6": "INSTR_BUS2", "5": "PROBE%d" % i}, nets)
    # instrument bus (2-wire Kelvin) + 4-probe input connector, below the relays
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x02_P2.54mm_Vertical",
               "J7", x + 4, y + 52, 0, {"1": "INSTR_BUS", "2": "INSTR_BUS2"}, nets)
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x04_P2.54mm_Vertical",
               "J9", x + 20, y + 52, 0,
               {"1": "PROBE0", "2": "PROBE1", "3": "PROBE2", "4": "PROBE3"}, nets)
    # channel map on silk + in the device manifest (the review's "clear channel
    # map" requirement): Kx routes PROBEx onto the shared 2-wire instrument bus.
    label("BUS", x + 4, y + 48)
    label("PROBE 0-3", x + 20, y + 48)
    label("K1-K4: PROBEn->BUS", x + 40, y + 50, 0.7)
    _DEVICES.append({"ref": "J7/J9", "type": "channel_map",
                     "name": "relay channel map",
                     "map": {"K%d" % (i + 1): "PROBE%d -> INSTR_BUS/INSTR_BUS2 (DPDT, both poles)" % i
                             for i in range(4)},
                     "safe_default": "SR_OE pulled up: all relays OFF from power-up "
                                     "until MCU enables after loading a safe word"})
    return b, 78, 62


def block_fl1_bus(x, y, n, nets):
    """FL-1 instrument bus header v2 (Phase 16.7). A 2x07 header carrying the
    full backplane interface: power, the shared I2C control bus, the safety/sync
    lines (FAULT, INTERLOCK, RESET, TRIG), and the board-ID ADDRESS STRAPS
    (ID_A0-A2) — the backplane slot drives the straps so multiple boards of the
    same type get unique EEPROM addresses (0x50-0x57); local pull-downs give the
    bench default 0x50. Wired to real MCU pins — role hardware, not a label."""
    pmap = {"1": "+5V", "2": "+3V3",
            "3": n.get("i2c_sda", "I2C_SDA"), "4": n.get("i2c_scl", "I2C_SCL"),
            "5": n.get("fault", "FAULT"), "6": n.get("interlock", "INTERLOCK"),
            "7": n.get("rst_out", "RST_OUT"), "8": n.get("trig", "TRIG"),
            "9": n.get("id_a0", "ID_A0"), "10": n.get("id_a1", "ID_A1"),
            "11": n.get("id_a2", "ID_A2"), "12": "GND", "13": "GND", "14": "GND"}
    b = place("Connector_PinHeader_2.54mm", "PinHeader_2x07_P2.54mm_Vertical",
              "J8", x + 5, y + 8, 0, pmap, nets)
    label("FL1-BUS v2", x + 5, y + 3)
    label("5V 3V3 SDA SCL FLT ILK RST TRG A0 A1 A2 GND", x + 5, y + 27, 0.6)
    _DEVICES.append({"ref": "J8", "type": "connector", "name": "FL-1 instrument bus v2",
                     "id_straps": "ID_A0-A2 from backplane slot (0x50-0x57)"})
    return b, 18, 31


def block_board_id(x, y, n, nets):
    """Board-ID EEPROM v2 (24LC02, SOIC-8) on the shared I2C bus. A0-A2 come from
    the FL-1 bus header's ID straps (backplane slot -> unique address 0x50-0x57)
    with local pull-downs so a bench-standalone board defaults to 0x50 — the fix
    for the all-boards-at-0x50 conflict the cross-board review caught. Without an
    fl1bus block the straps fall back to GND (fixed 0x50, single-board only)."""
    strapped = "id_a0" in n
    a0 = n.get("id_a0", "GND")
    a1 = n.get("id_a1", "GND")
    a2 = n.get("id_a2", "GND")
    b = place("Package_SO", "SOIC-8_3.9x4.9mm_P1.27mm", "U9", x + 9, y + 8, 0, {
        "1": a0, "2": a1, "3": a2, "4": "GND",
        "5": n.get("i2c_sda", "I2C_SDA"), "6": n.get("i2c_scl", "I2C_SCL"),
        "7": "GND", "8": "+3V3"}, nets)
    # decoupling belongs AT the IC's power pin (pin 8, top-right): adjacent
    # placement also lets the plane stitcher serve U9-8 through C25's via.
    b += cap("C25", x + 15, y + 6, "+3V3", "GND", nets)
    if strapped:
        # strap pull-downs: bench default 0x50; the backplane slot overrides
        b += res("R70", x + 2, y + 5, a0, "GND", nets)
        b += res("R71", x + 2, y + 10, a1, "GND", nets)
        b += res("R72", x + 2, y + 15, a2, "GND", nets)
    label("ID 0x50+slot" if strapped else "ID 0x50", x + 9, y + 3)
    _DEVICES.append({"ref": "U9", "type": "board_id_eeprom", "name": "24LC02",
                     "i2c_address": "0x50-0x57 (slot straps, default 0x50)"
                     if strapped else "0x50 (fixed — single-board only)"})
    return b, 20, 22


def block_gpio_bank(x, y, n, nets):
    """Protected GPIO bank: 4 MCU GPIOs, each through a 100R series resistor to a
    labeled header — the external pins take the ESD/short hit at the resistor, not
    the MCU pin. The bring-up board's fan-out role hardware."""
    b = ""
    for i, key in enumerate(("gp_a", "gp_b", "gp_c", "gp_d")):
        b += res("R6%d" % i, x + 4, y + 6 + i * 5, n.get(key, "GPIO%d" % i),
                 "GPIO%d_EXT" % i, nets)
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x05_P2.54mm_Vertical",
               "J10", x + 12, y + 6, 0,
               {"1": "GPIO0_EXT", "2": "GPIO1_EXT", "3": "GPIO2_EXT",
                "4": "GPIO3_EXT", "5": "GND"}, nets)
    label("GPIO 0-3 (100R)", x + 4, y + 2)
    _DEVICES.append({"ref": "J10", "type": "connector", "name": "protected GPIO bank"})
    return b, 20, 32


def block_spibus(x, y, n, nets):
    """SPI bring-up header: the shared SPI bus (SCK/MOSI/MISO/CS) on a labeled
    connector so external targets can be driven — the SPI role the composer
    previously DROPPED instead of building."""
    b = place("Connector_PinHeader_2.54mm", "PinHeader_1x06_P2.54mm_Vertical",
              "J11", x + 4, y + 6, 0,
              {"1": n.get("spi_sck", "SPI_SCK"), "2": n.get("spi_mosi", "SPI_MOSI"),
               "3": n.get("spi_miso", "SPI_MISO"), "4": n.get("spi_cs", "SPI_CS"),
               "5": "+3V3", "6": "GND"}, nets)
    label("SPI SCK MO MI CS 3V3 GND", x + 4, y + 2, 0.6)
    _DEVICES.append({"ref": "J11", "type": "connector", "name": "SPI bring-up header"})
    return b, 12, 24


def block_uart_bridge(x, y, n, nets):
    """External-instrument UART/serial bridge (EII-1). The Pico's UART0 on a
    labeled 1x04 header — TTL-level instrument/console link. RS232 levels need an
    external transceiver (honest limitation, documented, not claimed)."""
    b = place("Connector_PinHeader_2.54mm", "PinHeader_1x04_P2.54mm_Vertical",
              "J12", x + 4, y + 6, 0,
              {"1": n.get("uart_gps_tx", "INSTR_TX"), "2": n.get("uart_gps_rx", "INSTR_RX"),
               "3": "+3V3", "4": "GND"}, nets)
    label("INSTR UART TX RX 3V3 GND (TTL)", x + 4, y + 2, 0.6)
    _DEVICES.append({"ref": "J12", "type": "connector",
                     "name": "instrument UART bridge (TTL)"})
    return b, 12, 20


# free-text sensor detector for blocks no fixed key matched — these SOURCE a
# real part instead of being dropped
SENSOR_PAT = re.compile(
    r"pressure|baro|humidity|hygro|moisture|lux|ambient light|light sensor|als\b|"
    r"proximity|tof|time.of.flight|distance sensor|color sensor|uv\b|co2|voc|"
    r"air quality|gas sensor|magnetometer|compass|hall\b|current sens|power monitor|"
    r"sht\d|bme\d|bmp\d|opt3|veml|apds|vl53|tsl2|ccs811|sgp\d|ina2\d|\bsensor\b",
    re.IGNORECASE)


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
    "comms": block_comms_can,
    "motion": block_motion_controller,
    "instrument": block_dc_measure,
    "dutmonitor": block_dut_monitor,
    "calref": block_calref,
    "calrefext": block_calref_expansion,
    "baremcu": block_mcu_bare,
    "backplane6": block_backplane6,
    "statusled": block_status_led,
    "bme280": block_bme280,
    "bme280breakout": block_bme280_breakout,
    "usbcsink": block_usbc_sink,
    "standalone": block_standalone_marker,
    "relaymatrix": block_relay_matrix,
    "fl1bus": block_fl1_bus,
    "boardid": block_board_id,
    "gpiobank": block_gpio_bank,
    "spibus": block_spibus,
    "uartbridge": block_uart_bridge,
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
    if any(k in s for k in ("can bus", "can comms", "canbus", "comms head",
                            "communications head", "can transceiver")):
        add("comms")
    if any(k in s for k in ("stepper", "motion controller", "stepper driver",
                            "tmc2209", "tmc5160", "step/dir")):
        add("motion")
    if any(k in s for k in ("dut monitor", "dut power monitor", "pcm")):
        add("dutmonitor")
    if any(k in s for k in ("cal reference", "calibration reference", "reference chain",
                            "cal ref")):
        add("calref")
    if any(k in s for k in ("cal expansion", "calibration expansion", "reference ladder",
                            "cal ladder")):
        add("calrefext")
    if any(k in s for k in ("bare rp2040", "bare mcu", "no-pico mcu", "qfn mcu")):
        add("baremcu")
    if any(k in s for k in ("six-slot backplane", "slot backplane", "passive backplane",
                            "backplane slots")):
        add("backplane6")
    if any(k in s for k in ("status led", "power led", "indicator led")):
        add("statusled")
    if "bme280 breakout" in s or "bme280 sandbox" in s:
        add("bme280breakout")
    if any(k in s for k in ("usb-c sink", "usb-c power entry", "usbc sink",
                            "usb c power entry")):
        add("usbcsink")
    if any(k in s for k in ("standalone", "no mcu", "headless board")):
        add("standalone")
    elif any(k in s for k in ("bme280", "environmental sensor", "humidity sensor",
                              "pressure sensor")):
        add("bme280")
    elif any(k in s for k in ("current sense", "current monitor", "dc measure",
                              "power monitor", "ina228", "instrument", "shunt")):
        add("instrument")
    if any(k in s for k in ("relay matrix", "relay bank", "instrument matrix",
                            "probe matrix", "switch matrix", "relay")):
        add("relaymatrix")
    # FL-1 role primitives (Phase 15.6)
    if any(k in s for k in ("fl1 bus", "fl-1 bus", "instrument bus", "bus header",
                            "backplane header")):
        add("fl1bus")
    if any(k in s for k in ("board id", "board-id", "id eeprom", "identity eeprom")):
        add("boardid")
    if any(k in s for k in ("gpio bank", "protected io", "protected gpio")):
        add("gpiobank")
    if re.search(r"\bspi\b", s):
        add("spibus")
    if any(k in s for k in ("uart bridge", "serial bridge", "instrument uart",
                            "instrument serial")):
        add("uartbridge")
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
    seen, uniq, dropped, sensor_reqs = set(), [], [], []
    for b in blocks:
        ks = _block_keys(b)
        if not ks:
            if SENSOR_PAT.search(b):
                sensor_reqs.append(b)
            else:
                dropped.append(b)
        for k in ks:
            if k not in seen:
                seen.add(k)
                uniq.append(k)
    # ensure a usable baseline: every board needs an MCU + a power inlet.
    # A bare-RP2040 block IS the MCU; a no-Pico candidate must never get the
    # Pico module auto-added (and never both).
    if "baremcu" in seen and "mcu" in seen:
        uniq.remove("mcu")
        seen.discard("mcu")
    if "backplane6" in seen and "mcu" in seen and len(seen) <= 3:
        pass  # explicit mcu request stands
    if not (seen & {"mcu", "baremcu", "backplane6", "bme280breakout",
                    "standalone"}):
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
    return uniq, dropped, sensor_reqs


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

# Phase 23.4: 2-layer rigid profile — F/B only, NO internal planes, through
# vias only. +3V3 becomes a ROUTED net (no PWR plane exists); GND pours on
# both outer layers with an explicit stitching strategy. Selected ONLY by
# spec {"layers": 2}; the proven 4-layer path is untouched otherwise.
LAYERS2 = '''  (layers
    (0 "F.Cu" signal) (31 "B.Cu" signal)
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
       "gnss": 0, "cellular": 0, "tempsensor": 0, "comms": 0, "motion": 1,
       "instrument": 0, "dutmonitor": 0, "calref": 0, "calrefext": 0, "backplane6": 0,
       "statusled": 0, "bme280": 0, "bme280breakout": 0, "usbcsink": 0,
       "standalone": 0,
       "baremcu": 0, "relaymatrix": 1, "motors": 1,
       "fl1bus": 0, "boardid": 0, "gpiobank": 0, "spibus": 0, "uartbridge": 0}
COL = {"power": 0, "usbc": 0, "mcu": 2, "imu": 3, "tempsensor": 3, "gnss": 4,
       "radio": 5, "cellular": 6, "comms": 7, "antenna": 9, "motors": 1,
       "motion": 3, "instrument": 4, "dutmonitor": 4, "calref": 5, "calrefext": 6,
       "backplane6": 1, "statusled": 6, "bme280": 3, "bme280breakout": 1,
       "usbcsink": 0, "standalone": 9,
       "baremcu": 2, "relaymatrix": 1,
       "boardid": 3, "fl1bus": 8, "gpiobank": 8, "spibus": 8, "uartbridge": 9}
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
    _DEVICES[:] = []  # reset the per-board device manifest
    _SILK[:] = []     # reset the per-board functional silkscreen labels
    keys, dropped, sensor_reqs = classify(blocks)
    dyn = {}
    for i, desc in enumerate(sensor_reqs):
        dyn["gsensor%d" % i] = desc
    keys = keys + sorted(dyn)
    # Phase 23.2: synthesized subcircuits ride the same band layout as blocks.
    # Every synthesized subcircuit is REVIEW-REQUIRED (recorded in the device
    # manifest) and never physically validated by generation.
    _SC_REF[0] = 0
    subs = {}
    for i, entry in enumerate((spec or {}).get("subcircuits") or []):
        kind = entry.get("kind")
        if kind not in SUBCIRCUITS:
            raise RuntimeError("unknown synthesized subcircuit kind: %r" % kind)
        subs["zsc%02d" % i] = entry
    keys = keys + sorted(subs)
    if subs:
        _DEVICES.append({"ref": "(synthesized)", "type": "synthesized_subcircuits",
                         "kinds": [e["kind"] for e in subs.values()],
                         "honesty": "generated, REVIEW-REQUIRED, not physically "
                                    "validated"})

    # shared interface nets — allocated only for the buses that are actually
    # used, so the MCU and netlist carry no dangling stubs.
    n = {}
    if "radio" in keys:
        n.update({"spi_sck": "SPI_SCK", "spi_mosi": "SPI_MOSI", "spi_miso": "SPI_MISO",
                  "spi_cs": "LORA_NSS", "ctrl_rst": "LORA_RST", "ctrl_irq": "LORA_DIO0",
                  "ant": "ANT"})
    if ("imu" in keys or "tempsensor" in keys or "instrument" in keys or dyn
            or "calref" in keys or "dutmonitor" in keys or "bme280" in keys):
        n.update({"i2c_sda": "I2C_SDA", "i2c_scl": "I2C_SCL"})  # shared I2C bus
    # synthesized headers request the matching MCU nets (Phase 23.2): a
    # generated UART/I2C/SPI header must be WIRED, never labels-only copper.
    _sub_kinds = {e["kind"] for e in subs.values()}
    if "i2c_header" in _sub_kinds:
        n.setdefault("i2c_sda", "I2C_SDA")
        n.setdefault("i2c_scl", "I2C_SCL")
    if "uart_header" in _sub_kinds:
        n.setdefault("uart_gps_tx", "UART_TX")
        n.setdefault("uart_gps_rx", "UART_RX")
    if "spi_header" in _sub_kinds:
        n.setdefault("spi_sck", "SPI_SCK")
        n.setdefault("spi_mosi", "SPI_MOSI")
        n.setdefault("spi_miso", "SPI_MISO")
        n.setdefault("spi_cs", "SPI_CS")
    if "imu" in keys:
        n["imu_int"] = "IMU_INT"
    if "motors" in keys:
        n.update({"mot1": "MOTOR1", "mot2": "MOTOR2", "mot3": "MOTOR3", "mot4": "MOTOR4"})
    if "gnss" in keys:
        n.update({"uart_gps_tx": "GPS_TX", "uart_gps_rx": "GPS_RX"})
    if "comms" in keys:
        n.update({"can_txd": "CAN_TXD", "can_rxd": "CAN_RXD"})
    if "relaymatrix" in keys and "spi_sck" not in n:
        n.update({"spi_sck": "SPI_SCK", "spi_mosi": "SPI_MOSI", "spi_cs": "SR_LATCH"})
    if "relaymatrix" in keys:
        n["sr_oe"] = "SR_OE"     # safety: shift-register outputs gated, off at boot
    # FL-1 role primitives (Phase 15.6)
    if "fl1bus" in keys or "boardid" in keys:
        n.setdefault("i2c_sda", "I2C_SDA")
        n.setdefault("i2c_scl", "I2C_SCL")
    if "fl1bus" in keys:
        n.update({"fault": "FAULT", "interlock": "INTERLOCK",
                  "rst_out": "RST_OUT", "trig": "TRIG",
                  "id_a0": "ID_A0", "id_a1": "ID_A1", "id_a2": "ID_A2"})
    if "gpiobank" in keys:
        n.update({"gp_a": "GPIO0", "gp_b": "GPIO1", "gp_c": "GPIO2", "gp_d": "GPIO3"})
    if "spibus" in keys and "spi_sck" not in n:
        n.update({"spi_sck": "SPI_SCK", "spi_mosi": "SPI_MOSI",
                  "spi_miso": "SPI_MISO", "spi_cs": "SPI_CS"})
    if "uartbridge" in keys and "uart_gps_tx" not in n:
        n.update({"uart_gps_tx": "INSTR_TX", "uart_gps_rx": "INSTR_RX"})
    if "motion" in keys:
        n.update({"step": "STEP", "dir": "DIR", "en": "MOT_EN"})
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
            def build(bx, by, kk=k):
                if kk in dyn:
                    return block_sourced_sensor(bx, by, n, nets, dyn[kk], kk)
                if kk in subs:
                    e = subs[kk]
                    return SUBCIRCUITS[e["kind"]](bx, by, e.get("params", {}), n, nets)
                return BLOCK_TABLE[kk](bx, by, n, nets)
            txt, w, h = build(x, ytop)
            # wrap to a new sub-row if this band overflows the width budget
            if x > X0 + MARGIN and (x + w - X0) > ROW_BUDGET:
                maxright = max(maxright, x - GAP)  # capture this sub-row's reach
                x = X0 + MARGIN
                ytop += rowh + ROWGAP
                rowh = 0
                txt, w, h = build(x, ytop)
            body += txt
            x += w + GAP
            rowh = max(rowh, h)
        maxright = max(maxright, x - GAP)
        ytop += rowh + ROWGAP

    BW = round(maxright + MARGIN - X0, 1)
    BH = round(ytop - ROWGAP - (Y0 + MARGIN) + 2 * MARGIN, 1)

    # mounting holes (Phase 15.6 role primitive): 4x M3 in the corners — every
    # real FL-1 board must be mountable/fixturable. The corner margins are part
    # of the outline margin band, clear of the part rows.
    # 7mm inset: the M3 pad (~6.8mm dia) needs >=3.0mm edge clearance at the
    # placement gate (7.0 - 3.4 pad radius = 3.6mm clear).
    for i, (hx, hy) in enumerate([(7, 7), (BW - 7, 7), (7, BH - 7), (BW - 7, BH - 7)]):
        body += place("MountingHole", "MountingHole_3.2mm_M3", "H" + str(i + 1),
                      X0 + hx, Y0 + hy, 0, {}, nets)

    # assembly fiducials (3, inboard of the mounting holes, clear of the part band)
    # + a router keepout around each: the fiducial pad carries a 0.6mm clearance
    # ring the grid router does not model, so without the keepout a track can run
    # legally-by-grid but violate the fiducial's pad clearance (the FID3/+5V DRC
    # hits on the dc-measure fixture).
    for i, (fx, fy) in enumerate([(13, 6), (BW - 13, 6), (13, BH - 6)]):
        body += place("Fiducial", "Fiducial_1mm_Mask2mm", "FID" + str(i + 1),
                      X0 + fx, Y0 + fy, 0, {}, nets)
        kx0, ky0 = X0 + fx - 1.4, Y0 + fy - 1.4
        kx1, ky1 = X0 + fx + 1.4, Y0 + fy + 1.4
        body += ('  (zone (net 0) (net_name "") (layer "F.Cu") (uuid "{}") (hatch edge 0.5)\n'
                 '    (connect_pads (clearance 0)) (min_thickness 0.25)\n'
                 '    (keepout (tracks not_allowed) (vias not_allowed) (pads allowed)'
                 ' (copperpour allowed) (footprints allowed))\n'
                 '    (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))\n'
                 '    (polygon (pts (xy {} {}) (xy {} {}) (xy {} {}) (xy {} {}))))\n'
                 ).format(U(), kx0, ky0, kx1, ky0, kx1, ky1, kx0, ky1)

    # test points (Phase 15.6 role primitive): labeled probe pads on the rails +
    # the shared buses/safety lines, along the bottom margin band.
    tp_nets = ["+5V", "+3V3", "GND"]
    for cand in ("I2C_SDA", "I2C_SCL", "FAULT", "INTERLOCK", "TRIG", "SR_OE"):
        if cand in nets.idx:
            tp_nets.append(cand)
    tx = X0 + 22
    for i, tnet in enumerate(tp_nets):
        body += tp("TP%d" % (i + 1), tx, Y0 + BH - 5, tnet, nets)
        label(tnet, tx, Y0 + BH - 9, 0.6)
        tx += 7

    # board name + revision on silk (functional labels, not just refs)
    board_name = str((spec or {}).get("boardClass") or "FL-1 board")[:40]
    label("%s  rev A" % board_name, X0 + BW / 2, Y0 + 3)
    for text, lx, ly, size in _SILK:
        body += _silk_text(text, lx, ly, size)

    # blocks hardcode their reference designators, so two similar blocks (e.g. a
    # USB-C inlet + a header power block) can both emit J1/C1. Renumber any
    # duplicate references to keep every footprint unique — KiCad rejects a board
    # with collisions and DSN export fails. Defensive: works no matter what mix
    # of blocks the classifier produced.
    body = _unique_refs(body)

    two_layer = (spec or {}).get("layers") == 2
    p = '(kicad_pcb (version 20240108) (generator "ee-lab-compose") (generator_version "8.0")\n'
    p += '  (general (thickness 1.6))\n  (paper "A4")\n' + (LAYERS2 if two_layer else LAYERS)
    p += '  (setup (pad_to_mask_clearance 0))\n'
    for i, name in enumerate(nets.order):
        p += '  (net {} "{}")\n'.format(i, name)
    # outline + corner mounting holes
    p += ('  (gr_rect (start {} {}) (end {} {}) (stroke (width 0.15) (type default))'
          ' (fill none) (layer "Edge.Cuts") (uuid "{}"))\n').format(X0, Y0, X0 + BW, Y0 + BH, U())
    if two_layer:
        # 2-layer ground strategy: GND pours on BOTH outer layers, stitched by
        # through vias. +3V3 has NO plane — it is a routed net like any signal.
        # No controlled-impedance / RF / precision-analog / physical claims.
        p += gzone("GND", "F.Cu", X0, Y0, X0 + BW, Y0 + BH, nets)
        p += gzone("GND", "B.Cu", X0, Y0, X0 + BW, Y0 + BH, nets)
        print("COMPOSE: 2-LAYER profile (F/B only, +3V3 routed, GND pours F+B)")
    else:
        # GND pours on F/B/In1, PWR on In2 (the proven 4-layer flow)
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
        base = os.path.splitext(out_path)[0]
        open(base + ".kicad_dru", "w").write(
            "(version 1)\n"
            "# Fine-pitch parts make this a 6-mil fab class; 0.13mm (5-mil) copper\n"
            "# clearance is supported by every standard 2-layer fab.\n"
            '(rule "fab_6mil"\n'
            "  (constraint clearance (min 0.13mm)))\n")
        # finer via class so the geometry stitch's 0.4/0.2 via on a fine-pitch pad
        # is legal; net-class defaults match the board so plane zones still connect.
        open(base + ".kicad_pro", "w").write(json.dumps({
            "board": {"design_settings": {"rules": {
                "min_clearance": 0.0, "min_hole_clearance": 0.2, "min_hole_to_hole": 0.2,
                "min_microvia_diameter": 0.2, "min_microvia_drill": 0.1,
                "min_through_hole_diameter": 0.2, "min_via_annular_width": 0.05,
                "min_via_diameter": 0.35}}},
            "net_settings": {"classes": [{"name": "Default", "clearance": 0.2,
                "track_width": 0.2, "via_diameter": 0.6, "via_drill": 0.3,
                "microvia_diameter": 0.3, "microvia_drill": 0.1,
                "diff_pair_gap": 0.25, "diff_pair_width": 0.2, "priority": 2147483647}]},
            "meta": {"filename": os.path.basename(base) + ".kicad_pro", "version": 3}}))

    # device manifest sidecar — firmware reads this to drive the actual parts
    open(os.path.splitext(out_path)[0] + ".devices.json", "w").write(json.dumps(_DEVICES))

    print("COMPOSE: blocks {} -> {} components placed, {:.0f}x{:.0f}mm, {} nets".format(
        keys, p.count("(footprint "), BW, BH, len(nets.order) - 1))
    print("COMPOSE_BLOCKS:" + ",".join(keys))
    # coverage: what the spec asked for vs. what the library could build. The
    # pipeline surfaces `dropped` loudly so an incomplete board never reads as a
    # silent clean pass.
    mapped_out = [k for k in keys if k not in dyn] + \
        ["sensor:" + dyn[k] for k in keys if k in dyn]
    print("COMPOSE_COVERAGE:" + json.dumps({"mapped": mapped_out, "dropped": dropped}))


def main():
    spec = json.load(open(sys.argv[1])) if len(sys.argv) > 1 and os.path.exists(sys.argv[1]) else {}
    out_path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/composed.kicad_pcb"
    blocks = spec.get("blocks", ["power", "mcu", "lora radio", "antenna"])
    compose(spec, blocks, out_path)


if __name__ == "__main__":
    main()
