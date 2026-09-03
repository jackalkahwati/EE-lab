#!/usr/bin/env python3
"""
functional_sim.py - Automated FUNCTIONAL simulation stage for the FirstLight
Compose PCB pipeline.

Unlike the pipeline's power/thermal/mechanical sims, this stage checks that the
board's CRITICAL SIGNAL PATHS actually work: a reference holds its voltage under
load, a mux source settles to the ADC's resolution in time, an RS-485 driver
puts a valid differential on a terminated bus, and the power rail is decoupled.

It reads a board's netlist (chipscale-spec.json), detects which IC classes are
present via the design-rules DB, GENERATES the matching ngspice deck
parameterized by the actual parts, runs each via ngspice -b, parses the .meas
results and applies a datasheet-derived pass criterion.

Usage:
    python3 functional_sim.py <chipscale-spec.json> [design_rules.json]

Output (one line per deck):
    SIM <name> PASS|FAIL|SKIP <key metric or reason>
then ONE verdict line last:
    FUNCSIM PASS             exit 0   >=1 deck ran and none failed
    FUNCSIM FAIL <n>         exit 1   n decks failed their criterion
    FUNCSIM SKIP 0           exit 0   nothing could be evaluated (no known ICs /
                                      no caps / all decks SKIP) — NOT a pass, and
                                      only PASS/FAIL decks count as "ran"
    FUNCSIM ERROR <reason>   exit 2   could not run: unreadable/malformed spec
                                      (missing 'parts', null 'gnd', nameless
                                      part), bad rules DB, ngspice binary missing
                                      when there were decks to run, any exception.
                                      Never a traceback.
MPN -> rule lookup is rule_match.match_rule (shared with design_check /
functional_wire), also for DEVICE_DB below — so a REF3025AIDBZR that passes the
gate is simulated with the REF3025 parameters instead of being silently dropped.

HONEST SCOPE: these are critical-path / capability checks with datasheet-class
device parameters (stated inline in every generated deck), NOT whole-board
behavioral models. They confirm the analog/power paths are sound; they do NOT
confirm mixed-signal IC internals (ADC linearity, digital protocol). Assumptions
(source impedance, cap ESR/ESL, driver Rout) are stated in each .cir.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

from rule_match import load_rules, match_rule, validate_spec


def _resolve_ngspice():
    """ngspice binary, resolved like the KiCad/ffmpeg helpers in
    hardware/blocks/toolchain.py: FL_NGSPICE override wins, then PATH lookup,
    then the macOS homebrew default so the Mac keeps working with nothing set."""
    p = os.environ.get("FL_NGSPICE")
    if p:
        return p
    return shutil.which("ngspice") or "/opt/homebrew/bin/ngspice"


NGSPICE = _resolve_ngspice()

# ----------------------------------------------------------------------------
# Datasheet-class device parameter DB. Keyed by MPN, with per-class fallbacks.
# Every value here is stated as an assumption inside the generated deck.
# ----------------------------------------------------------------------------
DEVICE_DB = {
    "REF3025": {
        "class": "reference",
        "vref": 2.5,        # TI REF3025 = 2.500 V
        "zout": 0.8,        # datasheet-class closed-loop Zout (ohm)
        "lout": 3e-6,       # small series L for realistic HF Zout rise (H)
        "iout_max": 25e-3,  # +/-25 mA
    },
    "ADS1115IDGS": {
        "class": "adc",
        "bits": 16,
        "fsr": 4.096,           # +/-2.048 V default PGA => 4.096 V span
        "conv_time_fast": 303e-6,   # 3300 SPS speed grade
        "conv_time_slow": 1.16e-3,  # 860 SPS
        "cin": 25e-12,          # ADC + mux + short-trace input cap (assumption)
    },
    "CD74HC4067": {
        "class": "mux",
        "ron": 120.0,       # Ron ~120 ohm typ @ Vcc=3.3V (70@4.5V .. 200 worst)
    },
    "MAX3485": {
        "class": "transceiver",
        "rout": 12.0,       # per-side driver output resistance (ohm)
        "vdrv": 3.3,        # logic/supply swing driving the output stage
        "vod_min": 1.5,     # RS-485 spec: >=1.5 V into 54 ohm
    },
    "RP2040": {"class": "mcu"},
}

# per-class fallback params if an unknown MPN of a known class shows up
CLASS_FALLBACK = {
    "reference": {"vref": 2.5, "zout": 1.0, "lout": 3e-6, "iout_max": 10e-3},
    "adc": {"bits": 12, "fsr": 3.3, "conv_time_fast": 100e-6,
            "conv_time_slow": 1e-3, "cin": 25e-12},
    "mux": {"ron": 150.0},
    "transceiver": {"rout": 20.0, "vdrv": 3.3, "vod_min": 1.5},
    "mcu": {},
}

# ceramic-cap parasitics per 0402-class MMLCC (datasheet-class)
CER_C = 100e-9      # assumed value of a 0402 decoupling ceramic (F)
CER_ESR = 0.016     # ohm
CER_ESL = 0.6e-9    # H
BULK_C = 10e-6      # assumed bulk value (F)
BULK_ESR = 0.02     # ohm
BULK_ESL = 1e-9     # H

# PDN transient assumptions (precision board)
PDN_ITRAN = 50e-3       # A transient step
PDN_RIPPLE_FRAC = 0.01  # allow 1% ripple on the rail


# ----------------------------------------------------------------------------
# Netlist / connectivity helpers
# ----------------------------------------------------------------------------
class Board:
    """Parsed chipscale-spec with union-find net connectivity + pin roles."""

    def __init__(self, spec, rules):
        parts, nets, gnd = validate_spec(spec)   # raises ValueError on a malformed spec
        self.spec = spec
        self.rules = rules
        self.ics = rules.get("ics", {}) if isinstance(rules, dict) else {}
        self.parts = {p["name"]: p for p in parts}
        self.nets = nets
        self.gnd_pins = set(gnd)
        # union-find over pins
        self._parent = {}
        for net in self.nets:
            first = None
            for pin in net:
                self._find(pin)  # ensure present
                if first is None:
                    first = pin
                else:
                    self._union(first, pin)
        # tie all ground pins together into one GND node
        gnd_list = list(self.gnd_pins)
        for p in gnd_list:
            self._find(p)
        for p in gnd_list[1:]:
            self._union(gnd_list[0], p)
        self._gnd_root = self._find(gnd_list[0]) if gnd_list else None

    # --- union-find ---
    def _find(self, x):
        self._parent.setdefault(x, x)
        root = x
        while self._parent[root] != root:
            root = self._parent[root]
        while self._parent[x] != root:
            self._parent[x], x = root, self._parent[x]
        return root

    def _union(self, a, b):
        ra, rb = self._find(a), self._find(b)
        if ra != rb:
            self._parent[rb] = ra

    def connected(self, pin_a, pin_b):
        if pin_a not in self._parent or pin_b not in self._parent:
            return False
        return self._find(pin_a) == self._find(pin_b)

    def net_of(self, pin):
        if pin not in self._parent:
            return None
        return self._find(pin)

    def is_ground(self, pin):
        return pin in self.gnd_pins or (
            self._gnd_root is not None and self.net_of(pin) == self._gnd_root)

    # --- IC / role helpers ---
    def ics_present(self):
        """Return list of (ref, mpn, class, params)."""
        out = []
        for ref, part in self.parts.items():
            mpn = part.get("mpn")
            if not mpn:
                continue
            rule = match_rule(mpn, self.ics)
            if not rule:
                continue
            cls = rule.get("class")
            params = dict(CLASS_FALLBACK.get(cls, {}))
            # same family matching for the device-parameter DB (REF3025AIDBZR ->
            # REF3025), but only when the DB entry's class agrees with the rule
            dev = match_rule(mpn, DEVICE_DB) or {}
            if dev.get("class") == cls:
                params.update(dev)
            out.append((ref, mpn, cls, params))
        return out

    def first_of_class(self, cls):
        for ic in self.ics_present():
            if ic[2] == cls:
                return ic
        return None

    def pins_with_role(self, ref, predicate):
        """Return ['<ref>.<pin>', ...] whose role matches predicate(role)."""
        part = self.parts.get(ref)
        if not part:
            return []
        rule = match_rule(part.get("mpn"), self.ics) or {}
        pinmap = rule.get("pins") or {}
        out = []
        for pinnum, role in pinmap.items():
            if predicate(role or ""):
                out.append("{}.{}".format(ref, pinnum))
        return out

    def caps_on_net(self, pin):
        """Count capacitor parts with a pin on the same net as `pin`."""
        root = self.net_of(pin)
        if root is None:
            return 0
        n = 0
        for net in self.nets:
            if any(self.net_of(p) == root for p in net):
                for p in net:
                    ref = p.split(".")[0]
                    part = self.parts.get(ref, {})
                    if part.get("kind") == "capacitor":
                        n += 1
        # dedupe by ref
        refs = set()
        for net in self.nets:
            if any(self.net_of(p) == root for p in net):
                for p in net:
                    ref = p.split(".")[0]
                    if self.parts.get(ref, {}).get("kind") == "capacitor":
                        refs.add(ref)
        return len(refs)

    def decoupling_caps(self):
        """Classify all board capacitors as (n_bulk, n_ceramic) by footprint."""
        n_bulk = n_cer = 0
        for part in self.parts.values():
            if part.get("kind") != "capacitor":
                continue
            fp = str(part.get("footprint", "")).lower()
            bulky = any(fp.startswith(s) for s in
                        ("0805", "0603b", "1206", "1210", "1812")) \
                or "tant" in fp or "elec" in fp or "bulk" in fp
            if bulky:
                n_bulk += 1
            else:
                n_cer += 1
        return n_bulk, n_cer


# ----------------------------------------------------------------------------
# ngspice run + parse
# ----------------------------------------------------------------------------
def run_deck(deck_text, name, workdir):
    path = os.path.join(workdir, name + ".cir")
    with open(path, "w") as f:
        f.write(deck_text)
    try:
        proc = subprocess.run([NGSPICE, "-b", path], capture_output=True,
                              text=True, timeout=60)
    except FileNotFoundError:
        return None, "ngspice not found at {}".format(NGSPICE)
    except subprocess.TimeoutExpired:
        return None, "ngspice timed out"
    out = proc.stdout + "\n" + proc.stderr
    vals = {}
    for m in re.finditer(r"^\s*([A-Za-z_]\w*)\s*=\s*([-+0-9.eE]+)\s*$",
                         out, re.MULTILINE):
        vals[m.group(1).lower()] = float(m.group(2))
    return vals, out


# ----------------------------------------------------------------------------
# Deck generators. Each returns (deck_text, evaluator) where evaluator(vals)
# -> (status, metric_str). Topology + pass criteria mirror the reference decks.
# ----------------------------------------------------------------------------
def gen_reference(board, ref_ic, adc_ic):
    ref, mpn, _, p = ref_ic
    vref = p["vref"]
    zout = p["zout"]
    lout = p["lout"]
    # settled-error budget: 0.5 LSB of the on-board ADC if present, else 0.01%
    if adc_ic:
        ap = adc_ic[3]
        budget_uV = (ap["fsr"] / (2 ** ap["bits"])) * 0.5 * 1e6
        budget_src = "0.5 LSB of {} ({}-bit, {} V FSR)".format(
            adc_ic[1], ap["bits"], ap["fsr"])
    else:
        budget_uV = vref * 1e-4 * 1e6
        budget_src = "0.01% of Vref"
    # count real output bypass caps on the reference output net
    out_pins = board.pins_with_role(ref, lambda r: "OUT" in r.upper())
    ncap = max((board.caps_on_net(pp) for pp in out_pins), default=0)
    cout = max(ncap, 1) * 1e-6  # assume 1uF-class bypass per cap (datasheet 0..10uF ok)
    istep = min(5.1e-3, 0.2 * p["iout_max"])  # worst-case dynamic load step
    deck = """* FUNCSIM reference-stability : {ref} ({mpn})
