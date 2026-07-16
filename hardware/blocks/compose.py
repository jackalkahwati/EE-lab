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
import math
import os
import re
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import resolve_part  # general KiCad-library part resolver
import source_part   # DigiKey -> datasheet -> resolved part (cache-first)

# Phase 5b: overridable so part resolution isn't welded to a Mac-local KiCad
# install (registry-served footprints already bypass this for catalog parts)
FP = os.environ.get(
    "FL_KICAD_FOOTPRINTS",
    "/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints")


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

# Netlist accumulator (design-path merger): every place() records its
# (ref, footprint, pad->net map) here so the SAME synth run that emits the
# .kicad_pcb can also export a run_board-style {parts, nets, gnd} netlist —
# reusing synth's real MCU allocation + bus matching instead of a second,
# independent LLM part-set guess. synth.netlist_from_design() resets + reads it.
_NETLIST = []

# Pre-routed block templates (density program): frozen internal copper per
# block key, produced by freeze_routes.py running the block in isolation
# through the REAL router + DRC. At compose time the template is transposed
# to the block's placed origin and emitted as real segments/vias — flroute
# sees them as net-owned obstacles (v5 wiring cells), skips those nets, and
# import_ses restores them from the .preroute.json sidecar after the SES
# import wipes tracks. Whole-board DRC re-verifies the frozen copper in
# context on every board — templates are trusted to route, never to pass.
_ROUTES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "routes")
_PREROUTED = []   # sidecar entries (absolute mm) accumulated per board
_PREROUTED_NETS = []


def _route_template(key):
    p = os.path.join(_ROUTES_DIR, key + ".json")
    try:
        return json.load(open(p))
    except Exception:
        return None


def emit_frozen_routes(key, bx, by, nets):
    """Emit a block's frozen internal copper transposed to its placed origin.
    Returns board-file sexprs; also records sidecar entries + net names."""
    tpl = _route_template(key)
    if not tpl:
        return ""
    out = []
    for net_name, geo in tpl.get("nets", {}).items():
        nid = nets.id(net_name)
        entry = {"net": net_name, "width_mm": geo.get("width_mm", 0.25),
                 "segments_mm": [], "vias_mm": []}
        for seg in geo.get("segments_mm", []):
            x0, y0, x1, y1 = (round(seg[0] + bx, 4), round(seg[1] + by, 4),
                              round(seg[2] + bx, 4), round(seg[3] + by, 4))
            layer = seg[4] if len(seg) > 4 else "F.Cu"
            width = seg[5] if len(seg) > 5 else geo.get("width_mm", 0.25)
            out.append('  (segment (start {} {}) (end {} {}) (width {}) '
                       '(layer "{}") (net {}) (uuid "{}"))\n'.format(
                           x0, y0, x1, y1, width, layer, nid, U()))
            entry["segments_mm"].append([x0, y0, x1, y1, layer, width])
        for v in geo.get("vias_mm", []):
            vx, vy = round(v[0] + bx, 4), round(v[1] + by, 4)
            out.append('  (via (at {} {}) (size 0.4) (drill 0.2) '
                       '(layers "F.Cu" "B.Cu") (net {}) (uuid "{}"))\n'.format(
                           vx, vy, nid, U()))
            entry["vias_mm"].append([vx, vy])
        if entry["segments_mm"] or entry["vias_mm"]:
            _PREROUTED.append(entry)
            if net_name not in _PREROUTED_NETS:
                _PREROUTED_NETS.append(net_name)
    return "".join(out)


# Occupancy registry: the real courtyard box (mm, board coords) of every
# footprint place() has emitted for the current board. The fiducials are added
# AFTER every component, so they have to be able to see what is already there —
# without this they were dropped at fixed coordinates and landed on top of parts
# (FID1 inside U1's courtyard on the presence-sensor board). compose()/synth()
# reset it per board.
_PLACED = []


def _upgrade_mod(text, name):
    """easyeda2kicad emits legacy '(module ...)' footprints; pcbnew 10 refuses
    to load a board embedding them. Convert with the OFFICIAL converter
    (kicad-cli fp upgrade) — hand-porting the grammar was tried and rejected
    by the parser. Then strip file-level tokens (version/generator have no
    place inside a board) and pin the reference to REF** for place()."""
    if text.lstrip().startswith("(module"):
        import subprocess as _usp
        import tempfile as _utf
        with _utf.TemporaryDirectory(suffix=".pretty") as d:
            p = os.path.join(d, "%s.kicad_mod" % re.sub(r"[^\w.-]", "_", name))
            open(p, "w").write(text)
            kcli = os.environ.get(
                "FL_KICAD_CLI", "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli")
            _usp.run([kcli, "fp", "upgrade", d], capture_output=True, timeout=60)
            text = open(p).read()
        if text.lstrip().startswith("(module"):
            raise RuntimeError("kicad-cli fp upgrade did not modernize footprint %s" % name)
    text = re.sub(r"\s*\(version [^)]*\)", "", text, count=1)
    text = re.sub(r'\s*\(generator(_version)? "[^"]*"\)', "", text)
    text = re.sub(r'\(property "Reference" "[^"]*"', '(property "Reference" "REF**"',
                  text, count=1)
    text = re.sub(r'\(fp_text\s+reference\s+(?:"[^"]*"|\S+)',
                  '(fp_text reference "REF**"', text, count=1)
    return text


def _load(lib, name):
    key = (lib, name)
    if key not in _cache:
        if lib == "registry":
            # shared part registry footprint (LCSC id) — real pad geometry
            # fetched by easyeda2kicad and cached for every later build
            sys.path.insert(0, os.path.join(
                os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                "tools", "parts"))
            import registry as _reg
            e = _reg.get(name)
            if not (e and e.get("kicad_mod")):
                raise RuntimeError("registry has no footprint for %s" % name)
            _cache[key] = _upgrade_mod(e["kicad_mod"], name)
        else:
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
    # record this placement for the netlist exporter (merger). Store the raw
    # library ref + the pad->net map; the exporter loads real pad geometry from
    # lib/name and derives the two-point nets from the maps.
    _NETLIST.append({"ref": ref, "lib": lib, "name": name, "netmap": dict(netmap)})
    # record the real occupied area too, so anything placed LATER (the fiducials)
    # can be put in genuinely free space instead of on top of a part.
    _PLACED.append({"ref": ref, "box": courtyard_box(lib, name, x, y, rot)})
    return "  " + t.strip() + "\n"


# ---- real courtyard geometry ------------------------------------------------
# The placement gate scores a footprint by its F.CrtYd courtyard, which is NOT
# the same as its body and is NOT centred on its origin (an ESP32-S3-WROOM-1's
# courtyard carries the antenna keepout, so it reaches 27mm one side of the
# origin and 20mm the other). Anything that needs to know where a part really
# sits has to read that geometry from the library, not estimate it.
_CRTYD_PT = re.compile(r"\((?:start|end|xy|center|mid)\s+(-?[\d.]+)\s+(-?[\d.]+)\)")


def _subexprs(text, head):
    """Yield each balanced top-level '(head...)' sub-expression of a .kicad_mod."""
    i = 0
    while True:
        i = text.find("(" + head, i)
        if i < 0:
            return
        depth, j = 0, i
        while j < len(text):
            if text[j] == "(":
                depth += 1
            elif text[j] == ")":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        yield text[i:j + 1]
        i = j + 1


_crtyd_cache = {}


def courtyard_rel(lib, name):
    """(x0, y0, x1, y1) F.CrtYd bounding box of a library footprint in mm,
    RELATIVE to the footprint origin, read from the same .kicad_mod text place()
    emits. Falls back to the pad bbox when a footprint carries no courtyard."""
    key = (lib, name)
    if key in _crtyd_cache:
        return _crtyd_cache[key]
    t = _load(lib, name)
    xs, ys = [], []
    stroke = 0.0
    for head in ("fp_line", "fp_rect", "fp_poly", "fp_circle", "fp_arc"):
        for e in _subexprs(t, head):
            if "F.CrtYd" not in e:
                continue
            w = re.search(r"\(width\s+([\d.]+)\)", e)
            if w:
                # pcbnew's courtyard bbox is the STROKED outline, so the drawn
                # line's width counts; take it in or the box reads ~0.05mm small.
                stroke = max(stroke, float(w.group(1)))
            pts = [(float(a), float(b)) for a, b in _CRTYD_PT.findall(e)]
            if e.startswith("(fp_circle") and len(pts) >= 2:
                # (center cx cy) (end ex ey): the end point is ON the circle
                (cx, cy), (ex, ey) = pts[0], pts[1]
                r = ((ex - cx) ** 2 + (ey - cy) ** 2) ** 0.5
                pts = [(cx - r, cy - r), (cx + r, cy + r)]
            for px, py in pts:
                xs.append(px)
                ys.append(py)
    if not xs:                                  # no courtyard -> use the pads
        for e in _subexprs(t, "pad"):
            m = re.search(r"\(at\s+(-?[\d.]+)\s+(-?[\d.]+)", e)
            s = re.search(r"\(size\s+(-?[\d.]+)\s+(-?[\d.]+)\)", e)
            if not m:
                continue
            px, py = float(m.group(1)), float(m.group(2))
            hw = float(s.group(1)) / 2 if s else 0.0
            hh = float(s.group(2)) / 2 if s else 0.0
            xs += [px - hw, px + hw]
            ys += [py - hh, py + hh]
    s = stroke                                  # 0 on the pad fallback (no stroke)
    box = ((min(xs) - s, min(ys) - s, max(xs) + s, max(ys) + s) if xs
           else (0.0, 0.0, 0.0, 0.0))
    _crtyd_cache[key] = box
    return box


