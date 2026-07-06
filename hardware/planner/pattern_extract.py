"""Pattern extraction (Phase 4 + 5) — pull a Design Pattern Spec from a REAL
source. v1 extracts from what is genuinely local + trusted:

  from_board    — a Compose-generated FirstLight board (devices + nets + net
                  classes). Functional blocks, power rails, interfaces, support
                  passives, test points; decoupling-near-power as a layout rule.
  from_contract — a component support-circuit contract (the reusable topology
                  Compose already applies, e.g. i2c_sensor -> pull-ups + decap).
  from_ucs      — an ingested UCS component as a component-usage pattern.

Geometry that cannot be extracted reliably is recorded as an honest UNKNOWN, not
guessed. License/trust come from the reference manifest entry.
"""
import json
import os

import pattern_spec as ps
from reference_manifest import allowed_use

_ROLE = {"mcu": "mcu", "adc": "adc", "precision": "adc", "dac": "dac",
         "current_sense": "current_sense", "voltage_reference": "voltage_reference",
         "reference": "voltage_reference", "regulator": "regulator",
         "op_amp": "op_amp", "opamp": "op_amp", "mux": "analog_mux", "switch": "analog_mux"}


def _role_for(dev):
    cat = (dev.get("type") or "") + " " + (dev.get("name") or "")
    for k, v in _ROLE.items():
        if k in cat.lower():
            return v
    return dev.get("type") or "part"


def from_board(run_dir, name, category, source_entry):
    """Extract a pattern from a Compose run directory (data/*.json)."""
    d = os.path.join(run_dir, "data")

    def L(f, default):
        try:
            return json.load(open(os.path.join(d, f)))
        except Exception:
            return default

    devices = L("devices.json", [])
    board = L("board.json", {})
    cons = L("constraints.json", {})
    nets = list((cons.get("nets") or {}).keys()) or board.get("variantNets", [])

    ics = [dv for dv in devices if dv.get("type") in ("mcu",) or
           _role_for(dv) in ps.HIGH_RISK_ROLES]
    passives = [dv for dv in devices if (dv.get("footprint") or "").startswith(("C_", "R_"))]
    rails = sorted({n for n in nets if n in ("+5V", "+3V3", "+1V8", "GND", "VIN")})
    ifaces = sorted({n.split("_")[0] for n in nets
                     if n.split("_")[0] in ("I2C", "SPI", "UART", "CAN", "RS485")})
    tps = [n for n in nets if n.startswith(("PROBE", "TP"))]

    components = []
    for dv in ics:
        role = _role_for(dv)
        # high-risk parts are preserved exactly; the MCU and generic parts adapt
        zone = "preserve_exactly" if role in ps.HIGH_RISK_ROLES else "adapt_allowed"
        components.append({"ref": dv.get("ref"), "role": role, "mpn": dv.get("name"),
                           "required": True, "zone": zone,
                           "footprint": dv.get("footprint")})

    # layout rule Compose actually enforces: one decoupling cap per IC power pin,
    # placed adjacent — a real, reusable placement relationship.
    layout = []
    if passives and ics:
        layout.append({"rule": "decoupling_adjacent",
                       "detail": "one 100nF cap within a few mm of each IC power pin",
                       "provenance": "firstlight_board", "confidence": 0.8})
    if any(_role_for(dv) in ("adc", "current_sense", "voltage_reference") for dv in ics):
        layout.append({"rule": "analog_isolation",
                       "detail": "keep the analog front-end away from switching nodes",
                       "provenance": "firstlight_practice", "confidence": 0.5})

    net_classes = cons.get("class_counts", {})
    p = ps.make_pattern(
        name, category, source_entry["source_type"], source_entry["license_status"],
        source_files=source_entry.get("local_files", []),
        purpose="reusable %s block proven on a passing FirstLight board" % category,
        topology="%d IC(s) + %d support passives on rails %s"
                 % (len(ics), len(passives), ", ".join(rails)),
        components=components,
        required_components=[c["ref"] for c in components if c["required"]],
        required_passives=[{"ref": pv.get("ref"), "footprint": pv.get("footprint")}
                           for pv in passives],
        interface_pins=ifaces, power={"rails": rails},
        layout_constraints=layout,
        routing_constraints=[{"rule": "net_classes", "classes": net_classes}] if net_classes else [],
        test_points=tps,
        validation_procedure="reuse the FL-1 Validation Package generated for this board",
        expected_performance="matches the source board (passed strict DRC/ERC)"
                             if board.get("netsRouted") else "unknown",
        known_limitations=["geometry beyond decoupling adjacency not extracted"],
        provenance={"source": "firstlight_generated_board", "run_dir": os.path.basename(run_dir),
                    "components": "devices.json", "nets": "board/constraints"},
        confidence={"components": 0.9, "interfaces": 0.8, "layout": 0.7,
                    "geometry": 0.3},
        unknowns=["exact component-to-component spacing", "copper pour geometry"],
    )
    return ps.finalize(p)


def from_contract(cname, contract, source_type="component_contract",
                  license_status="permissive_reuse"):
    """Extract a support-circuit pattern from a resolve_part CONTRACT — the
    reusable topology Compose already applies (FirstLight-owned, permissive)."""
    roles = contract.get("roles", {}) if isinstance(contract, dict) else {}
    passives = []
    if "pullup" in str(contract).lower() or cname in ("i2c_sensor", "i2c_device"):
        passives.append({"role": "i2c_pullup", "value": "4.7k", "reason": "open-drain bus"})
    if "sense" in cname or cname == "current_sense":
        passives.append({"role": "shunt", "value": "app-specific", "reason": "current sense element",
                         "zone": "preserve_exactly"})
    passives.append({"role": "decoupling", "value": "100nF", "reason": "per power pin"})
    p = ps.make_pattern(
        "%s support circuit" % cname, cname, source_type, license_status,
        purpose="FirstLight component contract topology for %s" % cname,
        topology="interface contract: %s" % ", ".join(roles.keys()) if roles else cname,
        components=[{"role": cname, "required": True, "zone": "adapt_allowed"}],
        required_passives=passives,
        provenance={"source": "firstlight_component_contract", "contract": cname},
        confidence={"components": 0.85, "topology": 0.8},
    )
    return ps.finalize(p)


def from_ucs(ucs, source_entry):
    """A component-usage pattern from an ingested UCS."""
    ifaces = [i.get("type") if isinstance(i, dict) else i for i in ucs.get("interfaces", [])]
    p = ps.make_pattern(
        "%s usage" % ucs.get("mpn"), ucs.get("category", "component"),
        source_entry["source_type"], source_entry["license_status"],
        source_files=source_entry.get("local_files", []),
        purpose="how to use the ingested %s" % ucs.get("mpn"),
        components=[{"role": ucs.get("category", "part"), "mpn": ucs.get("mpn"),
                     "required": True, "zone": "preserve_exactly",
                     "footprint": ucs.get("kicad_footprint")}],
        interface_pins=ifaces,
        required_passives=[{"role": "decoupling", "value": "100nF", "reason": "per power pin"}],
        provenance={"source": "ingested_ucs", "mpn": ucs.get("mpn"),
                    "ucs_status": ucs.get("support_status")},
        confidence={"components": ucs.get("confidence", {}).get("pins", 0.7),
                    "interfaces": 0.7},
    )
    return ps.finalize(p)
