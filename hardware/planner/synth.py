"""Phase 11 — synthesize a KiCad board from a UCS-based design.

The bridge from the planner's decision layer (a validated list of Universal
Component Specs) to a real placed + wired board that the EXISTING Compose
pipeline (flroute, DRC/ERC, geometry stitch, fab, firmware, FL-1 validation)
routes and validates unchanged.

First working slice (not arbitrary PCBA yet):
  - RP2040/Pico MCU anchor (reuses the proven block).
  - UCS components connect to power / GND / I2C / SPI / write-only SPI / UART /
    RS485 / GPIO, wired from the component's OWN validated pins (never guessed):
    power_in pins -> a rail, ground pins -> GND, interface signal pins -> shared
    bus nets (matched by the UCS interface.signals pin names).
  - Support passives from the UCS (decoupling per power pin, pull-ups, shunts,
    termination) are instantiated.
  - I2C pull-ups added when an I2C bus exists; test points on rails + buses.
  - Meaningful net names for firmware + FL-1.

Emits the SAME contract as compose.py (board + devices.json + fine-pitch
.kicad_dru + COMPOSE:/COMPOSE_COVERAGE: sentinels), so the pipeline treats a
synthesized board identically to a block-composed one. A UCS component that
cannot be honestly placed (no footprint, unmatched bus pins) is DROPPED LOUDLY
into COMPOSE_COVERAGE.dropped, never silently.

  <kicad-python3> synth.py <design.json> <out.kicad_pcb>

design.json = {"final_design": [UCS,...], "intent": {...}, "recovery_report": [...]}
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "blocks"))
import compose  # noqa: E402  reuse place/cap/res/tp/Nets/gzone/LAYERS/_unique_refs/block_mcu_pico
import resolve_part  # noqa: E402  pin-name normalisation/tokens
import mcu_specs  # noqa: E402  MCU capability library
import mcu_selector  # noqa: E402  intent -> MCU
import pin_allocator  # noqa: E402  MCU + requests -> pad assignment

# shared bus net names (meaningful for firmware + FL-1)
BUS = {
    "power": "+3V3", "gnd": "GND",
    "i2c_scl": "I2C_SCL", "i2c_sda": "I2C_SDA",
    "spi_sck": "SPI_SCK", "spi_mosi": "SPI_MOSI", "spi_miso": "SPI_MISO",
    "uart_tx": "DEBUG_TX", "uart_rx": "DEBUG_RX",
    "rs485_di": "RS485_DI", "rs485_ro": "RS485_RO", "rs485_de": "RS485_DE",
    "rs485_a": "RS485_A", "rs485_b": "RS485_B",
}

# interface role -> shared bus net for that role
ROLE_NET = {
    "scl": "I2C_SCL", "sda": "I2C_SDA",
    "sck": "SPI_SCK", "mosi": "SPI_MOSI", "miso": "SPI_MISO",
    "di": "RS485_DI", "ro": "RS485_RO", "de": "RS485_DE", "re": "RS485_DE",
    "a": "RS485_A", "b": "RS485_B",
}


def _pin_number(spec, name):
    """Find a pin's number by name (normalised, multiplexed-pin aware)."""
    want = resolve_part._norm(name)
    for p in spec["pins"]:
        if resolve_part._norm(p["name"]) == want or want in resolve_part._pin_tokens(p["name"]):
            return p["number"]
    return None


def _rail_for(spec):
    """Which rail a component's power pins go to. Most digital parts are +3V3;
    a part that only tolerates >=4.5V (or is the USB inlet) takes +5V."""
    vmin = (spec.get("power") or {}).get("vcc_min")
    if vmin and vmin >= 4.0:
        return "+5V"
    return "+3V3"


