"""General part resolver — the path beyond a hardcoded parts library.

Instead of a hand-written block per part (footprint + pin map baked in), resolve
ANY part from KiCad's own symbol + footprint libraries:
  1. find the symbol by name/MPN (following `(extends ...)` inheritance),
  2. read its REAL pin names (the library already knows pad 2 = SCL),
  3. bind those pins to an interface contract (I2C sensor, SPI device, ...),
  4. pick a routable footprint from the symbol's fp_filters,
  5. hand back (lib, footprint, pin->net map) for the composer to place + wire.

This keeps a small set of reusable INTERFACE contracts instead of N per-part
blocks: any part the symbol libraries know becomes usable. Sourcing (DigiKey
MPN/price/stock) and footprints for parts KiCad lacks (SnapEDA) layer on later.

  resolve_part.py <symbol-name> <interface>     # standalone: print the resolution
"""
import os
import re
import sys

SYM_DIR = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols"
FP_DIR = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints"


# ---- interface contracts ----------------------------------------------------
# role -> (pin-name aliases, net-key, cardinality, required). The net-key is
# resolved against the `nets` dict the caller passes (so the same contract wires
# into whatever the board calls its bus). Power/gnd resolve to the rail nets;
# every other net-key is looked up in the caller's `nets` dict, so the block
# that instantiates a part supplies e.g. nets["spi_sck"], nets["vmotor"].
#
# Aliases are matched after _norm() (uppercase, strip everything but [A-Z0-9+]),
# so "~{EN}" matches "EN", "V_{DD}" matches "VDD", "Vin+" matches "VIN+".
#
# Cardinality: "one" binds the first matching pin then stops; "multi" binds
# every matching pin (power/gnd rails, multi-pin ground pads, address straps).
# Support passives specific to a part (charge-pump caps, sense resistors,
# decoupling) are the instantiating BLOCK's job, not the contract's — the
# contract only defines how the part talks to the rest of the board.

# shared alias sets
_PWR = ["+VS", "VS", "VDD", "VCC", "VDDIO", "VLOGIC", "V+", "AVDD", "DVDD",
        "VBAT", "VCCIO", "VIO", "AVCC", "DVCC", "VDDA", "VDDD", "VIN2"]
_GND = ["GND", "VSS", "AGND", "DGND", "EP", "PAD", "GND1", "EPAD", "PGND",
        "GNDA", "GNDD", "VSSA", "VSSD"]

