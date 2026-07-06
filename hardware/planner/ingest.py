"""Component Ingestion Engine — normalise any source into a Universal Component
Spec (UCS).

Real, implemented sources:
  - from_kicad_symbol : a KiCad library symbol (+ footprint resolution). The
                        workhorse: pins come straight from the library (authoritative),
                        interface + support circuit are inferred and marked as such.
  - from_spec         : an existing UCS dict (re-validated).
  - from_block        : an existing Compose block (wrapped as supported).
  - from_pin_table    : a manual user-provided pin table.

Honestly stubbed (NOT faked) — these return a PARTIAL spec with low confidence,
provenance recorded, and clear missing_fields, so nothing pretends a datasheet
was really parsed:
  - from_datasheet    : PDF/URL AI extraction (Phase 4) — not implemented.
  - from_mpn          : MPN -> distributor lookup — not implemented.
  - from_distributor  : DigiKey/Mouser/LCSC result — not implemented.

Every field carries provenance + confidence so the resolver/reviewer can see
exactly what is trusted and what is inferred or assumed.
"""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "blocks"))
import resolve_part  # noqa: E402  KiCad symbol/footprint parsing + normalisation

from component_spec import UCS_VERSION, finalize  # noqa: E402
import ingest_datasheet  # noqa: E402  real pdftotext datasheet extraction

_FP_DIR = resolve_part.FP_DIR


def _footprint_pad_names(lib_fp, name):
    """Pad names declared in a KiCad footprint. Read directly (the shared helper
    mis-parses some libraries); empty set means 'could not read' -> don't
    penalise, rather than falsely flag every pin as pad-less."""
    path = os.path.join(_FP_DIR, lib_fp + ".pretty", name + ".kicad_mod")
    try:
        text = open(path).read()
    except OSError:
        return set()
    return set(re.findall(r'\(pad\s+"([^"]+)"', text))


# ---- pin electrical-type inference from the pin name ------------------------
def _etype(name):
    n = resolve_part._norm(name)
    if n in ("GND", "VSS", "AGND", "DGND", "VSSA", "VSSD", "EP", "PAD", "PGND"):
        return "ground"
    if n in ("VCC", "VDD", "VBAT", "VIN", "VS", "VDDIO", "VLOGIC", "AVDD", "DVDD",
             "AVCC", "DVCC", "VDDA", "VDDD", "VBUS", "V+", "VCCIO", "5VOUT",
             "VM", "VMOT", "VMOTOR", "VBB", "VPWR", "VINT", "VP", "VDDA1", "VREG"):
        return "power_in"
    if n in ("VOUT", "VO", "3V3", "1V8"):
        return "power_out"
    if n in ("NC",):
        return "no_connect"
    if any(k in n for k in ("SCL", "SDA", "SCK", "MOSI", "MISO", "TX", "RX",
                            "CANH", "CANL", "DP", "DM", "IO", "GPIO", "GP")):
        return "bidirectional"
    if n.startswith(("A", "AIN", "AN")) and n[-1:].isdigit():
        return "analog_in"
    return "unspecified"


# ---- interface inference (Phase 7) ------------------------------------------
def _has(names, *aliases):
    norm = {resolve_part._norm(x) for x in names}
    tokset = set()
    for x in names:
        tokset |= resolve_part._pin_tokens(x)
    want = {resolve_part._norm(a) for a in aliases}
    return bool((norm | tokset) & want)