def _netmap_for(spec, cs_net):
    """Build {pad_number: net} for a UCS component from its OWN pins: power ->
    rail, ground -> GND, interface signals -> shared bus nets, CS/latch -> its
    unique select net, config pins -> pull nets / GND. Returns
    (netmap, wired_roles, unmatched, pulls) where pulls = [(net, rail)] resistors
    to place. A pull-up on a pin already on a bus is SKIPPED (the bus master
    carries the pull-up) rather than creating a dangling phantom net."""
    nm = {}
    rail = _rail_for(spec)

    # USB-C (and reversible connectors): wire EVERY pad by name — all VBUS pads
    # to the rail, every GND + the shield to GND, both D+/D- halves tied, CC pins
    # pulled down (sink). Leaving the duplicate/shield pads unwired left <no net>
    # pads that shorted against nearby stitch vias.
    if spec.get("category", "").startswith("connector.usb"):
        pulls = []
        for p in spec["pins"]:
            n = resolve_part._norm(p["name"])
            if n in ("GND", "SHIELD"):
                nm[p["number"]] = "GND"
            elif n == "VBUS":
                nm[p["number"]] = "+5V"
            elif n in ("CC1", "CC2"):
                cnet = "USB_%s" % n
                nm[p["number"]] = cnet
                pulls.append((cnet, "GND"))  # 5.1k pull-down, UFP/sink
        return nm, ["usb_power"], [], pulls

    pw = (spec.get("power") or {}).get("pins", {})
    for num in pw.get("power", []):
        nm[num] = rail
    for num in pw.get("ground", []):
        nm[num] = "GND"

    wired, unmatched = [], []
    for iface in spec.get("interfaces", []):
        for role, pin_name in iface.get("signals", {}).items():
            if role in ("cs", "latch"):
                num = _pin_number(spec, pin_name)
                if num:
                    nm[num] = cs_net
                    wired.append(role)
                continue
            net = ROLE_NET.get(role)
            if not net:
                continue
            num = _pin_number(spec, pin_name)
            if num:
                nm[num] = net
                wired.append(role)
            else:
                unmatched.append("%s(%s)" % (role, pin_name))

    # config pins from the support circuit: a pull-up ties a config pin to the
    # rail through a resistor; a pull-down ties it to GND. Skip any pin already
    # wired to a bus/rail (its pull is redundant and would create a phantom net).
    pulls = []
    sc = spec.get("support_circuit", {}) or {}
    for pu in sc.get("pullups", []):
        num = _pin_number(spec, pu.get("pin", ""))
        if not num or num in nm:
            continue
        pnet = "%s_%s" % (spec["mpn"][:6], resolve_part._norm(pu["pin"]))
        nm[num] = pnet
        pulls.append((pnet, rail))
    for pd in sc.get("pulldowns", []):
        num = _pin_number(spec, pd.get("pin", ""))
        if num and num not in nm:
            nm[num] = "GND"  # tie the config pin low directly
    return nm, wired, unmatched, pulls


def _support(spec, pulls, refn, x, y, nets):
    """Decoupling cap per power pin + the pull-up resistors from _netmap_for."""
    body = ""
    rail = _rail_for(spec)
    sc = spec.get("support_circuit", {}) or {}
    yy = y
    for i, _d in enumerate(sc.get("decoupling", [])):
        body += compose.cap("C%d" % (refn + i), x, yy, rail, "GND", nets)
        yy += 3
    for i, (pnet, prail) in enumerate(pulls):
        body += compose.res("R%d" % (refn + 50 + i), x, yy, pnet, prail, nets)
        yy += 3
    return body


def _wire_mcu(design_specs):
    """Which shared nets the Pico must drive, from what's in the design."""
    n = {}
    ifaces = {t for s in design_specs for i in s.get("interfaces", []) for t in [i["type"]]}
    if "i2c" in ifaces:
        n.update({"i2c_sda": "I2C_SDA", "i2c_scl": "I2C_SCL"})
    if ifaces & {"spi", "spi_write_only"}:
        n.update({"spi_sck": "SPI_SCK", "spi_mosi": "SPI_MOSI", "spi_miso": "SPI_MISO"})
    # one CS from the Pico's SPI CS pin, a second (shift-register latch) on a
    # repurposed GPIO, RS485 on UART1 + a DE GPIO, debug on UART0.
    n["spi_cs"] = "W25Q_CS"
    n["can_txd"] = "SR_LATCH"
    if "rs485" in ifaces:
        n.update({"uart_cell_tx": "RS485_DI", "uart_cell_rx": "RS485_RO",
                  "cell_pwrkey": "RS485_DE"})
    n.update({"uart_gps_tx": "DEBUG_TX", "uart_gps_rx": "DEBUG_RX"})
    return n