CONTRACTS = {
    # ---- I2C ----------------------------------------------------------------
    "i2c_sensor": [
        ("power", _PWR, "power", "multi", True),
        ("gnd", _GND, "gnd", "multi", True),
        ("scl", ["SCL", "SCLK", "SCLSPC", "SCK"], "i2c_scl", "one", True),
        ("sda", ["SDA", "SDI", "SDASDI", "SDIO"], "i2c_sda", "one", True),
        ("int", ["INT", "INT1", "DRDY", "OS", "ALERT", "IRQ"], "int", "one", False),
        ("addr", ["A0", "A1", "A2", "AD0", "ADDR", "ADD", "SDO"], "gnd", "multi", False),
    ],
    # Generic I2C peripheral (EEPROM, GPIO expander, RTC, sensor). RESET ties
    # high, WP ties low, address straps tie low, by default.
    "i2c_device": [
        ("power", _PWR, "power", "multi", True),
        ("gnd", _GND, "gnd", "multi", True),
        ("scl", ["SCL", "SCK", "SCLK"], "i2c_scl", "one", True),
        ("sda", ["SDA", "SDIO", "SDI"], "i2c_sda", "one", True),
        ("addr", ["A0", "A1", "A2", "AD0", "AD1", "ADDR"], "gnd", "multi", False),
        ("int", ["INT", "INTA", "INTB", "ALERT", "DRDY", "IRQ"], "int", "multi", False),
        ("reset", ["RESET", "RST", "MR"], "power", "one", False),
        ("wp", ["WP"], "gnd", "one", False),
    ],
    # ---- SPI ----------------------------------------------------------------
    # Generic SPI peripheral (ADC, driver-config, flash, DAC).
    "spi_device": [
        ("power", _PWR, "power", "multi", True),
        ("gnd", _GND, "gnd", "multi", True),
        ("sck", ["SCK", "SCLK", "SPC"], "spi_sck", "one", True),
        ("mosi", ["MOSI", "SDI", "DIN", "SI"], "spi_mosi", "one", True),
        ("miso", ["MISO", "SDO", "DOUT", "SO"], "spi_miso", "one", False),
        ("cs", ["CS", "NSS", "SS", "CSB", "CSN"], "spi_cs", "one", True),
        ("int", ["INT", "DRDY", "IRQ", "ALERT"], "int", "one", False),
        ("reset", ["RESET", "RST"], "power", "one", False),
    ],
    # ---- Stepper driver (TMC / DRV / A4988 class) --------------------------
    "stepper_driver": [
        ("power_motor", ["VS", "VM", "VMOT", "VBB", "VMOTOR", "VPWR"], "vmotor", "multi", True),
        ("power_io", ["VCC_IO", "VCCIO", "VIO", "VDD", "VCC", "VIN2"], "power", "multi", True),
        ("gnd", _GND, "gnd", "multi", True),
        ("step", ["STEP", "STP"], "step", "one", True),
        ("dir", ["DIR"], "dir", "one", True),
        ("en", ["EN", "ENN", "ENABLE", "ENABLEN"], "en", "one", False),
        ("motor_a1", ["OA1", "A1", "M1A", "AOUT1", "OUT1A", "MA1"], "motor_a1", "one", True),
        ("motor_a2", ["OA2", "A2", "M2A", "AOUT2", "OUT2A", "MA2"], "motor_a2", "one", True),
        ("motor_b1", ["OB1", "B1", "M1B", "BOUT1", "OUT1B", "MB1"], "motor_b1", "one", True),
        ("motor_b2", ["OB2", "B2", "M2B", "BOUT2", "OUT2B", "MB2"], "motor_b2", "one", True),
        ("cp_out", ["CPO"], "cp_out", "one", False),          # charge pump +
        ("cp_in", ["CPI"], "cp_in", "one", False),            # charge pump -
        ("vcp", ["VCP", "CP"], "vcp", "one", False),          # charge pump reservoir
        ("reg_out", ["5VOUT", "VDDOUT", "VCCOUT"], "reg_out", "one", False),
        ("sense_a", ["BRA", "SRA", "SNSA"], "gnd", "one", False),   # RDSon sense -> GND
        ("sense_b", ["BRB", "SRB", "SNSB"], "gnd", "one", False),
    ],
    # ---- CAN transceiver (SN65HVD / MCP2551 class) -------------------------
    "can_transceiver": [
        ("power", ["VCC", "VDD"], "power", "multi", True),
        ("gnd", ["GND", "VSS"], "gnd", "multi", True),
        ("txd", ["D", "TXD", "TX", "CTX"], "can_txd", "one", True),
        ("rxd", ["R", "RXD", "RX", "CRX"], "can_rxd", "one", True),
        ("canh", ["CANH"], "canh", "one", True),
        ("canl", ["CANL"], "canl", "one", True),
        ("slope", ["RS", "STB", "STBY", "S", "MODE"], "gnd", "one", False),
    ],
    # ---- Current / power monitor (INA class, I2C) --------------------------
    "current_sense": [
        ("power", ["VS", "VDD", "VCC"], "power", "multi", True),
        ("gnd", ["GND", "VSS"], "gnd", "multi", True),
        ("scl", ["SCL"], "i2c_scl", "one", True),
        ("sda", ["SDA"], "i2c_sda", "one", True),
        ("shunt_hi", ["VIN+", "IN+", "VINP", "SENSE+"], "shunt_hi", "one", True),
        ("shunt_lo", ["VIN-", "IN-", "VINN", "SENSE-"], "shunt_lo", "one", True),
        ("vbus", ["VBUS"], "shunt_lo", "one", False),
        ("alert", ["ALERT"], "int", "one", False),
        ("addr", ["A0", "A1"], "gnd", "multi", False),
    ],
    # ---- Shift register (74HC595 class): SPI-ish serial in -> parallel out ---
    "shift_register": [
        ("power", ["VCC", "VDD"], "power", "multi", True),
        ("gnd", ["GND", "VSS"], "gnd", "multi", True),
        ("ser", ["SER", "DS", "SI", "A", "SDI"], "sr_ser", "one", True),
        ("srclk", ["SRCLK", "SHCP", "SCK", "SCLK"], "sr_srclk", "one", True),
        ("rclk", ["RCLK", "STCP", "LATCH", "RCK"], "sr_rclk", "one", True),
        ("oe", ["OE", "G"], "gnd", "one", False),          # output enable -> GND (on)
        ("srclr", ["SRCLR", "MR", "SCLR"], "power", "one", False),  # clear -> VCC (off)
        ("q0", ["QA", "Q0"], "sr_q0", "one", False),
        ("q1", ["QB", "Q1"], "sr_q1", "one", False),
        ("q2", ["QC", "Q2"], "sr_q2", "one", False),
        ("q3", ["QD", "Q3"], "sr_q3", "one", False),
    ],
    # ---- Darlington array (ULN2803 class): logic in -> relay-coil sink out --
    "darlington_array": [
        ("gnd", ["GND", "E", "VSS"], "gnd", "multi", True),
        ("com", ["COM", "CD", "K"], "drv_com", "one", False),   # flyback common
        ("in0", ["I1", "1B", "IN1"], "drv_in0", "one", True),
        ("in1", ["I2", "2B", "IN2"], "drv_in1", "one", False),
        ("in2", ["I3", "3B", "IN3"], "drv_in2", "one", False),
        ("in3", ["I4", "4B", "IN4"], "drv_in3", "one", False),
        ("out0", ["O1", "1C", "OUT1"], "drv_out0", "one", True),
        ("out1", ["O2", "2C", "OUT2"], "drv_out1", "one", False),
        ("out2", ["O3", "3C", "OUT3"], "drv_out2", "one", False),
        ("out3", ["O4", "4C", "OUT4"], "drv_out3", "one", False),
    ],
    # ---- Adjustable / LDO regulator ----------------------------------------
    "regulator": [
        ("vin", ["VIN", "IN", "V+", "VI"], "vin", "multi", True),
        ("vout", ["VOUT", "OUT", "VO"], "vout", "multi", True),
        ("gnd", _GND, "gnd", "multi", True),
        ("en", ["EN", "SHDN", "ENABLE"], "en", "one", False),
        ("adj", ["ADJ", "FB", "SET", "VSENSE", "SENSE"], "adj", "one", False),
    ],
}