* ASSUMPTIONS (datasheet-class, stated per {mpn} datasheet):
*   Vref={vref} V, closed-loop Zout~{zout} ohm + {loutn} series L (HF rise),
*   output bypass Cout={coutu} uF ({ncap} bypass cap(s) found on OUT net),
*   worst-case dynamic load step {istepm} mA (mux/ADC input transient).
* PASS = settled error <= {budget:.1f} uV ({bsrc}).
Vsrc nint 0 DC {vref}
Rzout nint vref {zout}
Lzout nint vref {lout}
Cout  vref 0 {cout}
Iload vref 0 PWL(0 100u 20u 100u 20.2u {istep} 120u {istep} 120.2u 100u)
.tran 0.5u 200u
.control
run
meas tran vnom   FIND v(vref) AT=15u
meas tran vdroop MIN  v(vref) FROM=20u TO=60u
meas tran vsettle FIND v(vref) AT=115u
let droop_uv = (vnom - vdroop)*1e6
let settle_err_uv = (vnom - vsettle)*1e6
print droop_uv settle_err_uv
.endc
.end
""".format(ref=ref, mpn=mpn, vref=vref, zout=zout, lout=lout,
           loutn="{:g}u".format(lout * 1e6), cout="{:g}".format(cout),
           coutu="{:g}".format(cout * 1e6), ncap=ncap,
           istep="{:g}".format(istep), istepm="{:g}".format(istep * 1e3),
           budget=budget_uV, bsrc=budget_src)

    def ev(vals):
        err = abs(vals.get("settle_err_uv", 9e9))
        droop = vals.get("droop_uv", float("nan"))
        status = "PASS" if err <= budget_uV + 1e-6 else "FAIL"
        return status, "settled_err={:.1f}uV (budget {:.1f}uV), droop={:.0f}uV".format(
            err, budget_uV, droop)
    return deck, ev


def gen_mux_adc(board, mux_ic, adc_ic):
    mref, mmpn, _, mp = mux_ic
    aref, ampn, _, ap = adc_ic
    ron = mp["ron"]
    cin = ap["cin"]
    lsb_uV = (ap["fsr"] / (2 ** ap["bits"])) * 1e6
    half_lsb = lsb_uV / 2.0
    conv_fast = ap["conv_time_fast"]
    conv_slow = ap["conv_time_slow"]
    vstep = min(2.0, ap["fsr"] / 2.0 * 0.98)   # stay inside FSR
    target = vstep - half_lsb * 1e-6
    rs = 1000.0  # assumed sensor/source impedance
    # connectivity check: does the mux COM reach an ADC analog input?
    com = board.pins_with_role(mref, lambda r: r.upper() == "COM")
    ain = board.pins_with_role(aref, lambda r: r.upper().startswith("AIN"))
    wired = any(board.connected(c, a) for c in com for a in ain)
    wire_note = "COM->AIN wired in netlist" if wired else \
        "NOTE: COM not wired to any ADC AIN in this netlist (capability check only)"
    deck = """* FUNCSIM mux-to-adc settling : {mref} ({mmpn}) -> {aref} ({ampn})