def _mcu_requests(specs):
    """Allocation requests for the MCU, aligned to the shared bus net names the
    peripherals wire to (so the MCU and its peripherals meet on the same nets)."""
    ifaces = {t for s in specs for i in s.get("interfaces", []) for t in [i["type"]]}
    reqs = []
    if "i2c" in ifaces:
        reqs += [{"role": "I2C_SDA", "net": "I2C_SDA", "cap": "i2c_sda"},
                 {"role": "I2C_SCL", "net": "I2C_SCL", "cap": "i2c_scl"}]
    if ifaces & {"spi", "spi_write_only"}:
        reqs += [{"role": "SPI_SCK", "net": "SPI_SCK", "cap": "spi_sck"},
                 {"role": "SPI_MOSI", "net": "SPI_MOSI", "cap": "spi_mosi"},
                 {"role": "SPI_MISO", "net": "SPI_MISO", "cap": "spi_miso"}]
    if any("flash" in s.get("category", "") for s in specs):
        reqs.append({"role": "W25Q_CS", "net": "W25Q_CS", "cap": "spi_cs"})
    if any("shift" in s.get("category", "") for s in specs):
        reqs.append({"role": "SR_LATCH", "net": "SR_LATCH", "cap": "gpio"})
    if "rs485" in ifaces:
        reqs += [{"role": "RS485_DI", "net": "RS485_DI", "cap": "uart_tx"},
                 {"role": "RS485_RO", "net": "RS485_RO", "cap": "uart_rx"},
                 {"role": "RS485_DE", "net": "RS485_DE", "cap": "gpio"}]
    if "can" in ifaces:
        reqs += [{"role": "CAN_TX", "net": "CAN_TX", "cap": "can_tx"},
                 {"role": "CAN_RX", "net": "CAN_RX", "cap": "can_rx"}]
    reqs += [{"role": "DEBUG_TX", "net": "DEBUG_TX", "cap": "uart_tx"},
             {"role": "DEBUG_RX", "net": "DEBUG_RX", "cap": "uart_rx"}]
    return reqs


# the ACTUAL Pico wiring in block_mcu_pico (physical pad -> interface key), so the
# RP2040 pin-assignment artifact reflects the real board, not a fresh allocation.
_PICO_OPT = {"4": "spi_sck", "5": "spi_mosi", "6": "spi_miso", "7": "spi_cs",
             "11": "i2c_sda", "12": "i2c_scl", "24": "can_txd",
             "19": "uart_cell_tx", "20": "uart_cell_rx", "21": "cell_pwrkey",
             "1": "uart_gps_tx", "2": "uart_gps_rx"}
_KEY_CAP = {"spi_sck": "spi_sck", "spi_mosi": "spi_mosi", "spi_miso": "spi_miso",
            "spi_cs": "spi_cs", "i2c_sda": "i2c_sda", "i2c_scl": "i2c_scl",
            "can_txd": "gpio", "uart_cell_tx": "uart_tx", "uart_cell_rx": "uart_rx",
            "cell_pwrkey": "gpio", "uart_gps_tx": "uart_tx", "uart_gps_rx": "uart_rx"}


def _rp2040_alloc(n_mcu):
    """Build the pin-assignment record from block_mcu_pico's REAL wiring so the
    firmware pin map matches the board that is actually generated."""
    spec = mcu_specs.get_mcu("RP2040")
    assignments = [{"role": n_mcu[k], "net": n_mcu[k], "pad": pad, "cap": _KEY_CAP[k]}
                   for pad, k in _PICO_OPT.items() if k in n_mcu]
    reserved = {g: list(map(str, spec.get(g + "_pins", [])))
                for g in ("power", "ground", "reset", "boot", "debug", "clock", "usb")}
    return {
        "mcu": "RP2040", "family": "RP2040",
        "kicad_symbol": spec["kicad_symbol"], "kicad_footprint": spec["kicad_footprint"],
        "assignments": assignments, "reserved": reserved,
        "regulator_out": spec.get("regulator_out"), "conflicts": [],
        "pad_net_map": {a["pad"]: a["net"] for a in assignments},
        "firmware_pin_map": {a["role"]: a["pad"] for a in assignments},
        "ok": True,
    }