def courtyard_box(lib, name, x, y, rot=0):
    """The footprint's real courtyard bbox in BOARD coordinates once placed at
    (x, y, rot). Rotation is applied to the relative box's corners and re-boxed,
    which is what KiCad's own bbox does (a conservative superset for non-90s)."""
    x0, y0, x1, y1 = courtyard_rel(lib, name)
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    if rot:
        a = math.radians(rot)                   # KiCad: CCW positive, y grows down
        ca, sa = math.cos(a), math.sin(a)
        corners = [(px * ca + py * sa, -px * sa + py * ca) for px, py in corners]
    xs = [x + px for px, _ in corners]
    ys = [y + py for _, py in corners]
    return (min(xs), min(ys), max(xs), max(ys))


def free_spots(targets, fp_box, x0, y0, bw, bh, n=3, clear=1.0, edge=3.5,
               apart=10.0, within=None):
    """Find <= n placements for a part whose courtyard is `fp_box` (relative, from
    courtyard_rel) that are REALLY free: clear of every courtyard place() has
    already emitted, inside the board with `edge` mm to the outline, and `apart`
    mm from each other. Each target is a preferred (x, y); the nearest free point
    to it is taken by an outward ring search. `within` = (cx, cy, r) constrains
    every accepted spot to r mm of (cx, cy) — for parts whose position IS their
    function (a mounting hole far from its corner is structurally useless).
    Returns the spots actually found — it never returns a colliding one, so a
    caller that gets fewer than it asked for has a genuinely full board (or
    region) and must say so rather than stack parts."""
    fx0, fy0, fx1, fy1 = fp_box
    taken = []

    def ok(px, py):
        if within is not None and ((px - within[0]) ** 2 + (py - within[1]) ** 2
                                   > within[2] ** 2):
            return False
        bx0, by0 = px + fx0 - clear, py + fy0 - clear
        bx1, by1 = px + fx1 + clear, py + fy1 + clear
        if not (x0 + edge <= px + fx0 and px + fx1 <= x0 + bw - edge
                and y0 + edge <= py + fy0 and py + fy1 <= y0 + bh - edge):
            return False
        for p in _PLACED:
            ox0, oy0, ox1, oy1 = p["box"]
            if bx0 < ox1 and ox0 < bx1 and by0 < oy1 and oy0 < by1:
                return False
        return all((px - tx) ** 2 + (py - ty) ** 2 >= apart ** 2 for tx, ty in taken)

    for tx, ty in targets:
        if len(taken) >= n:
            break
        hit = None
        for r in [i * 0.5 for i in range(0, int(max(bw, bh) / 0.5) + 1)]:
            cand = [(tx, ty)] if r == 0 else []
            steps = max(8, int(r * 4))
            for k in range(steps):                       # ring of radius r
                th = 2 * math.pi * k / steps
                cand.append((round(tx + r * math.cos(th), 2),
                             round(ty + r * math.sin(th), 2)))
            for px, py in cand:
                if ok(px, py):
                    hit = (px, py)
                    break
            if hit:
                break
        if hit:
            taken.append(hit)
    return taken


def place_mounting_holes(X0, Y0, BW, BH, nets, inset=7.0, region=15.0):
    """4x M3 corner mounting holes (Phase 15.6 role primitive), collision-aware.
    The corners are the PREFERRED spots — that is their mechanical purpose — but
    the corner margin band is only a preference: a part's real courtyard can
    legally reach into it, and the old fixed 7mm insets put H2 inside J2's
    courtyard on the default power/mcu/radio/antenna mix. Each hole gets the
    same courtyard-occupancy search as the fiducials, confined to `region` mm
    of its corner (a hole far from a corner is structurally useless). If a
    corner region is genuinely full the hole is DROPPED and reported honestly —
    never stacked on a part. Emits via place(), so the holes land in _PLACED
    and everything placed later (test points, fiducials) sees them."""
    hole_box = courtyard_rel("MountingHole", "MountingHole_3.2mm_M3")
    body = ""
    placed = 0
    for cx, cy, sx, sy in ((X0, Y0, 1, 1), (X0 + BW, Y0, -1, 1),
                           (X0, Y0 + BH, 1, -1), (X0 + BW, Y0 + BH, -1, -1)):
        # clear=0.4 (not the fiducial default 1.0): the M3 screw head + washer
        # keepout already lives INSIDE the hole's own ±3.5mm courtyard (the
        # placement gate's HOLE_KEEPOUT is 3.5mm from the hole CENTER), so any
        # non-overlapping neighbor is already screw-safe. 0.4 is dfm_check's
        # CY_GAP_MM courtyard-to-courtyard rule — smaller would place holes the
        # DFM gate then rejects, and the fiducial 1.0 was dropping corner holes
        # both gates allow (an ESP32-class antenna courtyard leaves exactly
        # 0.45mm at the preferred corner inset on real boards).
        spot = free_spots([(cx + sx * inset, cy + sy * inset)], hole_box,
                          X0, Y0, BW, BH, n=1, clear=0.4,
                          within=(cx, cy, region))
        if not spot:
            continue
        placed += 1
        body += place("MountingHole", "MountingHole_3.2mm_M3", "H%d" % placed,
                      spot[0][0], spot[0][1], 0, {}, nets)
    if placed < 4:
        # honest: mirror the FIDUCIALS shortfall report — fewer holes beats a
        # hole overlapping a part.
        print("MOUNTING: only %d of 4 holes placed — no free corner area on "
              "the %sx%smm board" % (placed, BW, BH))
    return body


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


def _set_value(fp_text, value):
    """Capture a real electrical value at design time by writing it into the
    footprint's Value property. It rides through renumber_duplicate_refs (which
    only rewrites Reference), and lets classify_role tell bulk from decoupling.
    Use ASCII 'u' for microfarads ('10uF') so that regex matches."""
    if not value:
        return fp_text
    return re.sub(r'(\(property "Value" ")[^"]*(")',
                  lambda m: m.group(1) + value + m.group(2), fp_text, count=1)


def cap(ref, x, y, a, b, nets, value="100nF"):
    """0402 cap between nets a and b. Default 100nF = the standard decoupling
    value (real design intent for a 0402 bypass cap); pass value= for bulk or
    filter caps, e.g. cap(..., value="10uF")."""
    return _set_value(place("Capacitor_SMD", "C_0402_1005Metric", ref, x, y, 0,
                            {"1": a, "2": b}, nets), value)


def res(ref, x, y, a, b, nets, value=None):
    """0402 resistor between nets a and b. Pass value= (e.g. "4.7k") to capture
    the real value — resistors have no universal default, so an unspecified one
    stays unlabeled rather than guessing."""
    return _set_value(place("Resistor_SMD", "R_0402_1005Metric", ref, x, y, 0,
                            {"1": a, "2": b}, nets), value)


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


# ---- MCU profiles -----------------------------------------------------------
# Role-keyed pin maps per MCU family (Phase: multi-MCU). Each profile maps the
# module's PHYSICAL pad number -> the interface-net role it carries; a role is
# wired only when a peripheral allocated that net (no dangling stubs). The
# ESP32-C3 map was read from KiCad's shipped ESP32-C3-WROOM-02 symbol (real
# pin names), not from memory.
MCU_PROFILES = {
    "pico": {
        "label": "RP2040 (Raspberry Pi Pico module)",
        "footprint": ("Module", "RaspberryPi_Pico_SMD_HandSolder"),
        "family": "rp2040",
        "roles": {
            "4": "spi_sck", "5": "spi_mosi", "6": "spi_miso", "7": "spi_cs",
            "9": "ctrl_rst", "10": "ctrl_irq", "11": "i2c_sda", "12": "i2c_scl",
            "14": "mot1", "15": "mot2", "16": "mot3", "17": "mot4",
            "1": "uart_gps_tx", "2": "uart_gps_rx",          # UART0 -> GNSS
            "19": "uart_cell_tx", "20": "uart_cell_rx",      # UART1 -> cellular modem
            "21": "cell_pwrkey", "22": "cell_rst",           # modem power control
            "24": "can_txd", "25": "can_rxd",                # CAN comms head
            "26": "step", "27": "dir", "29": "en",           # stepper motion controller
            "31": "fault", "32": "interlock", "34": "trig",  # FL-1 bus safety/sync lines
        },
    },
    "esp32c3": {
        "label": "ESP32-C3-WROOM-02 (WiFi + BLE module)",
        "footprint": ("RF_Module", "ESP32-C3-WROOM-02"),
        "family": "esp32c3",
        # pads per the KiCad symbol: 1=3V3 2=EN 3=IO4 4=IO5 5=IO6 6=IO7 7=IO8
        # 8=IO9 9=GND 10=IO10 11=IO20/RXD 12=IO21/TXD 13=IO18 14=IO19 15=IO3
        # 16=IO2 17=IO1 18=IO0 19=GND. Straps (EN, IO9, IO8) are kept off the
        # role map and handled by the block. Conflicting roles are resolved by
        # absence, same convention as the Pico map.
        "roles": {
            "5": "i2c_sda", "6": "i2c_scl",                  # IO6 / IO7
            "3": "spi_sck", "4": "spi_mosi",                 # IO4 / IO5
            "10": "spi_miso", "15": "spi_cs",                # IO10 / IO3
            "18": "uart_gps_tx", "17": "uart_gps_rx",        # IO0 / IO1 (UART1)
            "16": "audio_pwm",                               # IO2 (PWM-capable)
            "13": "ctrl_irq", "14": "ctrl_rst",              # IO18 / IO19
        },
    },
}