def infer_interfaces(pin_names, category=""):
    """Infer the electrical interfaces a part speaks from its pin names. Returns
    a list of interface dicts. Crucially, an SPI part with a data-in but NO
    data-out is reported as write-only (shift registers, DACs, LED drivers)."""
    ifaces = []
    n = list(pin_names)
    if _has(n, "SCL", "SCLK_I2C") and _has(n, "SDA"):
        ifaces.append({"type": "i2c", "signals": {"scl": "SCL", "sda": "SDA"}})
    # SPI clock; data-in (to the device); data-out (from the device). QH'/cascade
    # pins are NOT read-back — a shift register with SER+SRCLK is WRITE-ONLY.
    has_sck = _has(n, "SCK", "SCLK", "SRCLK", "SPC", "CLK")
    has_mosi = _has(n, "MOSI", "SDI", "SI", "DIN", "SER", "DI")
    has_miso = _has(n, "MISO", "SDO", "SO", "DOUT", "DO")
    if has_sck and (has_mosi or has_miso):
        if has_mosi and not has_miso:
            ifaces.append({"type": "spi_write_only",
                           "signals": {"sck": "SCK", "mosi": "SER/DI"}})
        else:
            ifaces.append({"type": "spi",
                           "signals": {"sck": "SCK", "mosi": "SDI/DI", "miso": "SDO/DO"}})
    if _has(n, "CANH") and _has(n, "CANL"):
        ifaces.append({"type": "can", "signals": {"canh": "CANH", "canl": "CANL"}})
    if _has(n, "A") and _has(n, "B") and _has(n, "RO", "DE", "RE"):
        ifaces.append({"type": "rs485", "signals": {"a": "A", "b": "B",
                       "ro": "RO", "di": "DI", "de": "DE", "re": "RE"}})
    elif _has(n, "TX", "TXD") and _has(n, "RX", "RXD"):
        ifaces.append({"type": "uart", "signals": {"tx": "TX", "rx": "RX"}})
    if _has(n, "DP", "D+") and _has(n, "DM", "D-"):
        ifaces.append({"type": "usb", "signals": {"dp": "D+", "dm": "D-"}})
    if _has(n, "STEP") and _has(n, "DIR"):
        ifaces.append({"type": "motor_output", "signals": {"step": "STEP", "dir": "DIR"}})
    elif _has(n, "AOUT1", "BOUT1", "AOUT2", "OUT1", "OUTA", "OA1", "M1A"):
        # H-bridge / motor driver outputs (DRV8833 class)
        ifaces.append({"type": "motor_output", "signals": {}})
    # a part with only power+ground+passive pins is a power/analog device
    if not ifaces:
        if any(_etype(x) == "power_out" for x in n):
            ifaces.append({"type": "power_out", "signals": {}})
        elif "regulator" in category.lower() or "charger" in category.lower():
            ifaces.append({"type": "power_out", "signals": {}})
        else:
            ifaces.append({"type": "gpio", "signals": {}})
    return ifaces