# ---- symbol parsing ---------------------------------------------------------
def _balanced(text, start):
    depth = 0
    for j in range(start, len(text)):
        if text[j] == "(":
            depth += 1
        elif text[j] == ")":
            depth -= 1
            if depth == 0:
                return text[start:j + 1]
    return text[start:]


def _find_symbol_file(query):
    """Locate the .kicad_sym file + exact symbol name for a query (MPN or name).
    Exact match first, then case-insensitive substring."""
    q = query.lower()
    files = [f for f in os.listdir(SYM_DIR) if f.endswith(".kicad_sym")]
    best = None
    for f in files:
        text = open(os.path.join(SYM_DIR, f)).read()
        for m in re.finditer(r'\(symbol "([^"]+)"', text):
            name = m.group(1)
            if "_" in name and re.search(r"_\d+_\d+$", name):
                continue  # unit sub-symbol
            low = name.lower()
            if low == q:
                return f, name, text
            if best is None and q in low:
                best = (f, name, text)
    return best or (None, None, None)


def _symbol_block(text, name):
    i = text.find('(symbol "%s"' % name)
    return _balanced(text, i) if i >= 0 else ""


def symbol_info(query):
    """Return (symbol_name, pins, fp_filters) for a part query. Pins is a list of
    (number, name). Follows `(extends BASE)` to inherit pins/filters."""
    f, name, text = _find_symbol_file(query)
    if not name:
        return None
    blk = _symbol_block(text, name)
    ext = re.search(r'\(extends "([^"]+)"', blk)
    base_blk = _symbol_block(text, ext.group(1)) if ext else blk
    pins = re.findall(r'\(pin\s+\S+\s+\S+.*?\(name "([^"]+)".*?\(number "([^"]+)"',
                      base_blk, re.S)
    pins = [(num, nm) for nm, num in pins]
    fpf = re.search(r'ki_fp_filters"\s*"([^"]*)"', blk) or re.search(
        r'ki_fp_filters"\s*"([^"]*)"', base_blk)
    return {"name": name, "pins": pins, "fp_filters": fpf.group(1) if fpf else ""}