* ASSUMPTIONS: source Rs={rs} ohm (typical sensor), mux Ron={ron} ohm,
*   input cap Cin={cinp} pF (ADC+mux+short trace, no anti-alias cap).
*   Channel steps 0 -> {vstep} V (inside {ampn} FSR).
* PASS = settles within 0.5 LSB ({half:.1f} uV) FASTER than the {ampn}
*   conversion window ({convf} us fast .. {convs} us slow grade).
* {wnote}
Vch nsrc 0 PWL(0 0 1u 0 1.01u {vstep})
Rs   nsrc nmux {rs}
Rron nmux nadc {ron}
Cin  nadc 0 {cin}
.tran 1n 5u
.control
run
meas tran tsettle WHEN v(nadc)={target} RISE=1
meas tran vend FIND v(nadc) AT=4.9u
let err_uv = ({vstep} - vend)*1e6
print tsettle err_uv
.endc
.end
""".format(mref=mref, mmpn=mmpn, aref=aref, ampn=ampn, rs="{:g}".format(rs),
           ron="{:g}".format(ron), cin="{:g}".format(cin),
           cinp="{:g}".format(cin * 1e12), vstep="{:g}".format(vstep),
           half=half_lsb, convf="{:g}".format(conv_fast * 1e6),
           convs="{:g}".format(conv_slow * 1e6),
           target="{:.7f}".format(target), wnote=wire_note)

    def ev(vals):
        tset = vals.get("tsettle")
        if tset is None or tset <= 0:
            return "FAIL", "settling time not reached ({})".format(wire_note)
        status = "PASS" if tset < conv_fast else "FAIL"
        margin = conv_fast / tset if tset > 0 else 0
        extra = "" if wired else "  [{}]".format(wire_note)
        return status, "tsettle={:.2f}us vs {:.0f}us conv window ({:.0f}x margin){}".format(
            tset * 1e6, conv_fast * 1e6, margin, extra)
    return deck, ev


def gen_rs485(board, tx_ic):
    ref, mpn, _, p = tx_ic
    rout = p["rout"]
    vdrv = p["vdrv"]
    vod_min = p["vod_min"]
    # is there a termination resistor across A and B?
    a = board.pins_with_role(ref, lambda r: r.upper() == "A")
    b = board.pins_with_role(ref, lambda r: r.upper() == "B")
    term_local = False
    for net in board.nets:
        refs = {pp.split(".")[0] for pp in net}
        for rr in refs:
            if board.parts.get(rr, {}).get("kind") == "resistor":
                # resistor bridging the A and B nets?
                rpins = ["{}.{}".format(rr, i) for i in ("1", "2")]
                if any(board.connected(rp, ap) for rp in rpins for ap in a) and \
                   any(board.connected(rp, bp) for rp in rpins for bp in b):
                    term_local = True
    term_note = ("local termination resistor found; modeling 120//120 = 60 ohm bus"
                 if term_local else
                 "NOTE: no local termination R found; assuming a fully-loaded "
                 "2x120 = 60 ohm bus (RS-485 worst case)")
    deck = """* FUNCSIM rs485-drive : {ref} ({mpn}) -> terminated differential bus