# ---- KiCad-symbol ingestion (the real workhorse) ----------------------------
def from_kicad_symbol(symbol_query, mpn=None, category="", manufacturer="",
                      overrides=None):
    """Ingest a KiCad library symbol into a UCS. Pins are authoritative (from the
    library); interface, support circuit, and electrical limits are inferred or
    left for overrides, each marked with its provenance + confidence."""
    info = resolve_part.symbol_info(symbol_query)
    if not info:
        return _stub(mpn or symbol_query, category,
                     "no KiCad symbol found for '%s'" % symbol_query,
                     source="kicad_library")
    sym_name = info["name"]
    # find which library file holds it (symbol_info returns just the name)
    f, _n, _t = resolve_part._find_symbol_file(symbol_query)
    lib = f[:-len(".kicad_sym")] if f else None
    kicad_symbol = "%s:%s" % (lib, sym_name) if lib else None

    pins = [{"number": num, "name": nm, "etype": _etype(nm)}
            for num, nm in info["pins"]]
    pin_names = [nm for _num, nm in info["pins"]]
    power_pins = [p["number"] for p in pins if p["etype"] == "power_in"]
    gnd_pins = [p["number"] for p in pins if p["etype"] == "ground"]

    # 3-terminal reference/regulator (IN/OUT/GND): the bare "IN"/"OUT" pins don't
    # match the generic power aliases, so reclassify them from context — IN is the
    # supply, OUT is the reference/regulated output.
    if not power_pins and gnd_pins:
        norm = {resolve_part._norm(p["name"]): p for p in pins}
        supply = norm.get("IN") or norm.get("VIN") or norm.get("V+") or norm.get("IN+")
        out = norm.get("OUT") or norm.get("VOUT") or norm.get("OUT+")
        if supply and out:
            supply["etype"] = "power_in"
            out["etype"] = "power_out"
            power_pins = [supply["number"]]

    # pass the symbol pin count so the footprint pad count MUST match — a 5-pin
    # part never lands on a 3-pad SOT-23 (the bug that rejected the EEPROM).
    lib_fp, fp = resolve_part.pick_footprint(info["fp_filters"], npins=len(info["pins"]))
    kicad_fp = "%s:%s" % (lib_fp, fp) if fp else None

    # Phase 5 symbol<->footprint validation: the footprint MUST have a pad for
    # every symbol pin number, or some pins would silently never get a net.
    # A mismatch downgrades footprint confidence and is recorded, never hidden.
    fp_pad_ok = True
    fp_confidence = 0.9 if fp else 0.0
    missing_pads = []
    if fp:
        fp_pads = _footprint_pad_names(lib_fp, fp)
        if fp_pads:  # only validate when the pads were actually readable
            # exclude the exposed/thermal pad, which is often un-numbered on the
            # symbol; validate the real signal pins have a land.
            pin_nums = {num for num, nm in info["pins"]
                        if resolve_part._norm(nm) not in ("EP", "PAD", "NC")}
            missing_pads = [n for n in pin_nums if n not in fp_pads]
            if missing_pads:
                fp_pad_ok = False
                fp_confidence = 0.5  # partial: pins without a pad on the chosen land

    ifaces = infer_interfaces(pin_names, category)

    # generic support circuit: one decoupling cap per power pin (always safe).
    decoupling = [{"value": "100nF", "from": "VCC", "to": "GND",
                   "note": "per power pin"} for _ in power_pins]

    spec = {
        "ucs_version": UCS_VERSION,
        "mpn": mpn or sym_name,
        "manufacturer": manufacturer,
        "aliases": [sym_name] if mpn and sym_name != mpn else [],
        "category": category or "uncategorized",
        "description": "",
        "package": fp.split("_")[0] if fp else "",
        "kicad_symbol": kicad_symbol,
        "kicad_footprint": kicad_fp,
        "pins": pins,
        "power": {"pins": {"power": power_pins, "ground": gnd_pins},
                  "vcc_min": None, "vcc_max": None, "vcc_typ": None,
                  "i_typ_ma": None, "i_max_ma": None},
        "abs_max": {}, "recommended": {},
        "interfaces": ifaces,
        "support_circuit": {"decoupling": decoupling, "pullups": [], "pulldowns": [],
                            "crystals": [], "reset_config": [], "other_passives": []},
        "programming": {},
        "reference_circuit": None,
        "constraints": {"layout": [], "routing": [], "thermal": [], "rf": []},
        "firmware": {}, "fl1_validation": {},
        "sourcing": {},
        "provenance": {
            "mpn": "user" if mpn else "kicad_library",
            "pins": "kicad_library",
            "kicad_symbol": "kicad_library",
            "kicad_footprint": "kicad_library",
            "power.pins.power": "ai_inference",
            "power.pins.ground": "ai_inference",
            "interfaces": "ai_inference",
            "support_circuit.decoupling": "default_assumption",
        },
        "confidence": {
            "pins": 1.0, "kicad_symbol": 1.0,
            "kicad_footprint": fp_confidence,
            "power.pins.power": 0.9 if power_pins else 0.3,
            "power.pins.ground": 0.9 if gnd_pins else 0.3,
            "interfaces": 0.8 if ifaces else 0.4,
        },
        "missing_fields": [],
        "unsupported_fields": [],
    }
    if not fp:
        spec["missing_fields"].append("kicad_footprint")
    elif not fp_pad_ok:
        spec["unsupported_fields"].append(
            "kicad_footprint: pads missing for pins %s" % missing_pads)
    if not power_pins:
        spec["missing_fields"].append("power.pins.power")

    if overrides:
        _deep_merge(spec, overrides)
    return finalize(spec)


def _deep_merge(base, over):
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _deep_merge(base[k], v)
        else:
            base[k] = v
    return base


def from_spec(spec):
    """Re-validate an existing UCS dict."""
    return finalize(dict(spec))