# ---- binding ----------------------------------------------------------------
def _norm(s):
    return re.sub(r"[^A-Z0-9+]", "", s.upper())


def _pin_tokens(nm):
    """Normalized tokens of a pin name, splitting multiplexed pins on '/'.
    'SCK/CFG2' -> {'SCK','CFG2'}, so an SPI 'sck' alias binds a configurable
    driver's shared SPI/config pin. Also keeps the whole normalized name."""
    parts = re.split(r"[/]", nm)
    toks = {_norm(p) for p in parts if p.strip()}
    toks.add(_norm(nm))
    toks.discard("")
    return toks


def bind(pins, interface, nets):
    """Bind a part's pins to the interface contract. Returns
    (pmap {number: netname}, report dict). Power/gnd resolve to the rail nets;
    signal roles resolve via the caller's `nets` map."""
    contract = CONTRACTS[interface]
    rail = {"power": nets.get("power", "+3V3"), "gnd": nets.get("gnd", "GND")}
    pmap, used, bound_roles = {}, set(), {}
    for role, aliases, netkey, card, _req in contract:
        naliases = {_norm(a) for a in aliases}
        for num, nm in pins:
            if num in used:
                continue
            if _pin_tokens(nm) & naliases:
                net = rail.get(netkey) or nets.get(netkey)
                if not net:
                    continue
                pmap[num] = net
                used.add(num)
                bound_roles.setdefault(role, []).append("%s(%s)" % (nm, num))
                if card == "one":
                    break
    missing = [role for role, _a, _k, _c, req in contract
               if req and role not in bound_roles]
    nc = [(num, nm) for num, nm in pins if num not in used]
    return pmap, {"bound": bound_roles, "missing": missing, "nc": nc}


# ---- footprint selection ----------------------------------------------------
# Prefer leaded/coarse packages that escape on two signal layers; avoid
# fine-pitch leadless (QFN/DFN/WSON/BGA) that need via-in-pad fanout.
_PKG_RANK = [
    ("SOIC", 0), ("SOP", 1), ("SO_", 1), ("SOT-223", 2), ("SOT-23", 3),
    ("MSOP", 4), ("TSSOP", 4), ("SSOP", 5), ("TO-92", 6),
    ("QFP", 8), ("QFN", 20), ("DFN", 20), ("WSON", 20), ("BGA", 30), ("SON", 20),
]


def _fp_index():
    idx = {}
    for d in os.listdir(FP_DIR):
        if not d.endswith(".pretty"):
            continue
        lib = d[:-len(".pretty")]
        try:
            for fn in os.listdir(os.path.join(FP_DIR, d)):
                if fn.endswith(".kicad_mod"):
                    idx.setdefault(fn[:-len(".kicad_mod")], lib)
        except OSError:
            pass
    return idx


def _glob_to_re(g):
    return re.compile("^" + re.escape(g).replace(r"\*", ".*").replace(r"\?", ".") + "$", re.I)


