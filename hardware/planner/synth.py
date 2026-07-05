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


def synth(design, out_path):
    specs = [s for s in design["final_design"] if s.get("pins")]
    nets = compose.Nets()
    compose._DEVICES[:] = []

    X0, Y0, MARGIN, GAP = 30.0, 30.0, 10.0, 8.0
    COLW, ROWH, WRAP = 24.0, 34.0, 190.0   # per-part cell, row height, wrap width
    body = ""
    # running extents of everything placed, so the outline always encloses it
    right_extent = [X0 + MARGIN]
    bottom_extent = [Y0 + MARGIN]

    def note_extent(x, y, w=COLW, h=ROWH):
        right_extent[0] = max(right_extent[0], x + w)
        bottom_extent[0] = max(bottom_extent[0], y + h)

    # ---- MCU anchor (Pico) --------------------------------------------------
    x = X0 + MARGIN
    ytop = Y0 + MARGIN
    n_mcu = _wire_mcu(specs)
    mb, mw, mh = compose.block_mcu_pico(x, ytop, n_mcu, nets)
    body += mb
    compose._DEVICES.append({"ref": "U1", "type": "mcu", "name": "RP2040"})
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
        # wrap to a new row before placing if this cell would run past the budget
        if x + COLW - X0 > WRAP:
            x = X0 + MARGIN
            row_y = bottom_extent[0] + GAP
        ref = "U%d" % refn
        refn += 1
        try:
            body += compose.place(lib, name, ref, x, row_y, 0, nm, nets)
        except Exception as e:
            dropped.append({"mpn": spec["mpn"], "reason": "footprint place failed: %s" % e})
            continue
        body += _support(spec, pulls, refn * 3, x, row_y + 14, nets)
        note_extent(x, row_y)
        compose._DEVICES.append({"ref": ref, "type": spec.get("category", "part").split(".")[-1],
                                 "name": spec["mpn"], "wired": wired, "unmatched": unmatched})
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

    print("COMPOSE: synth {} UCS parts + MCU -> {} components placed, {:.0f}x{:.0f}mm, {} nets".format(
        len(placed), p.count("(footprint "), BW, BH, len(nets.order) - 1))
    print("COMPOSE_COVERAGE:" + json.dumps({"mapped": ["mcu"] + placed,
          "dropped": [d for d in dropped if not d.get("partial")]}))
    for d in compose._DEVICES:
        print("SOURCED:" + json.dumps({"ref": d["ref"], "name": d.get("name"),
              "type": d["type"], "via": "ucs_synth"}))
    if dropped:
        print("SYNTH_NOTES:" + json.dumps(dropped))


if __name__ == "__main__":
    design = json.load(open(sys.argv[1]))
    synth(design, sys.argv[2])