def from_block(block_name, interfaces=None, category="block"):
    """Wrap an existing Compose block as a UCS. Blocks are already known-good
    (they place + route today), so this is a supported spec with block provenance
    — even though it has no pin-level detail here (the block owns that)."""
    spec = {
        "ucs_version": UCS_VERSION, "mpn": block_name, "manufacturer": "",
        "category": category, "description": "Compose block",
        "kicad_symbol": "compose:block/%s" % block_name,
        "kicad_footprint": "compose:block/%s" % block_name,
        "pins": [{"number": "block", "name": block_name, "etype": "unspecified"}],
        "power": {"pins": {"power": ["block"], "ground": ["block"]}},
        "interfaces": interfaces or [{"type": "gpio", "signals": {}}],
        "provenance": {"mpn": "compose_block", "pins": "compose_block",
                       "kicad_symbol": "compose_block", "kicad_footprint": "compose_block",
                       "power.pins.power": "compose_block", "power.pins.ground": "compose_block",
                       "interfaces": "compose_block"},
        "confidence": {"pins": 1.0, "kicad_symbol": 1.0, "kicad_footprint": 1.0,
                       "power.pins.power": 1.0, "power.pins.ground": 1.0, "interfaces": 1.0},
        "missing_fields": [], "unsupported_fields": [],
        "_is_block": True,
    }
    return finalize(spec)


def from_pin_table(mpn, rows, kicad_symbol=None, kicad_footprint=None,
                   category="", manufacturer=""):
    """Ingest a manual pin table: rows = [(number, name, etype?), ...]."""
    pins = []
    for r in rows:
        num, name = str(r[0]), r[1]
        et = r[2] if len(r) > 2 else _etype(name)
        pins.append({"number": num, "name": name, "etype": et})
    power_pins = [p["number"] for p in pins if p["etype"] == "power_in"]
    gnd_pins = [p["number"] for p in pins if p["etype"] == "ground"]
    spec = {
        "ucs_version": UCS_VERSION, "mpn": mpn, "manufacturer": manufacturer,
        "category": category or "uncategorized",
        "kicad_symbol": kicad_symbol, "kicad_footprint": kicad_footprint,
        "pins": pins,
        "power": {"pins": {"power": power_pins, "ground": gnd_pins}},
        "interfaces": infer_interfaces([p["name"] for p in pins], category),
        "provenance": {"mpn": "user", "pins": "user",
                       "kicad_symbol": "user" if kicad_symbol else "default_assumption",
                       "kicad_footprint": "user" if kicad_footprint else "default_assumption",
                       "power.pins.power": "user", "power.pins.ground": "user",
                       "interfaces": "ai_inference"},
        "confidence": {"pins": 1.0,
                       "kicad_symbol": 1.0 if kicad_symbol else 0.0,
                       "kicad_footprint": 1.0 if kicad_footprint else 0.0,
                       "power.pins.power": 1.0, "power.pins.ground": 1.0,
                       "interfaces": 0.7},
        "missing_fields": [f for f, v in (("kicad_symbol", kicad_symbol),
                           ("kicad_footprint", kicad_footprint)) if not v],
        "unsupported_fields": [],
    }
    return finalize(spec)


# ---- honestly-stubbed sources (not implemented — never faked) ---------------
def _stub(mpn, category, reason, source="ai_inference"):
    """A partial, low-confidence placeholder for a source that is not yet
    implemented. It is HONEST: no pins, low confidence, clear missing_fields,
    so the resolver treats it as unsupported/partial rather than trusting it."""
    return finalize({
        "ucs_version": UCS_VERSION, "mpn": mpn, "manufacturer": "",
        "category": category or "uncategorized",
        "description": "STUB: " + reason,
        "kicad_symbol": None, "kicad_footprint": None,
        "pins": [], "power": {"pins": {"power": [], "ground": []}},
        "interfaces": [],
        "provenance": {"mpn": source},
        "confidence": {"mpn": 0.3},
        "missing_fields": ["pins", "kicad_symbol", "kicad_footprint", "interfaces"],
        "unsupported_fields": [],
        "_stub_reason": reason,
    })


def from_datasheet(path_or_url, mpn="", category=""):
    """Datasheet-only ingestion. pdftotext extracts a few fields (voltage,
    package, decoupling) but NEVER a full pin table — that needs a KiCad symbol or
    a manual pin table, so this returns an honest stub enriched with whatever the
    datasheet yielded. The pin table is still marked missing."""
    ds = ingest_datasheet.extract(path_or_url)
    spec = _stub(mpn or "unknown", category,
                 "datasheet alone cannot yield a reliable pin table — provide a "
                 "KiCad symbol or manual pin table; datasheet fields attached below",
                 source="datasheet")
    _apply_datasheet(spec, ds)
    return spec