def pick_footprint(fp_filters):
    """Choose the most routable footprint matching the symbol's fp_filters."""
    idx = _fp_index()
    globs = [g for g in re.split(r"\s+", fp_filters.strip()) if g]
    best = None  # (score, lib, name)
    for g in globs:
        rx = _glob_to_re(g)
        for name, lib in idx.items():
            if not rx.match(name):
                continue
            up = name.upper()
            flat = up.replace("-", "").replace("_", "")
            rank = 50
            for key, r in _PKG_RANK:
                if key.replace("_", "") in flat:
                    rank = r
                    break
            # within a package family, prefer the simplest variant (no exposed
            # pad / thermal vias / mask tweaks) and the shorter name.
            penalty = sum(5 for bad in ("1EP", "THERMALVIAS", "MASK") if bad in flat)
            score = rank * 1000 + penalty * 100 + len(name)
            if best is None or score < best[0]:
                best = (score, lib, name)
    return (best[1], best[2]) if best else (None, None)


def footprint_for_package(package, npins=None):
    """Map a datasheet PACKAGE NAME (e.g. 'SOIC-8', 'QFN-24 4x4mm 0.5mm pitch')
    to a verified KiCad land pattern. Geometry is REUSED, never generated — the
    datasheet only tells us which standard package, and KiCad ships the IPC
    footprint for it."""
    p = package.upper().replace("-", " ").replace("/", " ")
    fams = ["SOIC", "TSSOP", "VSSOP", "MSOP", "SSOP", "SOT 23", "SOT", "QFN",
            "DFN", "WSON", "TQFP", "LQFP", "QFP", "BGA", "TO 92", "SON"]
    fam = next((k for k in fams if k in p), None)
    if not npins:
        m = re.search(r"\b(\d{1,3})\b", package)
        npins = int(m.group(1)) if m else None
    fam_glob = (fam or "*").replace(" ", "?")
    glob = "*%s*%s*" % (fam_glob, npins or "")
    return pick_footprint(glob)


def resolve_from_spec(spec, interface, nets):
    """Resolve a component from an extracted datasheet spec (pins + package),
    rather than a KiCad symbol. Same return shape as resolve()."""
    pins = [(str(p.get("number")), p.get("name", "")) for p in spec.get("pins", [])
            if p.get("number")]
    if interface not in CONTRACTS:
        return {"error": "unknown interface '%s'" % interface}
    pmap, rep = bind(pins, interface, nets)
    if rep["missing"]:
        return {"error": "unbound required roles %s" % rep["missing"], "report": rep}
    lib, fp = footprint_for_package(spec.get("package", ""), len(pins))
    if not fp:
        return {"error": "no footprint for package '%s'" % spec.get("package")}
    # CRITICAL: the chosen footprint's pads must include every bound pin number,
    # or some pins (e.g. SDA) silently never get a net — a disconnected part that
    # passes DRC. Reject the mismatch so the caller falls back to a verified part.
    fp_pads = _footprint_pads(lib, fp)
    missing_pads = [num for num in pmap if num not in fp_pads]
    if missing_pads:
        return {"error": "footprint %s:%s lacks pads %s for package '%s' (pin/pad mismatch)"
                % (lib, fp, missing_pads, spec.get("package"))}
    return {"symbol": spec.get("part"), "lib": lib, "footprint": fp, "pmap": pmap,
            "report": rep}


def _footprint_pads(lib, name):
    """Set of pad names declared in a footprint."""
    try:
        return set(re.findall(r'\(pad\s+"([^"]+)"', _load(lib, name)))
    except Exception:
        return set()


def symbol_pinmap(query):
    """For verification: {number: NORMALIZED-name} from a KiCad symbol, or None."""
    info = symbol_info(query)
    if not info:
        return None
    return {num: _norm(nm) for num, nm in info["pins"]}