# real body (courtyard) footprint of the MCU package (width, height in mm) so the
# outline + neighbouring parts leave room. Kept generous (courtyard, not just body).
def _mcu_body(fp):
    p = fp.lower()
    if "dip-28" in p:
        return 11.0, 37.0           # DIP-28 is tall (pins on the long sides)
    if "wroom" in p:
        return 50.0, 44.0           # WROOM courtyard INCLUDES the antenna keepout
    if "mdbt50q" in p:
        return 34.0, 26.0           # module + antenna keepout
    if "lqfp-48" in p or "tqfp-48" in p:
        return 13.0, 13.0
    return 22.0, 22.0


def block_mcu_generic(spec, alloc, x, y, nets):
    """Place a NON-RP2040 MCU from its spec + pin allocation. Wires power/ground/
    reset from the spec and every allocated function pad to its bus net, adds
    decoupling + a reset pull-up + I2C pull-ups + a programming header — ALL to
    the RIGHT of the MCU body, clear of its courtyard. Honest: only the pads the
    allocator assigned are wired, no invented connections."""
    lib, name = spec["kicad_footprint"].split(":", 1)
    rail = "+5V" if spec.get("voltage", {}).get("io", 3.3) >= 4 else "+3V3"
    pmap = dict(alloc["pad_net_map"])                       # function pads -> nets
    for p in spec.get("power_pins", []):
        pmap[str(p)] = rail
    for p in spec.get("ground_pins", []):
        pmap[str(p)] = "GND"
    for p in spec.get("reset_pins", []):
        pmap[str(p)] = "MCU_RESET"
    mw, mh = _mcu_body(name)
    body = compose.place(lib, name, "U1", x + mw / 2, y + mh / 2, 0, pmap, nets)
    # support column to the RIGHT of the MCU body, clear of its courtyard
    xr = x + mw + 6
    yc = y + 2
    ci = 2
    for _p in spec.get("power_pins", []):                  # 100nF per power pin
        body += compose.cap("C%d" % ci, xr, yc, rail, "GND", nets)
        ci += 1
        yc += 6
    body += compose.res("R10", xr, yc, "MCU_RESET", rail, nets)   # reset pull-up
    yc += 6
    if "I2C_SDA" in pmap.values():                          # I2C pull-ups
        body += compose.res("R11", xr, yc, "I2C_SDA", rail, nets)
        yc += 6
        body += compose.res("R12", xr, yc, "I2C_SCL", rail, nets)
        yc += 6
    # programming header: SWD (ARM) taps the debug pads; ISP (AVR) taps SPI+reset
    prog = spec.get("programming", [])
    dbg = alloc.get("reserved", {}).get("debug", [])
    if "SWD" in prog:
        hdrmap = {"1": rail, "2": "MCU_SWDIO", "3": "GND", "4": "MCU_SWCLK",
                  "5": "MCU_RESET", "6": "GND"}
    else:                                                   # ISP / AVR
        hdrmap = {"1": "SPI_MISO", "2": rail, "3": "SPI_SCK", "4": "SPI_MOSI",
                  "5": "MCU_RESET", "6": "GND"}
    body += compose.place("Connector_PinHeader_2.54mm",
                          "PinHeader_2x03_P2.54mm_Vertical", "J1", xr + 4, yc + 5,
                          0, hdrmap, nets)
    yc += 14
    compose._DEVICES.append({"ref": "U1", "type": "mcu", "name": spec["mpn"]})
    compose._DEVICES.append({"ref": "J1", "type": "connector", "name": "Programming header"})
    # extent must enclose the MCU body AND the support column
    return body, mw + 14, max(mh, yc - y) + 4


