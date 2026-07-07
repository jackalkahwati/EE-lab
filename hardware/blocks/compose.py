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
    """FL-1 instrument bus header (Phase 15.6 role primitive). A 2x05 header
    carrying the backplane interface every FL-1 board needs: power, the shared
    I2C control bus, and the safety/sync lines (FAULT, INTERLOCK, RESET, TRIG).
    Wired to real MCU pins via the shared net map — role hardware, not a label."""
    pmap = {"1": "+5V", "2": "+3V3",
            "3": n.get("i2c_sda", "I2C_SDA"), "4": n.get("i2c_scl", "I2C_SCL"),
            "5": n.get("fault", "FAULT"), "6": n.get("interlock", "INTERLOCK"),
            "7": n.get("rst_out", "RST_OUT"), "8": n.get("trig", "TRIG"),
            "9": "GND", "10": "GND"}
    b = place("Connector_PinHeader_2.54mm", "PinHeader_2x05_P2.54mm_Vertical",
              "J8", x + 5, y + 8, 0, pmap, nets)
    label("FL1-BUS", x + 5, y + 3)
    label("5V 3V3 SDA SCL FLT ILK RST TRG GND", x + 5, y + 22, 0.6)
    _DEVICES.append({"ref": "J8", "type": "connector", "name": "FL-1 instrument bus"})
    return b, 18, 26


def block_board_id(x, y, n, nets):
    """Board-ID EEPROM (24LC02, SOIC-8) on the shared I2C bus — the identity the
    FL-1 interconnect spec requires on every device board. A0-A2 strapped to GND
    (address 0x50), WP grounded (writable in-fixture; strap high for lockdown)."""
    b = place("Package_SO", "SOIC-8_3.9x4.9mm_P1.27mm", "U9", x + 6, y + 8, 0, {
        "1": "GND", "2": "GND", "3": "GND", "4": "GND",
        "5": n.get("i2c_sda", "I2C_SDA"), "6": n.get("i2c_scl", "I2C_SCL"),
        "7": "GND", "8": "+3V3"}, nets)
    b += cap("C25", x + 10, y + 17, "+3V3", "GND", nets)
    label("ID 0x50", x + 6, y + 3)
    _DEVICES.append({"ref": "U9", "type": "board_id_eeprom", "name": "24LC02",
                     "i2c_address": "0x50"})
    return b, 14, 22


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
    "relaymatrix": block_relay_matrix,
    "fl1bus": block_fl1_bus,
    "boardid": block_board_id,
    "gpiobank": block_gpio_bank,
    "spibus": block_spibus,
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
    if any(k in s for k in ("current sense", "current monitor", "dc measure",
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


# ---- floorplan ---------------------------------------------------------------
# Region-based placement: a function-grouped flow rather than one flat row.
# ROW puts compute/RF/sensors on the top band and bulky edge connectors
# (motors) on their own band below; within a row COL orders blocks so power is
# on the left, the MCU is central, sensors sit next to it (short I2C), and the
# radio + antenna land on the right edge (best RF practice). Rows wrap if a band
# grows past the width budget, so the layout scales as blocks are added.
ROW = {"power": 0, "usbc": 0, "mcu": 0, "imu": 0, "radio": 0, "antenna": 0,
       "gnss": 0, "cellular": 0, "tempsensor": 0, "comms": 0, "motion": 1,
       "instrument": 0, "relaymatrix": 1, "motors": 1,
       "fl1bus": 0, "boardid": 0, "gpiobank": 0, "spibus": 0}
COL = {"power": 0, "usbc": 0, "mcu": 2, "imu": 3, "tempsensor": 3, "gnss": 4,
       "radio": 5, "cellular": 6, "comms": 7, "antenna": 9, "motors": 1,
       "motion": 3, "instrument": 4, "relaymatrix": 1,
       "boardid": 3, "fl1bus": 8, "gpiobank": 8, "spibus": 8}
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

    # shared interface nets — allocated only for the buses that are actually
    # used, so the MCU and netlist carry no dangling stubs.
    n = {}
    if "radio" in keys:
        n.update({"spi_sck": "SPI_SCK", "spi_mosi": "SPI_MOSI", "spi_miso": "SPI_MISO",
                  "spi_cs": "LORA_NSS", "ctrl_rst": "LORA_RST", "ctrl_irq": "LORA_DIO0",
                  "ant": "ANT"})
    if "imu" in keys or "tempsensor" in keys or "instrument" in keys or dyn:  # shared I2C bus
        n.update({"i2c_sda": "I2C_SDA", "i2c_scl": "I2C_SCL"})
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
                  "rst_out": "RST_OUT", "trig": "TRIG"})
    if "gpiobank" in keys:
        n.update({"gp_a": "GPIO0", "gp_b": "GPIO1", "gp_c": "GPIO2", "gp_d": "GPIO3"})
    if "spibus" in keys and "spi_sck" not in n:
        n.update({"spi_sck": "SPI_SCK", "spi_mosi": "SPI_MOSI",
                  "spi_miso": "SPI_MISO", "spi_cs": "SPI_CS"})
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
    for i, (fx, fy) in enumerate([(13, 6), (BW - 13, 6), (13, BH - 6)]):
        body += place("Fiducial", "Fiducial_1mm_Mask2mm", "FID" + str(i + 1),
                      X0 + fx, Y0 + fy, 0, {}, nets)

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