def resolve(query, interface, nets):
    """Full resolution: symbol -> pins -> binding -> footprint. Returns a dict
    with lib, footprint, pmap, and a human report (or {'error': ...})."""
    info = symbol_info(query)
    if not info:
        return {"error": "no symbol found for '%s'" % query}
    if interface not in CONTRACTS:
        return {"error": "unknown interface '%s'" % interface}
    pmap, rep = bind(info["pins"], interface, nets)
    if rep["missing"]:
        return {"error": "unbound required roles %s for %s" % (rep["missing"], info["name"]),
                "report": rep}
    lib, fp = pick_footprint(info["fp_filters"])
    if not fp:
        return {"error": "no footprint matched filters '%s'" % info["fp_filters"]}
    return {"symbol": info["name"], "lib": lib, "footprint": fp, "pmap": pmap,
            "power_pins": rep["bound"].get("power", []), "report": rep}


# a superset of net-keys any contract might ask for, so the self-test can bind
# every archetype without a per-part net map.
_TEST_NETS = {
    "power": "+3V3", "gnd": "GND",
    "i2c_scl": "I2C_SCL", "i2c_sda": "I2C_SDA", "int": "IRQ",
    "spi_sck": "SPI_SCK", "spi_mosi": "SPI_MOSI", "spi_miso": "SPI_MISO", "spi_cs": "SPI_CS",
    "vmotor": "+24V", "step": "STEP", "dir": "DIR", "en": "MOT_EN",
    "motor_a1": "M_A1", "motor_a2": "M_A2", "motor_b1": "M_B1", "motor_b2": "M_B2",
    "can_txd": "CAN_TXD", "can_rxd": "CAN_RXD", "canh": "CANH", "canl": "CANL",
    "shunt_hi": "SHUNT_HI", "shunt_lo": "SHUNT_LO",
    "vin": "+24V", "vout": "+5V", "adj": "REG_ADJ",
}

# self-test matrix: (query, interface) covering the new archetypes against real
# KiCad symbols. Run `resolve_part.py --selftest`.
_SELFTEST = [
    ("LM75B", "i2c_sensor"),
    ("24LC256", "i2c_device"),
    ("MCP23017", "i2c_device"),
    ("INA228", "current_sense"),
    ("TMC2209", "stepper_driver"),
    ("TMC5160", "spi_device"),
    ("SN65HVD230", "can_transceiver"),
]


def _print_resolution(query, interface, r):
    if "error" in r:
        print("  FAIL %-12s %-16s : %s" % (query, interface, r["error"]))
        return False
    print("  OK   %-12s %-16s -> %s:%s" % (query, interface, r["lib"], r["footprint"]))
    bound = r["report"]["bound"]
    print("       roles:", ", ".join(sorted(bound)))
    return True


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        print("part-resolution self-test (%d archetypes):" % len(_SELFTEST))
        ok = 0
        for query, interface in _SELFTEST:
            r = resolve(query, interface, _TEST_NETS)
            if _print_resolution(query, interface, r):
                ok += 1
        print("%d/%d resolved" % (ok, len(_SELFTEST)))
        sys.exit(0 if ok == len(_SELFTEST) else 1)

    query = sys.argv[1] if len(sys.argv) > 1 else "LM75B"
    interface = sys.argv[2] if len(sys.argv) > 2 else "i2c_sensor"
    r = resolve(query, interface, _TEST_NETS)
    if "error" in r:
        print("RESOLVE ERROR:", r["error"])
        if "report" in r:
            print("  bound:", r["report"]["bound"])
        return
    print("RESOLVED %s -> %s:%s" % (r["symbol"], r["lib"], r["footprint"]))
    print("  pin -> net:")
    for num in sorted(r["pmap"], key=lambda x: (len(x), x)):
        print("    %-3s -> %s" % (num, r["pmap"][num]))
    if r["report"]["nc"]:
        print("  NC:", ", ".join("%s(%s)" % (nm, num) for num, nm in r["report"]["nc"]))


if __name__ == "__main__":
    main()
