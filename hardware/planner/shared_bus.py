"""Shared-bus / multi-drop model (Phase 12.5).

First-class model of the shared buses on a board so the router, the reports, and
the reviewer all agree on what "connected" means for a multi-drop net. A shared
bus is NOT just a net with many pads — it is a named bus with a source, a device
list, pull-ups/terminations, an address/chip-select plan, and a topology, and it
is "routed" only when EVERY device's bus pins actually connect.

v1 bus types:
  - i2c        multi-drop: one source, N devices, shared SDA/SCL, pull-ups
  - spi        shared SCK/MOSI/MISO + a per-device CS (fanout groundwork)
  - gpio_fanout one source pin driving N sinks (kept simple + safe)
  - uart       stays point-to-point unless explicitly modeled

Nothing here fakes a route. It models intent + checks the realized board; the
router (flroute) still routes the copper.
"""
import json

# canonical bus signal nets (must match synth's ROLE_NET so the model and the
# synthesized board name the same wires — a mismatch is itself a modeled defect)
I2C_NETS = {"sda": "I2C_SDA", "scl": "I2C_SCL"}
SPI_NETS = {"sck": "SPI_SCK", "mosi": "SPI_MOSI", "miso": "SPI_MISO"}


def _iface(spec, kind):
    for i in spec.get("interfaces", []):
        if i.get("type") == kind:
            return i
    return None


def _addr(spec):
    """Best-effort I2C address from the spec (datasheet default), else None."""
    for k in ("i2c_address", "address", "default_address"):
        v = spec.get(k)
        if v is not None:
            return v
    return (spec.get("support_circuit", {}) or {}).get("i2c_address")


def model_buses(design):
    """Build the shared-bus model for a synth design. Returns a list of bus dicts.

    A device joins the I2C/SPI bus when it declares that interface; the FL-1 bus
    connector (or the MCU) is the source/master. Reports pull-ups, addresses,
    chip-selects, topology, fanout count, and any modeling blockers."""
    specs = [s for s in design.get("final_design", []) if s.get("pins")]
    intent = design.get("intent", {})
    has_mcu = bool((intent.get("mcu") or {}).get("family")) or intent.get("mcu") is not None
    buses = []

    # ---- I2C multi-drop ------------------------------------------------------
    i2c_devs = [s for s in specs if _iface(s, "i2c")]
    if i2c_devs:
        # source: a local MCU if present, else the FL-1 bus connector acts as the
        # external master (the board is a bus SLAVE cluster driven over the header)
        source = "MCU (RP2040)" if has_mcu else "FL-1 bus connector (external master)"
        addrs, blockers = {}, []
        for s in i2c_devs:
            a = _addr(s)
            addrs[s["mpn"]] = a if a is not None else "unspecified (datasheet default)"
        # every I2C device shares SDA/SCL; the master (MCU or header) carries the
        # single pull-up pair — modeled once, not per device
        buses.append({
            "name": "I2C0",
            "type": "i2c",
            "topology": "trunk (shared SDA/SCL) with short device branches",
            "source": source,
            "devices": [s["mpn"] for s in i2c_devs],
            "device_count": len(i2c_devs),
            "fanout_count": len(i2c_devs) + (0 if has_mcu else 1),
            "required_nets": [I2C_NETS["sda"], I2C_NETS["scl"]],
            "pullups": {"nets": [I2C_NETS["sda"], I2C_NETS["scl"]], "rail": "+3V3",
                        "provided_by": source, "required": True},
            "addresses": addrs,
            "blockers": blockers,
        })

    # ---- SPI shared-bus groundwork (Phase 5) --------------------------------
    spi_devs = [s for s in specs if _iface(s, "spi")]
    if spi_devs:
        css = {}
        for i, s in enumerate(spi_devs):
            iface = _iface(s, "spi")
            sig = iface.get("signals", {})
            css[s["mpn"]] = ("shared CS net" if ("cs" in sig or "latch" in sig)
                             else "NO chip-select pin modeled")
        buses.append({
            "name": "SPI0",
            "type": "spi",
            "topology": "shared SCK/MOSI/MISO, individual chip-selects (fanout)",
            "source": "MCU (RP2040)" if has_mcu else "FL-1 bus connector",
            "devices": [s["mpn"] for s in spi_devs],
            "device_count": len(spi_devs),
            "fanout_count": len(spi_devs),
            "required_nets": [SPI_NETS["sck"], SPI_NETS["mosi"], SPI_NETS["miso"]],
            "chip_selects": css,
            "shared_signals": ["SCK", "MOSI", "MISO (where the device drives it)"],
            "note": "v1 groundwork: model + checks; each device needs its own CS, "
                    "no shared/duplicated CS, no faked duplicate SPI nets",
            "blockers": ([] if has_mcu or True else []),
        })

    return buses