def block_mcu_pico(x, y, n, nets):
    """RP2040 (Pico module). 5V -> VSYS/VBUS; provides 3V3OUT to peripherals.
    Buses are wired only where a peripheral actually uses them: the pin map is
    built from whichever interface nets `n` carries (SPI for a radio, I2C for a
    sensor, PWM for motors), so the MCU has no dangling stub nets."""
    # physical Pico pin -> the interface-net key it carries (mapped only if present)
    opt = dict(MCU_PROFILES["pico"]["roles"])
    # pin-sharing role primitives: these reuse pins whose primary block is absent
    # on FL-1 core boards (documented conflict, resolved by absence):
    if "gp_a" in n and "mot1" not in n:                  # GPIO bank vs motors
        opt.update({"14": "gp_a", "15": "gp_b", "16": "gp_c", "17": "gp_d"})
    if "rst_out" in n and "step" not in n:               # RESET line vs stepper EN
        opt["29"] = "rst_out"
    if "sr_oe" in n and "cell_rst" not in n:             # relay OE gate vs modem reset
        opt["22"] = "sr_oe"
    if "audio_pwm" in n and "fault" not in n:            # audio PWM/EN vs FL-1 bus
        opt["31"] = "audio_pwm"                          # GP26 (PWM-capable)
        opt["32"] = "amp_en"                             # GP27
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
        b += res("R10", x + 26, y + 38, n["i2c_sda"], "+3V3", nets, value="4.7k")
        b += res("R11", x + 26, y + 44, n["i2c_scl"], "+3V3", nets, value="4.7k")
    _DEVICES.append({"ref": "U1", "type": "mcu", "family": "rp2040"})
    return b, 30, 56


def keepout_zone(x0, y0, x1, y1, layer="F.Cu"):
    """Copper/zone keep-out rectangle (antenna clearance). Tracks, vias, pads
    and pours are all excluded — the region must stay copper-free for the
    module's antenna to radiate."""
    pts = "(xy {} {}) (xy {} {}) (xy {} {}) (xy {} {})".format(x0, y0, x1, y0, x1, y1, x0, y1)
    return ('  (zone (net 0) (net_name "") (layers "F.Cu" "B.Cu") (uuid "{}")\n'
            '    (hatch edge 0.5)\n'
            '    (keepout (tracks not_allowed) (vias not_allowed) (pads not_allowed)'
            ' (copperpour not_allowed) (footprints allowed))\n'
            '    (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))\n'
            '    (polygon (pts {}))\n'
            '  )\n').format(U(), pts)


def block_mcu_esp32c3(x, y, n, nets):
    """ESP32-C3-WROOM-02 — WiFi + BLE MCU module (KiCad-shipped symbol +
    footprint; pin map read from the real symbol, not memory). The module's
    integrated PCB antenna needs a copper keep-out beyond its top edge, which
    this block emits; the antenna-FDTD sim gate grades the board as its
    counterpoise. Straps per datasheet: EN via 10k/100nF RC, IO9 pulled up
    (boot-from-flash); flashing over the UART0 header (3V3 GND TX RX EN IO9).
    Firmware for this family lands with the ESP-IDF target; until then the
    firmware stage reports the gap honestly instead of emitting Pico code."""
    prof = MCU_PROFILES["esp32c3"]
    # antenna keep-out: the WROOM-02 antenna occupies the module's top ~6.5 mm;
    # keep copper away above and beside it
    ka_h = 8.0
    b = keepout_zone(x - 2, y - 2, x + 22, y + ka_h)
    pmap = {"1": "+3V3", "9": "GND", "19": "GND", "2": "C3_EN", "8": "C3_IO9"}
    opt = dict(prof["roles"])
    if "amp_en" in n and "spi_miso" not in n:  # IO10: audio enable vs SPI MISO
        opt["10"] = "amp_en"
    for pin, key in opt.items():
        if key in n:
            pmap[pin] = n[key]
    # UART0 pads route to the flash header so esptool can always program it
    pmap["12"] = "C3_TXD"
    pmap["11"] = "C3_RXD"
    lib, fp = prof["footprint"]
    # module body ~13.2 x 19.2 mm; antenna end points UP into the keep-out
    b += place(lib, fp, "U1", x + 10, y + ka_h + 10, 0, pmap, nets)
    b += cap("C2", x + 24, y + ka_h + 4, "+3V3", "GND", nets)      # bulk 10uF slot
    b += cap("C3", x + 24, y + ka_h + 12, "+3V3", "GND", nets)     # 100nF
    # EN reset RC (10k to 3V3, 100nF to GND) + IO9 boot-strap pull-up (10k)
    b += res("R10", x + 24, y + ka_h + 20, "C3_EN", "+3V3", nets, value="10k")
    b += cap("C4", x + 24, y + ka_h + 28, "C3_EN", "GND", nets)
    b += res("R11", x + 24, y + ka_h + 36, "C3_IO9", "+3V3", nets, value="10k")
    # I2C bus pull-ups when the board carries an I2C bus (bus master owns them)
    if "i2c_sda" in n:
        b += res("R12", x + 30, y + ka_h + 20, n["i2c_sda"], "+3V3", nets, value="4.7k")
        b += res("R13", x + 30, y + ka_h + 28, n["i2c_scl"], "+3V3", nets, value="4.7k")
    # UART0 flash/console header: 3V3 GND TXD RXD EN IO9
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x06_P2.54mm_Vertical",
               "J10", x + 36, y + ka_h + 14, 0,
               {"1": "+3V3", "2": "GND", "3": "C3_TXD", "4": "C3_RXD",
                "5": "C3_EN", "6": "C3_IO9"}, nets)
    label("FLASH 3V3 G TX RX EN IO9", x + 36, y + ka_h + 8, 0.6)
    label("ANTENNA KEEP-OUT", x + 4, y + 3, 0.7)
    _DEVICES.append({"ref": "U1", "type": "mcu", "family": "esp32c3",
                     "name": "ESP32-C3-WROOM-02",
                     "radio": "wifi+ble (module, integrated antenna)"})
    return b, 44, ka_h + 48


# CM4 pin groups — parsed DETERMINISTICALLY from the official datasheet's pin
# table (tools: cm4 pin parse, anchors cross-checked: GPIO2=58, GPIO14=55,
# nRPIBOOT=93, USB_P=105) and the footprint is the official CM4IO reference
# design's, stored in the shared registry. Never from memory.
_CM4_GND = [1, 2, 7, 8, 13, 14, 22, 23, 32, 33, 42, 43, 52, 53, 59, 60, 65, 66,
            71, 74, 98, 107, 108, 113, 114, 119, 120, 125, 126, 131, 132, 137,
            138, 144, 150, 155, 156, 161, 162, 167, 168, 173, 174, 179, 180,
            185, 186, 191, 192, 197, 198]
_CM4_5V = [77, 79, 81, 83, 85, 87]


def block_som_carrier(x, y, n, nets):
    """Raspberry Pi CM4 carrier — the SoM strategy: the SoC/DRAM/PMIC live on
    the certified module; this block designs the CARRIER around it. Official
    CM4IO footprint (200 pads = datasheet numbering) from the registry.
    Curated v1 surface: 5V power-in, console UART header, shared I2C, USB 2.0
    device header (rpiboot flashing + gadget mode), nRPIBOOT jumper and
    GLOBAL_EN power-control jumper. Everything else is honestly NC — the pin
    table is in the registry for the next capability rung. Linux image
    generation is a future firmware target; the firmware stage skips this
    family loudly rather than emitting MCU code."""
    pmap = {str(p): "GND" for p in _CM4_GND}
    pmap.update({str(p): "+5V" for p in _CM4_5V})
    pmap.update({
        "55": "CM4_TX", "51": "CM4_RX",          # GPIO14/15 console UART
        "105": "USB_DP", "103": "USB_DN",        # USB 2.0 (device for rpiboot)
        "93": "NRPIBOOT", "99": "GLOBAL_EN_J",
    })
    if "i2c_sda" in n:
        pmap["58"] = n["i2c_sda"]                # GPIO2 / SDA1
        pmap["56"] = n["i2c_scl"]                # GPIO3 / SCL1
    # The official footprint's anchor is NOT the module centroid: its local
    # extents (measured from the registry copy, rot 0) are dx -3.6..+36.6,
    # dy -51.6..+3.6 mm. Rotated 90 CCW a local (dx,dy) maps to (dy,-dx), so
    # the 40x55 body becomes 55 wide x 40 tall spanning anchor-51.6..+3.6 in x
    # and anchor-36.6..+3.6 in y — anchor below-right of the body.
    uref = _next_ref("U")
    b = place("registry", "CM4", uref, x + 53.6, y + 40.6, 90, pmap, nets)
    # bulk input capacitance on the 5V feed (module pulls amps at boot)
    b += cap(_next_ref("C"), x + 62, y + 6, "+5V", "GND", nets, value="22uF")
    b += cap(_next_ref("C"), x + 62, y + 12, "+5V", "GND", nets, value="22uF")
    # console UART header: 3V3-level TTL (GND TX RX)
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x03_P2.54mm_Vertical",
               _next_ref("J"), x + 74, y + 8, 0,
               {"1": "GND", "2": "CM4_TX", "3": "CM4_RX"}, nets)
    label("CONSOLE G TX RX", x + 74, y + 3, 0.6)
    # USB 2.0 header (D+ D- 5V GND) — rpiboot flashing + gadget mode
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x04_P2.54mm_Vertical",
               _next_ref("J"), x + 74, y + 18, 0,
               {"1": "+5V", "2": "USB_DN", "3": "USB_DP", "4": "GND"}, nets)
    label("USB 5V D- D+ G", x + 74, y + 13, 0.6)
    # nRPIBOOT jumper (short to GND -> USB boot for flashing) + GLOBAL_EN
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x02_P2.54mm_Vertical",
               _next_ref("J"), x + 74, y + 30, 0, {"1": "NRPIBOOT", "2": "GND"}, nets)
    label("nRPIBOOT", x + 74, y + 26, 0.6)
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x02_P2.54mm_Vertical",
               _next_ref("J"), x + 74, y + 38, 0, {"1": "GLOBAL_EN_J", "2": "GND"}, nets)
    label("GLOBAL_EN", x + 74, y + 34, 0.6)
    _DEVICES.append({"ref": uref, "type": "mcu", "family": "cm4",
                     "name": "Raspberry Pi Compute Module 4 (SoM carrier)",
                     "honesty": "curated carrier surface: power/UART/I2C/USB/"
                                "boot straps wired; remaining CM4 pins NC by "
                                "design; footprint = official CM4IO reference"})
    return b, 84, 50