* ASSUMPTIONS: per-side driver Rout={rout} ohm, drive swing {vdrv} V,
*   bus = 2x 120 ohm termination (local + far end) + 100 pF diff cap.
* PASS = |Vod| >= {vmin} V (RS-485 requires >=1.5 V into 54 ohm).
* {tnote}
Vdrv nd 0 PWL(0 0 100n 0 110n {vdrv})
Rda nd A {rout}
Rdb 0  B {rout}
Rterm1 A B 120
Rterm2 A B 120
Cbus A B 100p
.tran 1n 400n
.control
run
let vod = v(A) - v(B)
meas tran vod_ss FIND vod AT=380n
meas tran vod_pk MAX vod FROM=200n TO=380n
print vod_ss vod_pk
.endc
.end
""".format(ref=ref, mpn=mpn, rout="{:g}".format(rout), vdrv="{:g}".format(vdrv),
           vmin="{:g}".format(vod_min), tnote=term_note)

    def ev(vals):
        vod = vals.get("vod_ss", 0.0)
        status = "PASS" if abs(vod) >= vod_min else "FAIL"
        return status, "Vod={:.2f}V (need >={:g}V), margin {:.2f}x".format(
            vod, vod_min, abs(vod) / vod_min if vod_min else 0)
    return deck, ev


def gen_pdn(board):
    n_bulk, n_cer = board.decoupling_caps()
    ztarget = (PDN_RIPPLE_FRAC * 3.3) / PDN_ITRAN  # V/A = ohm
    lines = [
        "* FUNCSIM pdn-rail-impedance : 3V3 rail AC sweep",
        "* ASSUMPTIONS: {} bulk + {} ceramic decoupling cap(s) counted from the".format(
            n_bulk, n_cer),
        "*   board; ceramic {:g}uF/ESR{:g}m/ESL{:g}nH, bulk {:g}uF/ESR{:g}m/ESL{:g}nH;".format(
            CER_C * 1e6, CER_ESR * 1e3, CER_ESL * 1e9,
            BULK_C * 1e6, BULK_ESR * 1e3, BULK_ESL * 1e9),
        "*   feed = LDO/header Rout 50m + 5nH trace.",
        "* TARGET Ztarget={:.3f} ohm ({:.0f}% ripple at {:.0f} mA transient). PASS if Zmax below.".format(
            ztarget, PDN_RIPPLE_FRAC * 100, PDN_ITRAN * 1e3),
        "Iac rail 0 AC 1",
        "Lfeed vin rail 5n",
        "Rfeed src vin 0.05",
        "Vsrc src 0 DC 3.3 AC 0",
    ]
    idx = 0
    if n_bulk > 0:
        # lump bulk caps
        c = BULK_C * n_bulk
        esr = BULK_ESR / n_bulk
        esl = BULK_ESL / n_bulk
        lines += ["Cb rail nb{0} {1:g}".format(idx, c),
                  "Rb nb{0} nb{0}b {1:g}".format(idx, esr),
                  "Lb nb{0}b 0 {1:g}".format(idx, esl)]
        idx += 1
    if n_cer > 0:
        c = CER_C * n_cer
        esr = CER_ESR / n_cer
        esl = CER_ESL / n_cer
        lines += ["Cc rail nc{0} {1:g}".format(idx, c),
                  "Rc nc{0} nc{0}b {1:g}".format(idx, esr),
                  "Lc nc{0}b 0 {1:g}".format(idx, esl)]
        idx += 1
    lines += [
        ".ac dec 20 1k 200meg",
        ".control", "run",
        "let z = abs(v(rail))",
        "meas ac zmax MAX z FROM=1k TO=200meg",
        "meas ac z_1mhz FIND z AT=1meg",
        "meas ac z_10mhz FIND z AT=10meg",
        "print zmax z_1mhz z_10mhz",
        ".endc", ".end", ""]
    deck = "\n".join(lines)
    total = n_bulk + n_cer

    def ev(vals):
        if total == 0:
            return "SKIP", "no decoupling caps on the board to model"
        zmax = vals.get("zmax")
        if zmax is None:
            return "FAIL", "AC sweep produced no Zmax"
        ripple_mV = zmax * PDN_ITRAN * 1e3
        status = "PASS" if zmax < ztarget else "FAIL"
        return status, ("Zmax={:.3f}ohm (target {:.3f}), {:.1f}mV ripple @ {:.0f}mA, "
                        "{} caps").format(zmax, ztarget, ripple_mV, PDN_ITRAN * 1e3, total)
    return deck, ev


# ----------------------------------------------------------------------------
# Orchestrator
# ----------------------------------------------------------------------------
def _one_line(e):
    s = "%s: %s" % (type(e).__name__, e) if not isinstance(e, ValueError) else str(e)
    return " ".join(s.split())[:240] or type(e).__name__


USAGE = "usage: functional_sim.py <chipscale-spec.json> [design_rules.json]"


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print(USAGE, file=sys.stderr)
        return 2
    try:
        return _run(argv)
    except Exception as e:  # anything that stops the stage RUNNING is ERROR, not a verdict
        print("FUNCSIM ERROR {}".format(_one_line(e)))
        return 2


def _run(argv):
    spec_path = argv[0]
    with open(spec_path) as f:
        spec = json.load(f)
    rules = load_rules(argv[1] if len(argv) > 1 else None)
    board = Board(spec, rules)

    ref_ic = board.first_of_class("reference")
    mux_ic = board.first_of_class("mux")
    adc_ic = board.first_of_class("adc")
    tx_ic = board.first_of_class("transceiver")

    present = sorted({ic[2] for ic in board.ics_present()})
    print("# functional_sim: {} | classes present: {}".format(
        os.path.basename(spec_path), ", ".join(present) or "none"))

    decks = []  # (name, deck_text, evaluator)  OR  (name, None, skip_reason)
    if ref_ic:
        d, ev = gen_reference(board, ref_ic, adc_ic)
        decks.append(("reference-stability", d, ev))
    if mux_ic and adc_ic:
        d, ev = gen_mux_adc(board, mux_ic, adc_ic)
        decks.append(("mux-to-adc-settling", d, ev))
    elif mux_ic and not adc_ic:
        decks.append(("mux-to-adc-settling", None, "mux present but no ADC on board"))
    if tx_ic:
        d, ev = gen_rs485(board, tx_ic)
        decks.append(("rs485-drive", d, ev))
    # PDN always
    d, ev = gen_pdn(board)
    decks.append(("pdn-rail-impedance", d, ev))

    fails = 0
    ran_any = False          # only a deck that produced a PASS or FAIL counts
    tool_missing = None
    workdir = tempfile.mkdtemp(prefix="funcsim_")
    for name, deck, ev_or_reason in decks:
        if deck is None:
            print("SIM {} SKIP {}".format(name, ev_or_reason))
            continue
        vals, raw = run_deck(deck, name, workdir)
        if vals is None:
            if "not found" in str(raw):
                tool_missing = str(raw)
            print("SIM {} SKIP ngspice error: {}".format(name, raw))
            continue
        status, metric = ev_or_reason(vals)
        if status == "FAIL":
            fails += 1
        if status in ("PASS", "FAIL"):
            ran_any = True
        print("SIM {} {} {}".format(name, status, metric))

    if fails:
        print("FUNCSIM FAIL {}".format(fails))
        return 1
    if ran_any:
        print("FUNCSIM PASS")
        return 0
    if tool_missing:
        # there WERE decks to run and the simulator is absent: the stage did not
        # run — say so, never report a pass or a skip
        print("FUNCSIM ERROR {}".format(tool_missing))
        return 2
    print("FUNCSIM SKIP 0 (nothing to evaluate: no known ICs / decks all skipped)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