# ---- Phase 4: symbol/footprint validation -----------------------------------
def validate_component(spec):
    """Structural + assembly validation of a candidate UCS. Returns
    {errors, warnings, ok}. Errors -> unsupported; warnings -> needs_review."""
    errors, warnings = [], []
    pins = spec.get("pins", [])
    if not pins:
        errors.append("no pins (symbol/pin-table missing)")
    fp = spec.get("kicad_footprint")
    if fp and ":" in fp:
        lib, name = fp.split(":", 1)
        pads = _footprint_pad_names(lib, name)
        if pads:
            signal = {p["number"] for p in pins
                      if resolve_part._norm(p["name"]) not in ("EP", "PAD", "NC")}
            missing = sorted(n for n in signal if n not in pads)
            if missing:
                errors.append("footprint has no pad for pins %s (they would never "
                              "get a net)" % missing)
            # a footprint with FEWER pads than signal pins is a package mismatch
            if len(pads) < len(signal):
                errors.append("footprint pad count (%d) < signal pin count (%d) — "
                              "package mismatch" % (len(pads), len(signal)))
        else:
            warnings.append("footprint pads unreadable — pad/pin match unverified")
    else:
        warnings.append("no KiCad footprint resolved (not assembly-ready)")
    if not spec.get("power", {}).get("pins", {}).get("power"):
        errors.append("no power pin identified")
    if not spec.get("power", {}).get("pins", {}).get("ground"):
        warnings.append("no ground pin identified")
    # honest high-speed guard (Phase 5): flag routing we do not support
    hs = [i for i in spec.get("interfaces", [])
          if (i.get("type") if isinstance(i, dict) else i) in
          ("usb_hs", "ethernet", "mipi", "pcie", "ddr")]
    if hs:
        warnings.append("requires high-speed routing (%s) unsupported by the "
                        "current router" % ", ".join(str(x) for x in hs))
    return {"errors": errors, "warnings": warnings, "ok": len(errors) == 0}


def _apply_datasheet(spec, ds):
    """Merge real datasheet-extracted fields into the spec with provenance +
    confidence. Never overwrites a higher-confidence KiCad-derived field."""
    spec.setdefault("datasheet_evidence", ds)
    if not ds.get("_available"):
        spec.setdefault("missing_fields", []).append("datasheet (not provided)")
        return spec
    prov = spec.setdefault("provenance", {})
    conf = spec.setdefault("confidence", {})
    v = ds.get("voltage")
    if v and spec.get("power", {}).get("vcc_min") is None:
        spec["power"]["vcc_min"] = v["value"]["vcc_min"]
        spec["power"]["vcc_max"] = v["value"]["vcc_max"]
        prov["power.vcc_min"] = "datasheet:p%s" % v["page"]
        conf["power.vcc_min"] = v["confidence"]
    if ds.get("abs_max_present"):
        spec.setdefault("unsupported_fields", []).append(
            "abs_max: datasheet has an Absolute Maximum section — enter limits by hand")
    if ds.get("decoupling"):
        spec.setdefault("support_circuit", {}).setdefault("decoupling", [])
        prov["support_circuit.decoupling"] = "datasheet:p%s" % ds["decoupling"]["page"]
    return spec


# ---- Phase 1-7: the ingestion orchestrator ----------------------------------
def ingest_part(mpn, kicad_symbol=None, kicad_footprint=None, pin_table=None,
                datasheet=None, distributor=None, category="", manufacturer="",
                notes=""):
    """Fuse every available evidence source into a candidate UCS + a review
    record. NEVER returns 'supported' — fresh ingestion is 'needs_review' at best
    until a human approves; validation errors make it 'unsupported'."""
    used = []
    if kicad_symbol or resolve_part.symbol_info(mpn):
        spec = from_kicad_symbol(kicad_symbol or mpn, mpn=mpn, category=category,
                                 manufacturer=manufacturer)
        used.append("kicad_symbol")
    elif pin_table:
        spec = from_pin_table(mpn, pin_table, kicad_symbol=kicad_symbol,
                              kicad_footprint=kicad_footprint, category=category)
        used.append("pin_table")
    else:
        spec = _stub(mpn, category, "no KiCad symbol or pin table provided")
    if kicad_footprint and not spec.get("kicad_footprint"):
        spec["kicad_footprint"] = kicad_footprint
        spec.setdefault("provenance", {})["kicad_footprint"] = "user"
        used.append("footprint_override")
    ds = ingest_datasheet.extract(datasheet) if datasheet else {"_available": False}
    _apply_datasheet(spec, ds)
    if ds.get("_available"):
        used.append("datasheet")
    if distributor:
        spec.setdefault("sourcing", {}).update(distributor)
        spec.setdefault("provenance", {})["sourcing"] = "distributor"
        used.append("distributor")
    if notes:
        spec["user_notes"] = notes

    validation = validate_component(spec)
    # fresh ingestion status: never auto-'supported'
    if not validation["ok"]:
        status = "unsupported"
    else:
        status = "needs_review"     # a human must approve before use
    spec["support_status"] = status
    spec["ingest_sources"] = used
    report = build_ingest_report(spec, ds, validation, used)
    return spec, report