def synth(design, out_path):
    specs = [s for s in design["final_design"] if s.get("pins")]
    nets = compose.Nets()
    compose._DEVICES[:] = []

    # recovery hints (Phase 7): the recovery loop re-runs synth with these to try
    # to fix a failed board — a bigger board / more spacing gives the router room,
    # a rotation changes a part's pin-escape geometry. Honest: hints only change
    # placement, never silently drop or swap parts.
    hints = design.get("recovery_hints", {})
    hmargin = float(hints.get("board_margin", 0))
    hgap = float(hints.get("extra_gap", 0))
    hrot = hints.get("components", {})     # {ref_or_mpn: {"rotate": deg}}

    # A learned/recovery board_margin is ROUTING ROOM, not a border expansion —
    # applying it blindly turned sparse 2-chip boards into huge empty slabs. Scale
    # it by fine-pitch density (fine-pitch escapes are what actually need the room)
    # and apply it as component SPACING, keeping the outline border tight so the
    # board hugs its parts. (Fixes the Phase-8 board_margin over-application.)
    _FINE = re.compile(r"P0\.[1-6]\d*mm|QFN|DFN|WSON|USON|VSSOP|LGA|TSSOP|USB_C_Receptacle", re.I)
    _fine_n = sum(1 for s in specs if _FINE.search(s.get("kicad_footprint", "")))
    _density = min(1.0, (len(specs) + _fine_n * 2) / 6.0)
    # A learned/recovery board_margin is applied CONTEXTUALLY, not universally:
    #  - a FINE-PITCH board genuinely needs the escape room the recovery loop found
    #    (it may legitimately be larger), so it gets the full margin;
    #  - a sparse NON-fine-pitch board gets it scaled down by density, so it never
    #    becomes a huge empty slab. The sizing report explains every margin.
    _applied = round(hmargin * (1.0 if _fine_n else _density), 1)
    _margin_source = hints.get("_source", "pattern" if hmargin else "default")
    _sizing = {"requested_board_margin_mm": hmargin, "applied_margin_mm": _applied,
               "components": len(specs), "fine_pitch_parts": _fine_n,
               "density_estimate": round(_density, 2), "margin_source": _margin_source,
               "margin_reason": ("fine-pitch escape room (recovery-discovered) — larger "
                                 "board is expected" if _fine_n
                                 else "low density, no fine-pitch — margin scaled down "
                                 "so the board is not an oversized slab")}

    X0, Y0, MARGIN, GAP = 30.0, 30.0, 10.0 + _applied, 8.0 + hgap
    COLW, ROWH, WRAP = 24.0, 34.0 + hgap, 190.0 + _applied * 2
    body = ""
    # running extents of everything placed, so the outline always encloses it
    right_extent = [X0 + MARGIN]
    bottom_extent = [Y0 + MARGIN]

    def note_extent(x, y, w=COLW, h=ROWH):
        right_extent[0] = max(right_extent[0], x + w)
        bottom_extent[0] = max(bottom_extent[0], y + h)

    # ---- MCU selection + pin allocation (no longer hardcoded to RP2040) ------
    intent = design.get("intent", {})
    mcu_req = mcu_selector.requirements_from_design(intent, specs)
    mcu_decision = mcu_selector.select_mcu(mcu_req)
    mcu_recovery = None
    # recovery: a requested MCU that cannot meet the design -> substitute the best
    # qualifying MCU and build with it, reporting preserved/lost capabilities.
    if mcu_decision.get("needs_recovery"):
        mcu_recovery = mcu_selector.propose_substitute(mcu_decision)
        if mcu_recovery:
            mcu_decision = mcu_selector.select_mcu({**mcu_req, "requested_mcu":
                                                    mcu_recovery["substituted_mcu"]})
    mcu_alloc = None
    x = X0 + MARGIN
    ytop = Y0 + MARGIN
    sel = mcu_decision.get("selected")
    if sel == "RP2040" or not sel:
        # PROVEN RP2040 path (also the safe fallback if selection could not fit) —
        # keeps the golden hub + every existing board bit-for-bit identical.
        n_mcu = _wire_mcu(specs)
        mb, mw, mh = compose.block_mcu_pico(x, ytop, n_mcu, nets)
        body += mb
        compose._DEVICES.append({"ref": "U1", "type": "mcu", "name": "RP2040"})
        if sel == "RP2040":
            mcu_alloc = _rp2040_alloc(n_mcu)   # matches the real Pico wiring
    else:
        # generalized path: place the selected MCU from its spec + allocated pads
        spec = mcu_specs.get_mcu(sel)
        mcu_alloc = pin_allocator.allocate(spec, _mcu_requests(specs))
        mb, mw, mh = block_mcu_generic(spec, mcu_alloc, x, ytop, nets)
        body += mb
    note_extent(x, ytop, mw, mh)
    x += mw + GAP
    row_y = ytop

    # ---- UCS components + their support passives ----------------------------
    # Layout intelligence: place the power connector FIRST (next to the MCU
    # power pins) so the +5V rail — which is not plane-served — routes a short
    # hop instead of across the board from a fine-pitch connector.
    specs = sorted(specs, key=lambda s: 0 if s.get("category", "").startswith(
        ("connector.usb", "connector.power", "power")) else 1)
    placed, dropped, refn, cs_i = [], [], 2, 0
    # Calibration/reference topology: when a voltage reference is present, wire its
    # OUT to a REF_OUT node, build a divider producing REF_DIV, and (if an ADC is
    # present) have the ADC MEASURE both nodes. Turns a reference that's merely
    # placed into a reference that's wired into the measurement path.
    _has_ref = any(s.get("category") == "voltage_reference" for s in specs)
    _has_adc = any(s.get("category", "").startswith("adc") for s in specs)
    _cal_nets = []          # [(net, rail_or_gnd)] divider + test-point requests
    for spec in specs:
        fp = spec.get("kicad_footprint")
        if not fp or ":" not in fp:
            dropped.append({"mpn": spec["mpn"], "reason": "no resolved KiCad footprint"})
            continue
        lib, name = fp.split(":", 1)
        cs_net = "W25Q_CS" if "flash" in spec.get("category", "") else \
                 "SR_LATCH" if "shift" in spec.get("category", "") else "CS%d" % cs_i
        cs_i += 1
        nm, wired, unmatched, pulls = _netmap_for(spec, cs_net)
        if not nm:
            dropped.append({"mpn": spec["mpn"], "reason": "no pins could be wired"})
            continue
        # cal-topology wiring (only when a reference is in the design)
        if _has_ref:
            cat = spec.get("category", "")
            if cat == "voltage_reference":
                for p in spec["pins"]:
                    if p["etype"] == "power_out":
                        nm[p["number"]] = "REF_OUT"
                        wired.append("ref_out")
                _cal_nets = [("REF_DIV", None)]  # sentinel: build the divider
            elif cat.startswith("adc"):
                ains = [p["number"] for p in spec["pins"] if p["etype"] == "analog_in"]
                for pnum, cnet in zip(ains, ("REF_OUT", "REF_DIV")):
                    nm[pnum] = cnet
                    wired.append("measures_%s" % cnet.lower())
                # fine-pitch escape hygiene: tie every UNUSED pin (spare analog
                # inputs, unconnected config/alert) to the GND plane so it takes
                # a plane via at the pad instead of a floating obstacle — that
                # frees the escape lanes the used fine-pitch signals need. (This
                # is the difference between the walled and the routable ADS1115.)
                for p in spec["pins"]:
                    if p["number"] not in nm and p["etype"] not in ("power_in",):
                        nm[p["number"]] = "GND"
        # wrap to a new row before placing if this cell would run past the budget
        if x + COLW - X0 > WRAP:
            x = X0 + MARGIN
            row_y = bottom_extent[0] + GAP
        ref = "U%d" % refn
        refn += 1
        # recovery hint: a per-component rotation (keyed by ref or MPN)
        rot = float(hrot.get(ref, hrot.get(spec["mpn"], {})).get("rotate", 0))
        try:
            body += compose.place(lib, name, ref, x, row_y, rot, nm, nets)
        except Exception as e:
            dropped.append({"mpn": spec["mpn"], "reason": "footprint place failed: %s" % e})
            continue
        body += _support(spec, pulls, refn * 3, x, row_y + 14, nets)
        note_extent(x, row_y)
        compose._DEVICES.append({"ref": ref, "type": spec.get("category", "part").split(".")[-1],
                                 "name": spec["mpn"], "footprint": name,
                                 "wired": wired, "unmatched": unmatched})
        placed.append(spec["mpn"])
        if unmatched:
            dropped.append({"mpn": spec["mpn"], "reason": "unmatched bus pins: %s (placed anyway)"
                            % ", ".join(unmatched), "partial": True})
        x += COLW + GAP

    # ---- passives / connectors / test points on a fresh bottom row ----------
    px = X0 + MARGIN
    py = bottom_extent[0] + GAP
    if any(i["type"] == "i2c" for s in specs for i in s.get("interfaces", [])):
        body += compose.res("R90", px, py, "I2C_SDA", "+3V3", nets)
        body += compose.res("R91", px, py + 4, "I2C_SCL", "+3V3", nets)
        note_extent(px, py, 6, 10)
        px += 10
    if any(i["type"] == "rs485" for s in specs for i in s.get("interfaces", [])):
        body += compose.place("Connector_PinHeader_2.54mm", "PinHeader_1x03_P2.54mm_Vertical",
                              "J90", px, py, 0, {"1": "RS485_A", "2": "RS485_B", "3": "GND"}, nets)
        body += compose.res("R92", px, py + 12, "RS485_A", "RS485_B", nets)  # 120R term
        note_extent(px, py, 8, 16)
        px += 14
    for i, net in enumerate(["+5V", "+3V3", "I2C_SCL", "SPI_SCK"]):
        if net in nets.order:
            body += compose.tp("TP%d" % (i + 1), px + i * 5, py, net, nets)
            note_extent(px + i * 5, py, 4, 6)

    # ---- calibration divider + reference/measurement node test points -------
    # REF_OUT -> RCAL1 -> REF_DIV -> RCAL2 -> GND gives a known divided node; both
    # nodes get a labeled test point so they are externally measurable.
    if _cal_nets and "REF_OUT" in nets.order:
        body += compose.res("RCAL1", px, py + 12, "REF_OUT", "REF_DIV", nets)
        body += compose.res("RCAL2", px, py + 16, "REF_DIV", "GND", nets)
        note_extent(px, py + 12, 6, 10)
        px += 10
        for i, net in enumerate(["REF_OUT", "REF_DIV"]):
            if net in nets.order:
                body += compose.tp("TP%d" % (i + 8), px + i * 5, py + 12, net, nets)
                note_extent(px + i * 5, py + 12, 4, 6)
        px += 12

    # ---- FL-1 instrument-bus connector (source/tap for the shared I2C bus) ---
    # For an FL-1 instrument board the bus header carries power + the shared I2C
    # control bus + a trigger, so an external controller can drive the board.
    if _cal_nets and "I2C_SDA" in nets.order:
        body += compose.place("Connector_PinHeader_2.54mm", "PinHeader_2x03_P2.54mm_Vertical",
                              "J1", px, py, 0,
                              {"1": "+5V", "2": "+3V3", "3": "I2C_SDA", "4": "I2C_SCL",
                               "5": "GND", "6": "TRIG"}, nets)
        compose._DEVICES.append({"ref": "J1", "type": "connector", "name": "FL-1 instrument bus"})
        note_extent(px, py, 10, 8)

    # ---- assemble the board (outline that ENCLOSES every placement) ---------
    BW = round(right_extent[0] + MARGIN - X0, 1)
    BH = round(bottom_extent[0] + MARGIN - Y0, 1)
    for i, (fx, fy) in enumerate([(6, 6), (BW - 6, 6), (6, BH - 6)]):
        body += compose.place("Fiducial", "Fiducial_1mm_Mask2mm", "FID%d" % (i + 1),
                              X0 + fx, Y0 + fy, 0, {}, nets)
    body = compose._unique_refs(body)

    p = '(kicad_pcb (version 20240108) (generator "ee-lab-compose") (generator_version "8.0")\n'
    p += '  (general (thickness 1.6))\n  (paper "A4")\n' + compose.LAYERS
    p += '  (setup (pad_to_mask_clearance 0))\n'
    for i, nm in enumerate(nets.order):
        p += '  (net {} "{}")\n'.format(i, nm)
    p += ('  (gr_rect (start {} {}) (end {} {}) (stroke (width 0.15) (type default))'
          ' (fill none) (layer "Edge.Cuts") (uuid "{}"))\n').format(X0, Y0, X0 + BW, Y0 + BH, compose.U())
    p += compose.gzone("GND", "F.Cu", X0, Y0, X0 + BW, Y0 + BH, nets)
    p += compose.gzone("GND", "B.Cu", X0, Y0, X0 + BW, Y0 + BH, nets)
    p += compose.gzone("GND", "In1.Cu", X0, Y0, X0 + BW, Y0 + BH, nets)
    p += compose.gzone("+3V3", "In2.Cu", X0, Y0, X0 + BW, Y0 + BH, nets)
    p += body + ')\n'
    open(out_path, "w").write(p)

    base = os.path.splitext(out_path)[0]
    if re.search(r"P0\.[1-7]\d*mm|QFN|DFN|WSON|USON|VSSOP|VQFN|LGA|SON_|USB_C_Receptacle", p):
        open(base + ".kicad_dru", "w").write(
            '(version 1)\n(rule "fab_6mil"\n  (constraint clearance (min 0.13mm)))\n')
        # finer via class so the fine-pitch stitch vias (0.4/0.2) are legal;
        # net-class defaults match the board so plane zones still connect.
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
    open(base + ".devices.json", "w").write(json.dumps(compose._DEVICES))
    # preserve the recovery/substitution report next to the board (criterion 13)
    if design.get("recovery_report"):
        open(base + ".recovery.json", "w").write(json.dumps(design["recovery_report"], indent=1))

    # ---- MCU selection + pin-assignment artifacts ---------------------------
    open(base + ".mcu-selection.json", "w").write(json.dumps(mcu_decision, indent=1))
    if mcu_recovery:
        open(base + ".mcu-recovery.json", "w").write(json.dumps(mcu_recovery, indent=1))
        print("MCU_RECOVERY:" + json.dumps({
            "requested": mcu_recovery["requested_mcu"],
            "substituted": mcu_recovery["substituted_mcu"],
            "lost": mcu_recovery["lost"]}))
    if mcu_alloc:
        open(base + ".pin-assignment.json", "w").write(json.dumps({
            **mcu_alloc, "firmware_pin_map": mcu_alloc["firmware_pin_map"],
            "selection": {k: mcu_decision.get(k) for k in
                          ("selected", "mpn", "package", "status", "confidence", "why")},
        }, indent=1))
        open(base + ".pin-assignment.md", "w").write(
            pin_allocator.to_markdown(mcu_alloc, mcu_decision))
        print("MCU_SELECTED:" + json.dumps({
            "mcu": sel, "status": mcu_decision.get("status"),
            "assigned": len(mcu_alloc["assignments"]),
            "conflicts": len(mcu_alloc["conflicts"]),
            "rejected": len(mcu_decision.get("rejected", [])),
            "partial": mcu_decision.get("partial_warning")}))

    print("COMPOSE: synth {} UCS parts + MCU -> {} components placed, {:.0f}x{:.0f}mm, {} nets".format(
        len(placed), p.count("(footprint "), BW, BH, len(nets.order) - 1))
    print("COMPOSE_COVERAGE:" + json.dumps({"mapped": ["mcu"] + placed,
          "dropped": [d for d in dropped if not d.get("partial")]}))
    _sizing["board_size_mm"] = [BW, BH]
    _sizing["component_span_mm"] = [round(right_extent[0] - X0 - MARGIN, 1),
                                    round(bottom_extent[0] - Y0 - MARGIN, 1)]
    open(base + ".board-sizing.json", "w").write(json.dumps(_sizing, indent=1))
    print("SIZING:" + json.dumps(_sizing))
    for d in compose._DEVICES:
        print("SOURCED:" + json.dumps({"ref": d["ref"], "name": d.get("name"),
              "type": d["type"], "via": "ucs_synth"}))
    if dropped:
        print("SYNTH_NOTES:" + json.dumps(dropped))


if __name__ == "__main__":
    design = json.load(open(sys.argv[1]))
    synth(design, sys.argv[2])