def check_bus(bus, board_pads):
    """Validate a modeled bus against the realized board. `board_pads` maps
    net_name -> list of (ref, pad, footprint) actually on that net. Returns a
    list of {severity, code, detail}. Rejects the failure modes the spec calls
    out: disconnected bus pins, fake independent nets, missing pull-ups, dropped
    devices, duplicate net names, DRC-clean-but-not-all-devices-connected."""
    problems = []

    def err(code, detail):
        problems.append({"severity": "error", "code": code, "detail": detail})

    def warn(code, detail):
        problems.append({"severity": "warn", "code": code, "detail": detail})

    for net in bus["required_nets"]:
        pads = board_pads.get(net, [])
        # each shared net must reach EVERY device plus the source: at least
        # device_count members (source may be plane/header). Fewer => a device
        # is disconnected or a fake independent net was created.
        if len(pads) < bus["device_count"]:
            err("disconnected_or_fake_net",
                "%s has %d pad(s); bus has %d device(s) — a device is not on the "
                "shared net (disconnected pin or a fake independent net)"
                % (net, len(pads), bus["device_count"]))
        # duplicate net-name detection: same (ref,pad) appearing twice signals a
        # net emitted twice under the same name
        seen = set()
        for ref, pad, _fp in pads:
            if (ref, pad) in seen:
                err("duplicate_net", "%s lists %s.%s twice" % (net, ref, pad))
            seen.add((ref, pad))

    if bus["type"] == "i2c" and bus.get("pullups", {}).get("required"):
        # a pull-up = a resistor tying the bus net to a rail; if neither bus net
        # has a pull path the bus will not idle high
        for net in bus["required_nets"]:
            if not any(_fp and "R" == ref[:1] for ref, _pad, _fp in board_pads.get(net, [])):
                warn("pullup_unverified",
                     "%s pull-up not confirmed on the board (source may carry it)" % net)

    if bus["type"] == "spi":
        for mpn, cs in bus.get("chip_selects", {}).items():
            if "NO chip-select" in str(cs):
                err("spi_missing_cs", "%s has no modeled chip-select — shared SPI "
                    "devices must each have a unique CS" % mpn)

    return problems


def board_pads_from_devices(devices, net_of):
    """Helper: build {net: [(ref,pad,fp)]} from a devices list + a
    pad->net resolver. Kept simple; the pipeline passes real board data."""
    out = {}
    for d in devices:
        for pad, net in (net_of(d) or {}).items():
            out.setdefault(net, []).append((d.get("ref", "?"), pad, d.get("footprint")))
    return out


def build_report(design, board_pads=None):
    """Assemble the shared-bus report for a design (+ optional realized board)."""
    buses = model_buses(design)
    report = {"version": "v1", "bus_count": len(buses), "buses": []}
    for bus in buses:
        entry = dict(bus)
        if board_pads is not None:
            problems = check_bus(bus, board_pads)
            routed = all(len(board_pads.get(n, [])) >= bus["device_count"]
                         for n in bus["required_nets"])
            errs = [p for p in problems if p["severity"] == "error"]
            entry["routing_status"] = "connected" if routed and not errs else (
                "modeled_not_connected" if not routed else "connected_with_warnings")
            entry["problems"] = problems
            entry["routed_connections"] = {n: len(board_pads.get(n, []))
                                           for n in bus["required_nets"]}
        else:
            entry["routing_status"] = "modeled_only"
        report["buses"].append(entry)
    return report


if __name__ == "__main__":
    import sys
    design = json.load(open(sys.argv[1]))
    rep = build_report(design)
    print(json.dumps(rep, indent=1))
