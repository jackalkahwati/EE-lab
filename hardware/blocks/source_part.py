"""source_part.py — the full part-sourcing chain, one call.

  description + interface  ->  a real, in-stock, routable part on the board

Pipeline:
  1. DigiKey keyword search -> live candidates (MPN, price, stock, datasheet)
  2. rank: in-stock + a routable (leaded) package, cheapest wins
  3. read the winner's datasheet -> {package, pinout, support} (frontier model)
  4. resolve_from_spec: package -> verified footprint, bind pins to the interface
  5. verify: cross-check the datasheet pinout against a KiCad symbol if one exists
  6. cache the result so the pipeline doesn't re-source every run

Graceful fallback: if DigiKey has no creds / network fails / the datasheet can't
be read, fall back to resolve_part's KiCad-symbol path for a known part of the
interface. The result always carries `source` and `verified` so the BOM can tell
a sourced+verified part from a fallback.

  source_part.py <interface> <keywords...>     # standalone: source + print
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import resolve_part

# EE-lab/hardware/blocks/source_part.py -> EE-lab/software/prompt-to-pcb-ui/scripts
_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_SCRIPTS = os.path.join(_REPO, "software", "prompt-to-pcb-ui", "scripts")
sys.path.insert(0, _SCRIPTS)

# shared MPN/LCSC-keyed part registry (tools/parts) — the store BOTH board
# engines read/write. Soft dependency: sourcing must keep working without it.
sys.path.insert(0, os.path.join(_REPO, "tools", "parts"))
try:
    import registry as parts_registry
except Exception:
    parts_registry = None

CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "parts_cache.json")

# a known-good fallback part per interface (KiCad symbol path, no network needed)
FALLBACK = {
    "i2c_sensor": "LM75B",
    "i2c_device": "24LC256",
    "spi_device": "TMC5160",
    "stepper_driver": "TMC2209",
    "can_transceiver": "SN65HVD230",
    "current_sense": "INA228",
    "shift_register": "74HC595",
    "darlington_array": "ULN2803A",
}

# routability of common package families parsed from a DigiKey description
# coarse, easy-to-route leaded packages (>= ~1mm pitch)
_PKG_GOOD = ("SOIC", "SOP", "SO", "SOT", "TO-92", "DIP")
# leaded but FINE pitch (<= ~0.65mm) — routable but tight; worse than SOIC.
# Checked before _PKG_GOOD because VSSOP/MSOP/SSOP all contain the "SO" substring.
_PKG_FINE = ("TSSOP", "VSSOP", "MSOP", "SSOP", "QSOP")
_PKG_BAD = ("QFN", "DFN", "WSON", "BGA", "SON", "USON", "LGA", "CSP")


def _load_cache():
    try:
        return json.load(open(CACHE_PATH))
    except Exception:
        return {}


def _save_cache(c):
    try:
        json.dump(c, open(CACHE_PATH, "w"), indent=1, sort_keys=True)
    except Exception:
        pass


def _pkg_match(up, keyword):
    # the package token must not be inside another word (so 'SO' does NOT match
    # 'SENSOR'); DigiKey writes packages as '8SO', '8VSSOP', 'SOT563', '4-DFN'.
    return re.search(r"(?<![A-Z])" + re.escape(keyword), up) is not None


def _pkg_rank(desc):
    """Lower is more routable. Parse the package hint from a DigiKey description
    like 'SENSOR DIGITAL -55C-125C 8SOIC'. SOIC (1.27mm) beats fine-pitch
    SO-variants (VSSOP/TSSOP, <=0.65mm) beats leadless (QFN/DFN). Unknown
    package ranks below any recognized leaded one."""
    up = (desc or "").upper()
    if any(_pkg_match(up, k) for k in _PKG_BAD):
        return 20
    if any(_pkg_match(up, k) for k in _PKG_FINE):  # before _PKG_GOOD (they contain "SO")
        return 10
    for i, k in enumerate(_PKG_GOOD):
        if _pkg_match(up, k):
            return i
    return 12


def rank_candidates(cands):
    """Prefer in-stock, routable package, then cheaper. Returns sorted list."""
    def key(c):
        instock = 0 if (c.get("stock") or 0) > 0 else 1
        has_ds = 0 if c.get("datasheet") else 1
        return (instock, has_ds, _pkg_rank(c.get("desc")), c.get("price") or 9e9)
    return sorted(cands, key=key)


def _verify(part_name, spec_pins):
    """Cross-check the datasheet pinout against a KiCad symbol if one exists.
    Returns 'verified' | 'unverified (no symbol)' | 'MISMATCH'."""
    sym = resolve_part.symbol_pinmap(part_name)
    if not sym:
        return "unverified (no symbol)"
    norm = resolve_part._norm
    ok = 0
    for p in spec_pins:
        num, nm = str(p.get("number")), p.get("name", "")
        if num in sym and sym[num] == norm(nm):
            ok += 1
    return "verified" if ok >= max(3, len(sym) - 1) else "MISMATCH"


def source(query, interface, nets, refresh=False):
    """Source a real part for `interface` matching `query`, binding to `nets`.
    Cache-first; falls back to the KiCad-symbol path on any failure."""
    cache = _load_cache()
    ckey = "%s::%s" % (interface, query.lower().strip())
    cached = None if refresh else cache.get(ckey)

    # shared registry next: a part sourced by any engine (or bulk-ingested)
    # answers here without a network trip
    if cached is None and not refresh and parts_registry:
        try:
            reg = parts_registry.lookup_query(interface, query)
            if reg and reg.get("pins"):
                prov = reg.get("provenance") or {}
                cached = {
                    "mpn": reg.get("mpn"), "manufacturer": reg.get("manufacturer"),
                    "price": reg.get("price"), "stock": reg.get("stock"),
                    "datasheet": reg.get("datasheet"), "package": reg.get("package"),
                    "pins": reg.get("pins"),
                    "verified": prov.get("verified", "registry"),
                    "_via": "registry",
                }
        except Exception:
            pass

    if cached is None:
        cached = _source_live(query, interface)
        if cached:
            cache[ckey] = cached
            _save_cache(cache)
            if parts_registry:
                try:
                    pid = parts_registry.upsert({
                        "mpn": cached.get("mpn"),
                        "manufacturer": cached.get("manufacturer"),
                        "description": query,
                        "package": cached.get("package"),
                        "interface": interface,
                        "pins": cached.get("pins"),
                        "datasheet": cached.get("datasheet"),
                        "price": cached.get("price") if isinstance(cached.get("price"), (int, float)) else None,
                        "stock": cached.get("stock") if isinstance(cached.get("stock"), int) else None,
                        "provenance": {"source": "digikey+datasheet",
                                       "verified": cached.get("verified")},
                    })
                    parts_registry.remember_query(interface, query, pid)
                except Exception:
                    pass  # registry is a cache layer, never a build blocker

    if cached and cached.get("pins"):
        r = resolve_part.resolve_from_spec(
            {"part": cached["mpn"], "package": cached["package"], "pins": cached["pins"]},
            interface, nets)
        if "error" not in r:
            r.update({k: cached[k] for k in
                      ("mpn", "manufacturer", "price", "stock", "datasheet", "verified")})
            # honest path label: a registry hit is not a fresh DigiKey source
            r["source"] = ("registry (digikey+datasheet)"
                           if cached.get("_via") == "registry" else "digikey+datasheet")
            return r

    # fallback: KiCad-symbol path for a known interface part
    fb = FALLBACK.get(interface)
    r = resolve_part.resolve(fb, interface, nets) if fb else {"error": "no part"}
    if "error" not in r:
        r.update({"mpn": None, "manufacturer": None, "price": None, "stock": None,
                  "datasheet": None, "verified": "fallback (kicad symbol)",
                  "source": "kicad-symbol"})
    return r


def _registry_footprint(entry):
    """Footprint text for a catalog part: registry-cached kicad_mod, else a
    live easyeda2kicad fetch persisted back to the registry. None on failure."""
    if entry.get("kicad_mod"):
        return entry["kicad_mod"]
    lcsc = entry.get("lcsc")
    if not lcsc:
        return None
    import subprocess
    import tempfile
    base = os.path.join(tempfile.gettempdir(), "fl_fp_%s" % lcsc)
    try:
        subprocess.run(["python3", "-m", "easyeda2kicad", "--footprint", "--overwrite",
                        "--lcsc_id=%s" % lcsc, "--output=%s" % base],
                       capture_output=True, timeout=45)
        pretty = base + ".pretty"
        mods = [f for f in os.listdir(pretty) if f.endswith(".kicad_mod")]
        if not mods:
            return None
        mod = open(os.path.join(pretty, mods[0])).read()
        if parts_registry:
            parts_registry.upsert({"lcsc": lcsc, "kicad_mod": mod,
                                   "provenance": {"source": "easyeda2kicad",
                                                  "verified": "lcsc-footprint"}})
        return mod
    except Exception:
        return None


def source_catalog(query, roles, nets, interface_name=None):
    """Source a part from the shared registry's JLCPCB catalog for an
    ARBITRARY role set — the Phase 3/4 path past the hand-written contracts.

      query          plain-language part ask ("class d audio amplifier 3W")
      roles          {role: {"desc": ..., "required": bool, "mode": "one"|"multi"}}
      nets           {role: net_name} — roles absent here stay unconnected
      interface_name cache key for the binding (defaults to the sorted role set)

    Chain: registry catalog search (684k JLCPCB parts, basic-first) ->
    datasheet pins (cached on the part row) -> LLM-synthesized, mechanically
    verified pin binding (cached in registry.bindings, review-required) ->
    registry footprint (easyeda2kicad on miss). Returns a place()-ready dict
    with lib='registry' + footprint=<LCSC id>, or {'error': ...}."""
    if not parts_registry:
        return {"error": "part registry unavailable"}
    import contract_synth
    from digikey import load_env
    load_env()  # OPENAI_* for the datasheet + binding models
    iface = interface_name or ("custom::" + "+".join(sorted(roles)))
    cands = [c for c in parts_registry.search(query, 10)
             if c.get("lcsc") and c.get("datasheet")]
    if not cands:
        return {"error": "no catalog match for %r" % query}
    last_err = None
    for cand in cands[:3]:
        try:
            pins = cand.get("pins")
            if not pins:
                import time as _time
                import datasheet_to_spec
                text = datasheet_to_spec.fetch_text(cand["datasheet"])
                spec = None
                for attempt in (0, 1, 2):  # 429s are routine on the shared key
                    try:
                        spec = datasheet_to_spec.extract(text, cand.get("mpn"))
                        break
                    except Exception as e:
                        if "429" not in str(e) or attempt == 2:
                            raise
                        _time.sleep(8 * (attempt + 1))
                pins = spec.get("pins") or []
                if not pins:
                    raise RuntimeError("datasheet yielded no pin table")
                parts_registry.upsert({
                    "lcsc": cand["lcsc"], "pins": pins,
                    "package": cand.get("package") or spec.get("package")})
            syn = contract_synth.synthesize(cand["lcsc"], pins, roles, iface)
            binding = syn["binding"]
            mod = _registry_footprint(cand)
            if not mod:
                raise RuntimeError("no footprint for %s" % cand["lcsc"])
            pmap = {}
            for role, pin_nums in binding.items():
                net = nets.get(role)
                if not net:
                    continue
                for n in pin_nums:
                    pmap[str(n)] = net
            return {
                "symbol": cand.get("mpn"), "lib": "registry",
                "footprint": cand["lcsc"], "pmap": pmap,
                "mpn": cand.get("mpn"), "manufacturer": cand.get("manufacturer"),
                "lcsc": cand["lcsc"], "price": cand.get("price"),
                "stock": cand.get("stock"), "datasheet": cand.get("datasheet"),
                "verified": "llm-datasheet-binding (review-required)",
                "source": "catalog+datasheet+llm",
                "binding": binding,
            }
        except Exception as e:
            last_err = "%s: %s" % (cand.get("lcsc"), str(e)[:120])
    return {"error": "no catalog candidate bound cleanly (last: %s)" % last_err}


def _source_live(query, interface):
    """DigiKey search -> rank -> datasheet -> spec. Returns a cacheable dict or
    None if any step fails (caller falls back)."""
    try:
        import digikey
        import datasheet_to_spec
        digikey.load_env()
        cands = rank_candidates(digikey.search(query, limit=10))
        for c in cands[:4]:  # try the best few until one datasheet reads
            if not c.get("datasheet"):
                continue
            try:
                spec = datasheet_to_spec.extract(
                    datasheet_to_spec.fetch_text(c["datasheet"]), c["mpn"])
            except Exception:
                continue
            if not spec.get("pins"):
                continue
            det = {}
            try:  # authoritative price/stock for the winner
                det = digikey.part_details(c["mpn"])
            except Exception:
                pass
            return {
                "mpn": c["mpn"], "manufacturer": c.get("manufacturer"),
                "price": det.get("price") or c.get("price"),
                "stock": det.get("stock") or c.get("stock"),
                "datasheet": c["datasheet"], "package": spec.get("package", ""),
                "pins": spec.get("pins", []),
                "verified": _verify(c["mpn"], spec.get("pins", [])),
            }
    except Exception:
        return None
    return None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    interface = args[0] if args else "i2c_sensor"
    query = " ".join(args[1:]) or "temperature sensor"
    nets = {"power": "+3V3", "gnd": "GND", "i2c_scl": "I2C_SCL",
            "i2c_sda": "I2C_SDA", "int": "SENSOR_INT"}
    r = source(query, interface, nets, refresh="--refresh" in sys.argv)
    if "error" in r:
        print("SOURCE ERROR:", r["error"])
        return
    print("SOURCED %s (%s) — %s" % (r.get("mpn") or "fallback",
                                    r.get("manufacturer") or "-", r["source"]))
    print("  price $%s · stock %s · %s" % (r.get("price"), r.get("stock"), r.get("verified")))
    print("  footprint %s:%s" % (r["lib"], r["footprint"]))
    print("  pins:", {k: v for k, v in sorted(r["pmap"].items())})


if __name__ == "__main__":
    main()