def build_ingest_report(spec, ds, validation, used):
    """The human-review artifact (Phase 7)."""
    review_fields = []
    conf = spec.get("confidence", {})
    for field, c in conf.items():
        if c < 0.6:
            review_fields.append({"field": field, "confidence": c,
                                  "provenance": spec.get("provenance", {}).get(field, "?")})
    unknowns = list(spec.get("missing_fields", []))
    return {
        "version": 1,
        "mpn": spec.get("mpn"),
        "category": spec.get("category"),
        "support_status": spec.get("support_status"),
        "sources_used": used,
        "datasheet_available": ds.get("_available", False),
        "identity": {"manufacturer": spec.get("manufacturer"),
                     "package": spec.get("package"),
                     "kicad_symbol": spec.get("kicad_symbol"),
                     "kicad_footprint": spec.get("kicad_footprint"),
                     "pin_count": len(spec.get("pins", []))},
        "interfaces": [i.get("type") if isinstance(i, dict) else i
                       for i in spec.get("interfaces", [])],
        "validation_errors": validation["errors"],
        "warnings": validation["warnings"],
        "unknowns": unknowns,
        "fields_needing_review": review_fields,
        "requires_human_approval": True,
    }


def report_markdown(report, spec):
    md = ["# Ingest Review — %s\n" % report["mpn"],
          "**Status:** %s  ·  sources: %s  ·  datasheet: %s\n"
          % (report["support_status"], ", ".join(report["sources_used"]) or "none",
             "yes" if report["datasheet_available"] else "no (fields unknown)")]
    idy = report["identity"]
    md.append("- Manufacturer: %s  ·  Package: %s  ·  Pins: %s"
              % (idy["manufacturer"] or "?", idy["package"] or "?", idy["pin_count"]))
    md.append("- Symbol: `%s`" % idy["kicad_symbol"])
    md.append("- Footprint: `%s`" % idy["kicad_footprint"])
    md.append("- Interfaces: %s\n" % (", ".join(report["interfaces"]) or "none inferred"))
    if report["validation_errors"]:
        md.append("### Validation errors (block use)")
        for e in report["validation_errors"]:
            md.append("- " + e)
        md.append("")
    if report["warnings"]:
        md.append("### Warnings\n" + "\n".join("- " + w for w in report["warnings"]) + "\n")
    if report["fields_needing_review"]:
        md.append("### Fields needing review (low confidence)")
        for f in report["fields_needing_review"]:
            md.append("- `%s` (confidence %.2f, from %s)"
                      % (f["field"], f["confidence"], f["provenance"]))
        md.append("")
    md.append("### Pin table")
    md.append("| Pad | Name | Type |")
    md.append("|---|---|---|")
    for p in spec.get("pins", []):
        md.append("| %s | %s | %s |" % (p["number"], p["name"], p.get("etype", "?")))
    return "\n".join(md) + "\n"


def from_mpn(mpn, category=""):
    """MPN -> distributor/library lookup. Tries the KiCad library by MPN first
    (real), else an honest stub."""
    if resolve_part.symbol_info(mpn):
        return from_kicad_symbol(mpn, mpn=mpn, category=category)
    return _stub(mpn, category,
                 "no KiCad symbol for MPN and distributor ingestion not "
                 "implemented (Phase 3 distributor path)",
                 source="distributor_api")


def from_distributor(url, mpn="", category=""):
    """DigiKey/Mouser/LCSC result. NOT IMPLEMENTED — honest stub."""
    return _stub(mpn or "unknown", category,
                 "distributor ingestion not implemented; use MPN or KiCad symbol",
                 source="distributor_api")