def block_eps(x, y, n, nets):
    """Single-cell Li-ion EPS: TP4056 USB charger, DW01A+FS8205A pack
    protection in the battery-negative line, AP2112K-3.3 LDO so the BOARD
    RUNS FROM THE CELL, JST-PH cell connector, CHRG/STDBY LEDs.
    Parts (registry, JLCPCB catalog): C16581 TP4056-42-ESOP8,
    C351410 DW01A SOT-23-6L, C908265 FS8205A SOT-23-6L, C51118
    AP2112K-3.3TRG1 SOT-25-5. Pin maps are datasheet-anchor-verified
    (tools/blocks/tests/eps_parts_check.py) — never edit one without
    re-running it.
    HONEST LIMITS (also in the devices manifest): LDO 3V3 valid while
    VBAT >= ~3.55 V; charge current fixed ~580 mA (PROG 2k); no solar
    input in v1."""
    b = ""
    # charger: 5V (USB inlet) -> cell positive. TEMP (pin 1) tied to GND
    # disables the NTC function per datasheet; CE (pin 8) tied high = always
    # enabled; pad 9 is the ESOP-8 exposed pad (GND per datasheet).
    b += place("registry", "C16581", _next_ref("U"), x + 6, y + 8, 0, {
        "4": "+5V", "3": "GND", "1": "GND", "8": "+5V", "9": "GND",
        "5": "VBAT", "2": "EPS_PROG",
        "7": "EPS_CHRG_N", "6": "EPS_STDBY_N"}, nets)
    b += res(_next_ref("R"), x + 6, y + 14, "EPS_PROG", "GND", nets, value="2k")
    # status LEDs (existing statusled pattern: LED + series R to +5V)
    b += res(_next_ref("R"), x + 12, y + 14, "+5V", "EPS_LED_C", nets, value="1k")
    b += place("LED_SMD", "LED_0603_1608Metric", _next_ref("D"), x + 12, y + 17, 0,
               {"1": "EPS_CHRG_N", "2": "EPS_LED_C"}, nets)
    b += res(_next_ref("R"), x + 16, y + 14, "+5V", "EPS_LED_S", nets, value="1k")
    b += place("LED_SMD", "LED_0603_1608Metric", _next_ref("D"), x + 16, y + 17, 0,
               {"1": "EPS_STDBY_N", "2": "EPS_LED_S"}, nets)
    label("CHG FULL", x + 14, y + 19, 0.6)
    # protection: DW01A senses, FS8205A switches the NEGATIVE line.
    # Cell-side negative = EPS_BATT_N; board GND = pack negative.
    # DW01A (C351410, PUOLOP): 1=OD 2=VM(current sense) 3=OC 5=VCC 6=GND.
    b += place("registry", "C351410", _next_ref("U"), x + 6, y + 22, 0, {
        "5": "EPS_DW_VCC", "6": "EPS_BATT_N",
        "1": "EPS_OD", "3": "EPS_OC", "2": "EPS_CS"}, nets)
    b += res(_next_ref("R"), x + 2, y + 22, "VBAT", "EPS_DW_VCC", nets, value="470")
    b += cap(_next_ref("C"), x + 2, y + 26, "EPS_DW_VCC", "EPS_BATT_N", nets)
    b += res(_next_ref("R"), x + 10, y + 26, "EPS_CS", "GND", nets, value="1k")
    # FS8205A (C908265, SOT-23-6): 1=G1 2=S1 3=D1/D2 4=D1/D2 5=G2 6=S2 —
    # datasheet-verified. Discharge FET (G1=OD) on the cell side, charge FET
    # (G2=OC) on the pack side, common drain.
    b += place("registry", "C908265", _next_ref("U"), x + 14, y + 22, 0, {
        "1": "EPS_OD", "2": "EPS_BATT_N",
        "5": "EPS_OC", "6": "GND",
        "3": "EPS_FET_D", "4": "EPS_FET_D"}, nets)
    # cell connector: pin1 = VBAT (cell +), pin2 = cell - (protected side)
    b += place("Connector_JST", "JST_PH_S2B-PH-K_1x02_P2.00mm_Horizontal",
               _next_ref("J"), x + 26, y + 8, 0,
               {"1": "VBAT", "2": "EPS_BATT_N"}, nets)
    label("BAT + -", x + 26, y + 3, 0.6)
    # regulation: the board runs from the cell.
    # AP2112K-3.3 (C51118): 1=VIN 2=GND 3=EN 5=VOUT (4=NC).
    b += place("registry", "C51118", _next_ref("U"), x + 24, y + 22, 0, {
        "1": "VBAT", "2": "GND", "3": "VBAT", "5": "+3V3"}, nets)
    b += cap(_next_ref("C"), x + 21, y + 26, "VBAT", "GND", nets, value="1uF")
    b += cap(_next_ref("C"), x + 27, y + 26, "+3V3", "GND", nets, value="1uF")
    _DEVICES.append({"ref": "(eps)", "type": "power", "family": "li-ion-1s",
                     "name": "EPS: TP4056 charge + DW01A/8205 protect + AP2112 3V3",
                     "honesty": "datasheet-anchor-verified pin maps; LDO 3V3 "
                                "valid while VBAT>=3.55V; ~580mA charge; no "
                                "solar input; protection in battery-negative "
                                "line — cell minus is EPS_BATT_N, NOT board GND"})
    return b, 34, 30


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
    b += res("R1", x + 4, y + 18, "USB_CC1", "GND", nets, value="5.1k")   # CC1 5.1k Rd
    b += res("R2", x + 8, y + 18, "USB_CC2", "GND", nets, value="5.1k")   # CC2 5.1k Rd
    b += cap("C1", x + 12, y + 18, "+5V", "GND", nets, value="10uF")      # VBUS bulk
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
    uref, cref = _next_ref("U"), _next_ref("C")
    b = place(r["lib"], r["footprint"], uref, x + 6, y + 6, 0, r["pmap"], nets)
    b += cap(cref, x + 6, y + 14, "+3V3", "GND", nets)  # decoupling per power pin
    _DEVICES.append({"ref": uref, "type": "i2c_tempsensor", "mpn": r.get("mpn"), "name": r.get("mpn") or r.get("symbol") or "I2C temperature sensor"})
    print("SOURCED:" + json.dumps({
        "ref": uref, "mpn": r.get("mpn"), "manufacturer": r.get("manufacturer"),
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
    # Phase 5a: dynamic refs — boards can carry N sourced parts (the old
    # hardcoded U6/C9 collided at the second sourced sensor)
    uref, cref = _next_ref("U"), _next_ref("C")
    b = place(r["lib"], r["footprint"], uref, x + 6, y + 6, 0, r["pmap"], nets)
    b += cap(cref, x + 6, y + 14, "+3V3", "GND", nets)
    _DEVICES.append({"ref": uref, "type": "i2c_sensor", "desc": desc,
                     "mpn": r.get("mpn"), "name": r.get("mpn") or r.get("symbol") or desc})
    print("SOURCED:" + json.dumps({
        "ref": uref, "desc": desc, "mpn": r.get("mpn"),
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
    b += res("R20", x + 13, y + 10, "CANH", "CANL", nets, value="120R")    # 120-ohm bus termination
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
    # Layout note: the TMC2209 is a fine-pitch driver whose VMOTOR / coil / and
    # charge-pump pins each need a clear escape lane. Keep its support parts back
    # from the package so the grid router's escape stubs aren't walled in by a
    # neighbouring cap/connector's clearance halo (the dense original packing
    # left VMOTOR / M_A1 / M_A2 / DIR with no legal escape → motor-net shorts).
    # motor power inlet (VMOTOR / GND) — separate from the +5V logic rail
    b = place("Connector_PinHeader_2.54mm", "PinHeader_1x02_P2.54mm_Vertical",
              "J8", x + 4, y + 10, 90, {"1": "VMOTOR", "2": "GND"}, nets)
    b += cap("C21", x + 4, y + 20, "VMOTOR", "GND", nets)   # motor supply bulk
    # the driver, resolved + placed, with every support-pin net named
    b2, r = sourced_ic("TMC2209 stepper motor driver", "stepper_driver", {
        "power": "+3V3", "gnd": "GND", "vmotor": "VMOTOR",
        "step": n["step"], "dir": n["dir"], "en": n["en"],
        "motor_a1": "M_A1", "motor_a2": "M_A2",
        "motor_b1": "M_B1", "motor_b2": "M_B2",
        "cp_out": "CP_OUT", "cp_in": "CP_IN", "vcp": "VCP", "reg_out": "REG_5V",
    }, "U8", x + 18, y + 14, 0, nets)
    b += b2
    # charge-pump + reg support, spaced a full grid-lane clear of the package
    b += cap("C22", x + 32, y + 8, "CP_OUT", "CP_IN", nets)    # charge-pump flying cap
    b += cap("C23", x + 32, y + 16, "VCP", "VMOTOR", nets)     # charge-pump reservoir
    b += cap("C24", x + 32, y + 24, "REG_5V", "GND", nets)     # 5VOUT internal-reg decoupling
    b += cap("C25", x + 18, y + 28, "+3V3", "GND", nets)       # VCC_IO decoupling
    # 4-pin bipolar motor output (coil A, coil B), well clear of the driver
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x04_P2.54mm_Vertical",
               "J9", x + 44, y + 16, 0,
               {"1": "M_A1", "2": "M_A2", "3": "M_B1", "4": "M_B2"}, nets)
    return b, 56, 38


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
    gpio_pin = {  # RP2040 GPIOn -> QFN-56 pin — VERIFIED against the official
        # KiCad MCU_RaspberryPi symbol (Phase 23.5). The 18.8 manual
        # transcription had pins 17-23 SHIFTED (GPIO14/15, TESTEN, XIN/XOUT,
        # IOVDD) and mis-wired pin 23 (DVDD, 1.1V core) to +3V3 — an error the
        # JIT quarantine correctly blocked from ever building.
        0: "2", 1: "3", 2: "4", 3: "5", 4: "6", 5: "7", 6: "8", 7: "9",
        8: "11", 9: "12", 10: "13", 11: "14", 12: "15", 13: "16", 14: "17",
        15: "18", 16: "27", 17: "28", 18: "29", 19: "30", 20: "31", 21: "32",
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
    pmap = {  # power/system pins — SYMBOL-VERIFIED (EP = pad 57 GND)
        # IOVDD: 1,10,22,33,42,49; DVDD (1.1V core from VREG): 23,50;
        # TESTEN 19 -> GND; XIN 20 / XOUT 21.
        "1": "+3V3", "10": "+3V3", "22": "+3V3", "33": "+3V3",
        "42": "+3V3", "49": "+3V3", "43": "+3V3", "44": "+3V3", "48": "+3V3",
        "23": "RP_DVDD", "45": "RP_DVDD", "50": "RP_DVDD",
        "19": "GND", "57": "GND",
        "20": "RP_XIN", "21": "RP_XOUT",
        "24": "RP_SWCLK", "25": "RP_SWDIO", "26": "RP_RUN",
        "46": "RP_USB_DM", "47": "RP_USB_DP",
        "51": "QSPI_SD3", "52": "QSPI_SCLK", "53": "QSPI_SD0",
        "54": "QSPI_SD2", "55": "QSPI_SD1", "56": "QSPI_SS",
    }
    for key, g in role_gpio.items():
        if key in n:
            pmap[gpio_pin[g]] = n[key]
    b = place("Package_DFN_QFN", "QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm", "U30",
              x + 38, y + 14, 0, pmap, nets)
    # QSPI flash W25Q16 SOIC-8 (manual transcription: 1 /CS 2 DO 3 /WP 4 GND
    # 5 DI 6 CLK 7 /HOLD 8 VCC)
    b += place("Package_SO", "SOIC-8_3.9x4.9mm_P1.27mm", "U31", x + 68, y + 10, 0, {
        "1": "QSPI_SS", "2": "QSPI_SD1", "3": "QSPI_SD2", "4": "GND",
        "5": "QSPI_SD0", "6": "QSPI_SCLK", "7": "QSPI_SD3", "8": "+3V3"}, nets)
    # 12MHz crystal (3225: pads 1/3 crystal, 2/4 GND) + load caps
    b += place("Crystal", "Crystal_SMD_3225-4Pin_3.2x2.5mm", "Y1", x + 14, y + 36, 0,
               {"1": "RP_XIN", "2": "GND", "3": "RP_XOUT", "4": "GND"}, nets)
    b += cap("C40", x + 7, y + 36, "RP_XIN", "GND", nets)
    b += cap("C41", x + 21, y + 36, "RP_XOUT", "GND", nets)
    # 3V3 regulator (AMS1117-3.3 SOT-223: 1 GND 2 VOUT 3 VIN, tab=VOUT)
    b += place("Package_TO_SOT_SMD", "SOT-223-3_TabPin2", "U32", x + 70, y + 32, 0,
               {"1": "GND", "2": "+3V3", "3": "+5V"}, nets)
    b += cap("C42", x + 78, y + 38, "+5V", "GND", nets)
    b += cap("C43", x + 90, y + 44, "+3V3", "GND", nets)
    # DVDD (1.1V core from internal VREG) decoupling — placed OUTSIDE the
    # QFN escape ring (23.5: the ring reaches ~6mm past the package on every
    # side; in-ring caps drew courtyard overlaps with FO breakouts)
    b += cap("C44", x + 28, y + 36, "RP_DVDD", "GND", nets)
    b += cap("C45", x + 10, y + 40, "+3V3", "GND", nets)
    b += cap("C46", x + 22, y + 40, "+3V3", "GND", nets)
    # boot/reset straps + headers
    b += res("R30", x + 90, y + 38, "QSPI_SS", "+3V3", nets)
    b += res("R31", x + 66, y + 44, "RP_RUN", "+3V3", nets)
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x02_P2.54mm_Vertical",
               "J30", x + 4, y + 44, 90, {"1": "QSPI_SS", "2": "GND"}, nets)
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x02_P2.54mm_Vertical",
               "J31", x + 16, y + 44, 90, {"1": "RP_RUN", "2": "GND"}, nets)
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x03_P2.54mm_Vertical",
               "J32", x + 56, y + 44, 90,
               {"1": "RP_SWCLK", "2": "GND", "3": "RP_SWDIO"}, nets)
    # USB: ADVISORY test pads only — no connector, no impedance claim
    b += tp("TP50", x + 74, y + 44, "RP_USB_DM", nets)
    b += tp("TP51", x + 80, y + 44, "RP_USB_DP", nets)
    # I2C pull-ups (the Pico block carries these when it is the MCU)
    if "i2c_sda" in n:
        b += res("R32", x + 90, y + 20, n["i2c_sda"], "+3V3", nets, value="4.7k")
        b += res("R33", x + 90, y + 26, n["i2c_scl"], "+3V3", nets, value="4.7k")
    label("BARE RP2040 (STRESS TEST)", x + 60, y + 2, 0.8)
    label("J30 BOOTSEL  J31 RESET  J32 SWD", x + 18, y + 50, 0.6)
    label("USB pads ADVISORY ONLY no impedance claim", x + 58, y + 50, 0.6)
    _DEVICES.append({"ref": "U30", "type": "mcu", "name": "RP2040 (bare QFN-56)",
                     "honesty": "pin map VERIFIED against the official KiCad "
                                "symbol (23.5); subsystem still unvalidated "
                                "physically"})
    _DEVICES.append({"ref": "U31", "type": "qspi_flash", "name": "W25Q16 class"})
    return b, 96, 54


def block_gpio_breakout(x, y, n, nets):
    """M2: Pico-replacement GPIO breakout — a 1x10 header carrying REAL MCU
    nets (UART, I2C, 4 GPIOs, rails). Only emitted when the net contract is
    allocated, so no labels-only copper can exist."""
    hmap = {"1": "+3V3", "2": "GND",
            "3": n["uart_gps_tx"], "4": n["uart_gps_rx"],
            "5": n["i2c_sda"], "6": n["i2c_scl"],
            "7": n["gp_a"], "8": n["gp_b"], "9": n["gp_c"], "10": n["gp_d"]}
    b = place("Connector_PinHeader_2.54mm", "PinHeader_1x10_P2.54mm_Vertical",
              "J55", x + 2, y + 4, 90, hmap, nets)
    b += tp("TP75", x + 8, y + 30, n["gp_a"], nets)
    b += tp("TP76", x + 14, y + 30, n["gp_b"], nets)
    label("GPIO BREAKOUT (REVIEW REQD)", x + 3, y + 1, 0.7)
    return b, 20, 34


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
    b += res("R94", x + 40, y + 34, n.get("i2c_sda", "I2C_SDA"), "+3V3", nets, value="4.7k")
    b += res("R95", x + 48, y + 34, n.get("i2c_scl", "I2C_SCL"), "+3V3", nets, value="4.7k")
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
    b += res("R96", x + 3, y + 9, "LED_K", "GND", nets, value="1k")
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
    b += res("R97", x + 27, y + 5, n.get("i2c_sda", "I2C_SDA"), "+3V3", nets, value="4.7k")
    b += res("R98", x + 27, y + 10, n.get("i2c_scl", "I2C_SCL"), "+3V3", nets, value="4.7k")
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


def build_chipdown(bx, by, entry, n, nets):
    """Generic chip-down emitter: place the verified part, decouple every
    power pin, pull up open-collector outputs, expose IO on a header, and
    mark the whole structure review-required on silk. The pin map arrives
    symbol-verified from chipdown_synthesis — no hand transcription."""
    ref = entry["ref"]
    fp_lib, fp_name = entry["footprint"]
    pmap = dict(entry["pmap"])
    for k, v in list(pmap.items()):
        if v == "I2C_SDA":
            pmap[k] = n.get("i2c_sda", "I2C_SDA")
        elif v == "I2C_SCL":
            pmap[k] = n.get("i2c_scl", "I2C_SCL")
    ios = entry.get("exposed_io", [])[:8]
    for io in ios:
        pmap[io["pin"]] = "EXP_%s" % io["name"]
    wide = "W_" in fp_name or "W " in fp_name  # e.g. SOIC-16W (7.5mm body)
    b = place(fp_lib, fp_name, ref, bx + (13 if wide else 8), by + 10, 0,
              pmap, nets)
    num = int(ref[1:]) if ref[1:].isdigit() else 0
    # M6: one decoupling cap per POWER DOMAIN rail (never assume +3V3)
    d_rails = entry.get("decouple_rails") or ["+3V3"]
    for i, rail in enumerate(d_rails):
        b += cap("C%d" % (120 + num + i), bx + 2, by + 4 + 5 * i,
                 rail, "GND", nets)
    _sh = 10 if wide else 0
    for i, pu in enumerate(entry.get("pullups", [])):
        b += res("R%d" % (120 + num + i), bx + 14 + _sh, by + 4 + 5 * i,
                 pu, "+3V3", nets)
        b += tp("TP%d" % (80 + num + i), bx + 19 + _sh, by + 4 + 5 * i,
                pu, nets)
    if ios:
        hmap = {}
        for i, io in enumerate(ios):
            hmap[str(i + 1)] = "EXP_%s" % io["name"]
        b += place("Connector_PinHeader_2.54mm",
                   "PinHeader_1x%02d_P2.54mm_Vertical" % len(ios),
                   "J%d" % (60 + num), bx + 24 + _sh, by + 4, 90, hmap, nets)
    label("%s CHIPDOWN (REVIEW REQD)" % ref, bx + 10, by + 1, 0.7)
    return b, (46 if wide else 34), 22 + 4 * max(0, len(ios) - 4)


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
    b += res("R99", x + 14, y + 4, "USB_CC1", "GND", nets, value="5.1k")
    b += res("R100", x + 14, y + 9, "USB_CC2", "GND", nets, value="5.1k")
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
    b += res("R21", x + 2, y + 10, n.get("sr_oe", "SR_OE"), "+5V", nets, value="10k")  # OE pull-up: off at boot
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


# Dynamic reference allocator for catalog-sourced parts (Phase 5a): the old
# single hardcoded U6/C9 slot collided as soon as a board carried two sourced
# parts. Reset per board in compose(); starts high to clear every static ref.
_DYNREF = {"U": 20, "C": 20, "J": 20, "R": 20}


def _next_ref(prefix):
    _DYNREF[prefix] = _DYNREF.get(prefix, 20) + 1
    return "%s%d" % (prefix, _DYNREF[prefix])


def block_audio_amp(x, y, n, nets):
    """Audio amplifier + speaker connector — NOT a hardcoded part. The part is
    sourced from the shared registry's JLCPCB catalog (684k parts), its pinout
    read from the real datasheet, and the pin binding synthesized by the LLM
    and mechanically verified (contract_synth). REVIEW-REQUIRED like every
    LLM-bound part; the BOM carries MPN/stock/provenance."""
    roles = {
        "power":    {"desc": "supply voltage input(s)", "required": True, "mode": "multi"},
        "gnd":      {"desc": "ground pin(s)", "required": True, "mode": "multi"},
        "audio_in": {"desc": "audio signal input (single-ended or IN+)", "required": True, "mode": "one"},
        "out_pos":  {"desc": "speaker output positive (OUT+ / VO1)", "required": True, "mode": "one"},
        "out_neg":  {"desc": "speaker output negative (OUT- / VO2)", "required": True, "mode": "one"},
        "shutdown": {"desc": "shutdown / enable control pin", "required": False, "mode": "one"},
    }
    r = source_part.source_catalog(
        "class d audio amplifier", roles,
        {"power": "+3V3", "gnd": "GND", "audio_in": n.get("audio_pwm", "AUDIO_PWM"),
         "out_pos": "SPK_P", "out_neg": "SPK_N",
         "shutdown": n.get("amp_en", "AMP_EN")},
        interface_name="audio_amp")
    if "error" in r:
        raise RuntimeError("audio amp source failed: " + r["error"])
    uref, cref, jref = _next_ref("U"), _next_ref("C"), _next_ref("J")
    b = place(r["lib"], r["footprint"], uref, x + 6, y + 6, 0, r["pmap"], nets)
    b += cap(cref, x + 6, y + 14, "+3V3", "GND", nets)
    b += place("Connector_PinHeader_2.54mm", "PinHeader_1x02_P2.54mm_Vertical",
               jref, x + 16, y + 6, 0, {"1": "SPK_P", "2": "SPK_N"}, nets)
    label("SPK + -", x + 16, y + 2, 0.6)
    _DEVICES.append({"ref": uref, "type": "audio_amp", "mpn": r.get("mpn"),
                     "name": r.get("mpn") or "audio amplifier",
                     "lcsc": r.get("lcsc"), "interface": "audio_amp",
                     "verified": r.get("verified"),
                     "honesty": "catalog-sourced, LLM pin binding — see verification level"})
    print("SOURCED:" + json.dumps({
        "ref": uref, "mpn": r.get("mpn"), "manufacturer": r.get("manufacturer"),
        "price": r.get("price"), "stock": r.get("stock"),
        "footprint": r["lib"] + ":" + r["footprint"],
        "verified": r.get("verified"), "via": r.get("source")}))
    return b, 24, 20


# free-text sensor detector for blocks no fixed key matched — these SOURCE a
# real part instead of being dropped
SENSOR_PAT = re.compile(
    r"pressure|baro|humidity|hygro|moisture|lux|ambient light|light sensor|als\b|"
    r"proximity|tof|time.of.flight|distance sensor|color sensor|uv\b|co2|voc|"
    r"air quality|gas sensor|magnetometer|compass|hall\b|current sens|power monitor|"
    r"sht\d|bme\d|bmp\d|opt3|veml|apds|vl53|tsl2|ccs811|sgp\d|ina2\d|\bsensors?\b",
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
    "gpiobreakout": block_gpio_breakout,
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
    "audio": block_audio_amp,
    "esp32c3": block_mcu_esp32c3,
    "somcarrier": block_som_carrier,
    "eps": block_eps,
}


# The buildable-block menu the interview LLM is shown, so it proposes blocks the
# library can actually build (named with the real part/function) instead of
# generic categories it then drops. SINGLE SOURCE OF TRUTH: keep in step with
# _block_keys / BLOCK_TABLE. Emitted via `compose.py --capabilities`.
CAPABILITIES = [
    {"key": "power", "label": "Power inlet + regulation (USB-C 5V → 3.3V, or Vin/battery/LDO/buck)"},
    {"key": "mcu", "label": "RP2040 MCU on a Raspberry Pi Pico module"},
    {"key": "baremcu", "label": "Bare RP2040 (QFN-56) MCU, no Pico module"},
    {"key": "radio", "label": "LoRa radio (RFM95 / SX127x) — auto-adds a U.FL antenna"},
    {"key": "cellular", "label": "Cellular modem (LTE / NB-IoT / GSM)"},
    {"key": "gnss", "label": "GNSS / GPS receiver"},
    {"key": "imu", "label": "6-axis IMU (accelerometer + gyro)"},
    {"key": "tempsensor", "label": "I2C temperature sensor (LM75 / TMP102 / TMP117 / MCP9808)"},
    {"key": "bme280", "label": "BME280 environmental sensor (temperature + humidity + pressure)"},
    {"key": "i2c-sensor", "label": "ANY other I2C sensor named in the request — pressure, humidity, "
        "light/ALS, proximity/ToF, CO2/VOC/air-quality/gas, magnetometer/compass, current-sense (INA-class). "
        "Name the specific part or measurand and it is synthesized."},
    {"key": "motors", "label": "Brushed motor / servo / ESC drivers (only if the board drives motors)"},
    {"key": "motion", "label": "Stepper driver (TMC2209 / TMC5160)"},
    {"key": "comms", "label": "CAN bus transceiver"},
    {"key": "instrument", "label": "DC current/voltage measurement front-end (INA-class shunt monitor)"},
    {"key": "statusled", "label": "Status / indicator LED"},
    {"key": "spibus", "label": "SPI peripheral header / bus break-out"},
    {"key": "boardid", "label": "Board-ID EEPROM (24LCxx)"},
    {"key": "gpiobank", "label": "Protected GPIO bank / header"},
    {"key": "audio", "label": "Audio amplifier + speaker connector (Class-D/AB, "
        "sourced live from the JLCPCB catalog, LLM pin binding, review-required)"},
    {"key": "esp32c3", "label": "ESP32-C3-WROOM-02 WiFi + BLE MCU module (replaces the "
        "Pico as the board's MCU; integrated antenna with copper keep-out; UART flash "
        "header; firmware image lands with the ESP-IDF target)"},
    {"key": "somcarrier", "label": "Raspberry Pi CM4 SoM carrier (Linux-class compute; "
        "official CM4IO footprint; 5V power-in, console UART, shared I2C, USB 2.0 "
        "device header for rpiboot flashing, boot/power-control jumpers; firmware "
        "stage skips honestly — OS image is a future target)"},
    {"key": "eps", "label": "Battery EPS (single-cell Li-ion: USB charging, "
        "pack protection, 3.3V regulation from the cell, JST-PH connector; "
        "LDO valid while VBAT>=3.55V — buck-boost is a follow-on)"},
]


def capabilities_json():
    import json as _json
    return _json.dumps({"blocks": CAPABILITIES}, indent=2)


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
    if any(k in s for k in ("lora", "radio", "sx12", "sx127", "telemetry", "rfm", "433mhz", "915mhz", "868mhz")):
        add("radio")  # NOT bare "transceiver" — that also means CAN/RS485, not a radio
    if "antenna" in s:
        add("antenna")
    if any(k in s for k in ("temperature", "temp sensor", "thermometer", "thermal sensor",
                            "lm75", "tmp102", "tmp117", "mcp9808")):
        add("tempsensor")
    # "mpu" must be word-bounded: bare substring match hits "coMPUte (module)"
    if any(k in s for k in ("imu", "gyro", "accel", "mpu6050", "inertial",
                            "6-axis", "6 axis", "9-axis", "9 axis")) \
            or re.search(r"\bmpu\b", s):
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
    if "breakout" in s and ("gpio" in s or "pico" in s):
        add("gpiobreakout")
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
    if any(k in s for k in ("audio amp", "speaker", "class d", "class-d",
                            "audio out", "audio driver")):
        add("audio")
    if any(k in s for k in ("esp32", "wifi", "wi-fi", "ble", "bluetooth",
                            "2.4ghz", "2.4 ghz")):
        add("esp32c3")
    if any(k in s for k in ("cm4", "cm5", "compute module", "som carrier",
                            "som ", "system on module", "raspberry pi module",
                            "linux carrier", "linux board", "carrier board")):
        add("somcarrier")
    if any(k in s for k in ("battery", "batteries", "lipo", "li-ion", "lithium",
                            "18650", "charging", "charger", "rechargeable")):
        add("eps")
    if "usbc" not in out and "eps" not in out and any(
            k in s for k in ("power", "regulator", "vin",
                             "5v", "3v3", "ldo", "buck",
                             "usb power", "usb-c power")):
        add("power")
    return out


def _catalog_i2c_rescue(desc):
    """Would-be-dropped phrase -> True when the shared part registry's JLCPCB
    catalog has an in-stock I2C-attachable match for it (the existing sourced-
    sensor path can then build it). Registry absent or no match -> False, and
    the phrase drops honestly like before."""
    try:
        sys.path.insert(0, os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
            "tools", "parts"))
        import registry as _reg
        for hit in _reg.search(desc, 5):
            text = " ".join(str(hit.get(k) or "") for k in
                            ("description", "category", "mpn")).upper()
            if "I2C" in text or "IIC" in text:
                return True
        return False
    except Exception:
        return False


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
            elif _catalog_i2c_rescue(b):
                # Phase 4: the 684k-part catalog recognizes this as an
                # I2C-attachable part even though no keyword matched — source
                # it instead of dropping it. Non-I2C hits still drop honestly.
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
    # a WiFi/BLE request makes the ESP32-C3 the board's (only) MCU: it IS an
    # MCU, so the Pico must not be auto- or co-added
    if "esp32c3" in seen and "mcu" in seen:
        uniq.remove("mcu")
        seen.discard("mcu")
    # a SoM carrier's compute IS the CM4 — "compute module" keyword-matches the
    # mcu bucket too, so drop the auto-Pico; the CM4 owns the shared buses
    if "somcarrier" in seen and "mcu" in seen:
        uniq.remove("mcu")
        seen.discard("mcu")
    # the EPS IS the board's power source (3V3 from the cell) — drop the
    # auto power inlet; a USB-C inlet may still co-exist as the charge path
    if "eps" in seen and "power" in seen:
        uniq.remove("power")
        seen.discard("power")
    if "backplane6" in seen and "mcu" in seen and len(seen) <= 3:
        pass  # explicit mcu request stands
    if not (seen & {"mcu", "baremcu", "esp32c3", "somcarrier", "backplane6",
                    "bme280breakout", "standalone"}):
        uniq.append("mcu")
        seen.add("mcu")
    if not (seen & {"power", "usbc", "eps"}):
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

# 8-layer stackup: Sig-GND-Sig-PWR-GND-Sig-GND-Sig — three GND reference planes
# (In1/In4/In6) and one +3V3 power plane (In3), leaving F/In2/In5/B for routing.
# Selected ONLY by spec {"layers": 8}; the 2/4-layer paths are untouched.
LAYERS8 = '''  (layers
    (0 "F.Cu" signal) (1 "In1.Cu" signal "GND") (2 "In2.Cu" signal) (3 "In3.Cu" signal "PWR")
    (4 "In4.Cu" signal "GND") (5 "In5.Cu" signal) (6 "In6.Cu" signal "GND") (31 "B.Cu" signal)
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
ROW = {"power": 0, "usbc": 0, "eps": 0, "mcu": 0, "esp32c3": 0, "somcarrier": 0,
       "imu": 0, "radio": 0, "antenna": 0,
       "gnss": 0, "cellular": 0, "tempsensor": 0, "comms": 0, "motion": 1,
       "instrument": 0, "dutmonitor": 0, "calref": 0, "calrefext": 0, "backplane6": 0,
       "statusled": 0, "bme280": 0, "bme280breakout": 0, "usbcsink": 0,
       "standalone": 0,
       "baremcu": 0, "relaymatrix": 1, "motors": 1, "gpiobreakout": 1,
       "fl1bus": 0, "boardid": 0, "gpiobank": 0, "spibus": 0, "uartbridge": 0}
COL = {"power": 0, "usbc": 0, "eps": 1, "mcu": 2, "esp32c3": 2, "somcarrier": 2,
       "imu": 3, "tempsensor": 3, "gnss": 4,
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
    _PLACED[:] = []   # occupancy for the fiducial free-space search
    _SILK[:] = []     # reset the per-board functional silkscreen labels
    _DYNREF.clear()
    _DYNREF.update({"U": 20, "C": 20, "J": 20, "R": 20})  # per-board ref pool
    _PREROUTED[:] = []
    _PREROUTED_NETS[:] = []
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
    # Milestone: generic chip-down synthesis — entries produced by
    # chipdown_synthesis.synthesize_chipdown (symbol-verified pin maps, no
    # hand block per chip). Every chip-down is REVIEW-REQUIRED.
    cds = {}
    for i, entry in enumerate((spec or {}).get("chipdown") or []):
        if entry.get("state") != "synthesized_review_required":
            raise RuntimeError("chipdown entry not in synthesized_review_"
                               "required state: %r" % entry.get("state"))
        cds["zcd%02d" % i] = entry
    keys = keys + sorted(cds)
    if cds:
        _DEVICES.append({"ref": ",".join(e["ref"] for e in cds.values()),
                         "type": "chipdown_synthesized",
                         "parts": [e["symbol"] for e in cds.values()],
                         "honesty": "generic chip-down synthesis from library "
                                    "truth; REVIEW-REQUIRED; no functional or "
                                    "physical claim"})
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
    _cd_i2c = any(v in ("I2C_SDA", "I2C_SCL")
                  for e in cds.values() for v in e["pmap"].values())
    if "gpiobreakout" in keys:
        n.setdefault("uart_gps_tx", "UART_TX")
        n.setdefault("uart_gps_rx", "UART_RX")
        n.setdefault("gp_a", "GP10")
        n.setdefault("gp_b", "GP11")
        n.setdefault("gp_c", "GP12")
        n.setdefault("gp_d", "GP13")
    if ("imu" in keys or "tempsensor" in keys or "instrument" in keys or dyn
            or "calref" in keys or "dutmonitor" in keys or "bme280" in keys
            or _cd_i2c or "gpiobreakout" in keys):
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
    if "audio" in keys:
        n.update({"audio_pwm": "AUDIO_PWM", "amp_en": "AMP_EN"})
    if "cellular" in keys:
        n.update({"uart_cell_tx": "CELL_TX", "uart_cell_rx": "CELL_RX",
                  "cell_pwrkey": "CELL_PWRKEY", "cell_rst": "CELL_RST"})
    for sig in n.values():
        nets.id(sig)

    X0, Y0, MARGIN, GAP, ROWGAP = 30.0, 30.0, 8.0, 8.0, 10.0

    # group blocks into bands, then flow each band left->right by COL priority
    bands = {}
    for k in keys:
        bands.setdefault(ROW.get(k, 1 if k.startswith("zcd") else 0), []).append(k)

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
                if kk in cds:
                    return build_chipdown(bx, by, cds[kk], n, nets)
                return BLOCK_TABLE[kk](bx, by, n, nets)
            _mark = len(_PLACED)
            txt, w, h = build(x, ytop)
            # wrap to a new sub-row if this band overflows the width budget
            if x > X0 + MARGIN and (x + w - X0) > ROW_BUDGET:
                maxright = max(maxright, x - GAP)  # capture this sub-row's reach
                x = X0 + MARGIN
                ytop += rowh + ROWGAP
                rowh = 0
                # the first build's text is thrown away, so drop the occupancy it
                # registered too — otherwise the wrapped-away boxes haunt the
                # fiducial search at coordinates nothing was ever emitted at.
                del _PLACED[_mark:]
                txt, w, h = build(x, ytop)
            body += txt
            # frozen internal copper for pre-routed blocks (density program)
            body += emit_frozen_routes(k, x, ytop, nets)
            print("BLOCK_AT:" + json.dumps({"key": k, "x": x, "y": ytop}))
            x += w + GAP
            rowh = max(rowh, h)
        maxright = max(maxright, x - GAP)
        ytop += rowh + ROWGAP

    BW = round(maxright + MARGIN - X0, 1)
    BH = round(ytop - ROWGAP - (Y0 + MARGIN) + 2 * MARGIN, 1)

    # mounting holes (Phase 15.6 role primitive): 4x M3 near the corners — every
    # real FL-1 board must be mountable/fixturable. Collision-aware: the 7mm
    # inset is only the preferred spot (see place_mounting_holes).
    body += place_mounting_holes(X0, Y0, BW, BH, nets)

    # test points (Phase 15.6 role primitive): labeled probe pads on the rails +
    # the shared buses/safety lines, along the bottom margin band. Placed (and
    # registered in _PLACED) BEFORE the fiducial search — the fixed-position row
    # used to go after it, so a ring-displaced fiducial could land exactly where
    # a later TP was then stamped. Each TP is itself collision-checked: it
    # shifts off anything already placed (within 12mm of its row slot) or is
    # dropped honestly, never stacked.
    tp_nets = ["+5V", "+3V3", "GND"]
    for cand in ("I2C_SDA", "I2C_SCL", "FAULT", "INTERLOCK", "TRIG", "SR_OE"):
        if cand in nets.idx:
            tp_nets.append(cand)
    _tp_box = courtyard_rel("TestPoint", "TestPoint_Pad_1.5x1.5mm")
    tx, _tp_n = X0 + 22, 0
    for tnet in tp_nets:
        _tp_spot = free_spots([(tx, Y0 + BH - 5)], _tp_box, X0, Y0, BW, BH,
                              n=1, within=(tx, Y0 + BH - 5, 12.0))
        tx += 7
        if not _tp_spot:
            continue
        _tp_n += 1
        px, py = _tp_spot[0]
        body += tp("TP%d" % _tp_n, px, py, tnet, nets)
        label(tnet, px, py - 4, 0.6)
    if _tp_n < len(tp_nets):
        print("TESTPOINTS: only %d of %d placed — no free spot left in the "
              "bottom band" % (_tp_n, len(tp_nets)))

    # assembly fiducials (3, inboard of the mounting holes, clear of the part band)
    # + a router keepout around each: the fiducial pad carries a 0.6mm clearance
    # ring the grid router does not model, so without the keepout a track can run
    # legally-by-grid but violate the fiducial's pad clearance (the FID3/+5V DRC
    # hits on the dc-measure fixture).
    # The corner band is only a PREFERENCE: a part's real courtyard can legally
    # reach into it, so the spots are collision-checked against everything
    # already placed rather than assumed free (fixed offsets put FID1 inside the
    # MCU courtyard on a dense board).
    _fid_targets = [(X0 + 13, Y0 + 6), (X0 + BW - 13, Y0 + 6), (X0 + 13, Y0 + BH - 6),
                    (X0 + BW - 13, Y0 + BH - 6)]
    _fid_spots = free_spots(_fid_targets,
                            courtyard_rel("Fiducial", "Fiducial_1mm_Mask2mm"),
                            X0, Y0, BW, BH, n=3)
    print("FIDUCIALS:%d placed" % len(_fid_spots))
    if len(_fid_spots) < 3:
        # honest: report the real shortfall, never stack one on a part to hit 3.
        print("FIDUCIALS:only %d of 3 placed — no free area left on the %sx%smm "
              "board" % (len(_fid_spots), BW, BH))
    for i, (fx, fy) in enumerate(_fid_spots):
        body += place("Fiducial", "Fiducial_1mm_Mask2mm", "FID" + str(i + 1),
                      fx, fy, 0, {}, nets)
        kx0, ky0 = fx - 1.4, fy - 1.4
        kx1, ky1 = fx + 1.4, fy + 1.4
        body += ('  (zone (net 0) (net_name "") (layer "F.Cu") (uuid "{}") (hatch edge 0.5)\n'
                 '    (connect_pads (clearance 0)) (min_thickness 0.25)\n'
                 '    (keepout (tracks not_allowed) (vias not_allowed) (pads allowed)'
                 ' (copperpour allowed) (footprints allowed))\n'
                 '    (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))\n'
                 '    (polygon (pts (xy {} {}) (xy {} {}) (xy {} {}) (xy {} {}))))\n'
                 ).format(U(), kx0, ky0, kx1, ky0, kx1, ky1, kx0, ky1)

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

    nlayers = (spec or {}).get("layers")
    two_layer = nlayers == 2
    eight_layer = nlayers == 8
    stack = LAYERS2 if two_layer else LAYERS8 if eight_layer else LAYERS
    p = '(kicad_pcb (version 20240108) (generator "ee-lab-compose") (generator_version "8.0")\n'
    p += '  (general (thickness 1.6))\n  (paper "A4")\n' + stack
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
    elif eight_layer:
        # 8-layer: GND reference planes on In1/In4/In6 (+ F/B outer pours),
        # +3V3 power plane on In3. In2/In5 stay free for routing.
        for lyr in ("F.Cu", "B.Cu", "In1.Cu", "In4.Cu", "In6.Cu"):
            p += gzone("GND", lyr, X0, Y0, X0 + BW, Y0 + BH, nets)
        p += gzone("+3V3", "In3.Cu", X0, Y0, X0 + BW, Y0 + BH, nets)
        print("COMPOSE: 8-LAYER profile (GND In1/In4/In6, PWR In3)")
    else:
        # GND pours on F/B/In1, PWR on In2 (the proven 4-layer flow).
        # A SoM carrier is a 5V-PLANE board: the CM4 pulls amps across six
        # DF40 pins — that is a plane, not a 0.25mm routed net. +3V3 (small
        # sensor loads) becomes the routed rail instead, same trade the
        # 2-layer profile already makes.
        pwr_net = "+5V" if "somcarrier" in keys else "+3V3"
        p += gzone("GND", "F.Cu", X0, Y0, X0 + BW, Y0 + BH, nets)
        p += gzone("GND", "B.Cu", X0, Y0, X0 + BW, Y0 + BH, nets)
        p += gzone("GND", "In1.Cu", X0, Y0, X0 + BW, Y0 + BH, nets)
        p += gzone(pwr_net, "In2.Cu", X0, Y0, X0 + BW, Y0 + BH, nets)
        if pwr_net != "+3V3":
            print("COMPOSE: In2 PWR plane = %s (SoM carrier), +3V3 routed" % pwr_net)
    p += body
    p += ')\n'
    open(out_path, "w").write(p)

    # Fine-pitch parts (USB-C receptacle, QFN/VSSOP/DFN, any sub-0.8mm-pitch
    # sourced part) have intrinsic pad gaps below the 0.2mm house clearance.
    # Detect them from the ACTUAL placed footprints (not the block type, since a
    # sourced part can be any package) and emit a matching design-rules file
    # allowing 0.13mm (6-mil) pad-to-pad — a clearance every standard fab
    # supports. kicad-cli auto-loads <board>.kicad_dru.
    # ALWAYS write the fab-class sidecars (was fine-pitch-conditional): the
    # fanout pass uses its own pitch threshold, so a board this regex missed
    # could still carry 0.4/0.2 stitch vias that are illegal under KiCad's
    # defaults — the ESP32-C3 module board hit exactly that. The rules ARE
    # the fab class (JLCPCB-legal), so they are correct for every board.
    if True:
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

    # real electrical values captured at design time (ref -> value). Extract
    # from the FINAL board so refs are post-renumber. Only keep genuine
    # electrical values (e.g. "100nF", "4.7k"); footprint strings like
    # "C_0402_1005Metric" and un-set placeholders are skipped, so nothing is
    # invented — a part with no captured value simply isn't listed.
    vals = {}
    for m in re.finditer(
            r'\(footprint "[^"]+"[\s\S]*?\(property "Reference" "([^"]+)"'
            r'[\s\S]*?\(property "Value" "([^"]+)"', p):
        ref, val = m.group(1), m.group(2)
        if re.match(r'^[\d.]+\s*[pnuµmkKMGR]?[FHΩ]?$', val):
            vals[ref] = val
    open(os.path.splitext(out_path)[0] + ".values.json", "w").write(json.dumps(vals))

    print("COMPOSE: blocks {} -> {} components placed, {:.0f}x{:.0f}mm, {} nets".format(
        keys, p.count("(footprint "), BW, BH, len(nets.order) - 1))
    print("COMPOSE_BLOCKS:" + ",".join(keys))
    # coverage: what the spec asked for vs. what the library could build. The
    # pipeline surfaces `dropped` loudly so an incomplete board never reads as a
    # silent clean pass.
    mapped_out = [k for k in keys if k not in dyn] + \
        ["sensor:" + dyn[k] for k in keys if k in dyn]
    print("COMPOSE_COVERAGE:" + json.dumps({"mapped": mapped_out, "dropped": dropped}))
    # pre-routed block copper: sidecar for post-SES restoration + the net list
    # the router must skip (their copper is already on the board)
    if _PREROUTED:
        side = os.path.splitext(out_path)[0] + ".preroute.json"
        json.dump({"entries": _PREROUTED}, open(side, "w"), indent=1)
        print("PREROUTED_NETS:" + json.dumps(_PREROUTED_NETS))


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--capabilities":
        print(capabilities_json())
        return
    spec = json.load(open(sys.argv[1])) if len(sys.argv) > 1 and os.path.exists(sys.argv[1]) else {}
    out_path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/composed.kicad_pcb"
    blocks = spec.get("blocks", ["power", "mcu", "lora radio", "antenna"])
    compose(spec, blocks, out_path)


if __name__ == "__main__":
    main()
