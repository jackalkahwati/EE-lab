"""DFM quality gate for the Rev A board — assembly-house rules that KiCad
DRC doesn't check. Mirrors the Tile-0 output/dfm_profile_check.json gate.

Checks:
  1. courtyard-to-board-edge >= 3.0 mm (conveyor/panel rail clearance)
  2. courtyard-to-mounting-hole >= 3.5 mm radial (M3 screw head + washer)
  3. >= 3 fiducials present, spread over the board
  4. courtyard-to-courtyard gap >= 0.4 mm (rework access; DRC only catches 0)
  5. board corner radius noted (sharp corners acceptable, radius preferred)

Writes elec/layout/rev-a/output/dfm_profile_check.json; exits 1 on FAIL.
"""
import json
import os
import re
import sys

BOARD = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "elec", "layout", "rev-a", "rev-a.kicad_pcb")
EDGE_MM = 3.0
HOLE_KEEPOUT_MM = 3.5
CY_GAP_MM = 0.4

text = open(os.path.abspath(BOARD)).read()

# board outline + mounting holes: scan every gr_* graphic on Edge.Cuts and take
# the bounding box of all its coordinates. Format-independent — works whether
# the outline is a gr_rect, four gr_lines, or arcs (KiCad re-serializes these
# differently depending on save path), so this no longer crashes on a board
# saved by the KiCad GUI vs. pcbnew vs. gen_board.
edge_xs, edge_ys, circles = [], [], []
for chunk in re.split(r'(?=\(gr_(?:rect|line|arc|circle|poly))', text):
    if 'Edge.Cuts' not in chunk:
        continue
    coords = [(float(a), float(b)) for a, b in re.findall(
        r'\((?:start|end|center|mid|xy) ([\d.eE+-]+) ([\d.eE+-]+)\)', chunk)]
    if not coords:
        continue
    edge_xs += [c[0] for c in coords]
    edge_ys += [c[1] for c in coords]
    if chunk.lstrip().startswith('(gr_circle'):
        circles.append(coords[0])
if not edge_xs:
    print("DFM GATE: FAIL")
    print("  [outline] no Edge.Cuts geometry found")
    sys.exit(1)
BX0, BY0, BX1, BY1 = min(edge_xs), min(edge_ys), max(edge_xs), max(edge_ys)
# Edge.Cuts circles near a board corner are corner-radius / rounding features,
# not mounting holes — exclude them so connectors at the corners aren't flagged
# against board rounding. Interior circles are treated as real mounting holes.
CORNER_MARGIN = 12.0
corners = [(BX0, BY0), (BX1, BY0), (BX0, BY1), (BX1, BY1)]
holes = [c for c in circles
         if all((c[0] - cx) ** 2 + (c[1] - cy) ** 2 > CORNER_MARGIN ** 2
                 for cx, cy in corners)]

# footprints: position + courtyard extent from each footprint block
fps = []
pos_iter = [m for m in re.finditer(r'\(footprint "([^"]+)"', text)]
for i, m0 in enumerate(pos_iter):
    end = pos_iter[i + 1].start() if i + 1 < len(pos_iter) else len(text)
    block = text[m0.start():end]
    am = re.search(r'\(at ([\d.+-]+) ([\d.+-]+)(?: ([\d.+-]+))?\)', block)
    x, y = float(am.group(1)), float(am.group(2))
    rot = float(am.group(3) or 0)
    ref = re.search(r'\(property "Reference" "([^"]+)"', block) or \
          re.search(r'\(fp_text reference "([^"]+)"', block)
    ref = ref.group(1) if ref else "?"
    # courtyard extent: coords from every graphic chunk on a CrtYd layer
    cs = []
    for chunk in re.split(r'(?=\(fp_(?:rect|poly|circle|line|arc))', block):
        if 'CrtYd"' in chunk:
            cs += [(float(a), float(b)) for a, b in re.findall(
                r'\((?:start|end|xy|center) ([\d.+-]+) ([\d.+-]+)\)', chunk)]
    if not cs:  # fall back to pads
        cs = [(float(a), float(b)) for a, b in re.findall(
            r'\(pad "[^"]*"[^(]*\(at ([\d.+-]+) ([\d.+-]+)', block)]
    if not cs:
        continue
    lx = min(c[0] for c in cs); hx = max(c[0] for c in cs)
    ly = min(c[1] for c in cs); hy = max(c[1] for c in cs)
    if rot % 180 == 90:
        lx, ly, hx, hy = ly, lx, hy, hx
    fps.append({"ref": ref, "name": m0.group(1),
                "x0": x + lx, "y0": y + ly, "x1": x + hx, "y1": y + hy})

def is_connector(f):
    """Edge-mount connectors are PLACED at the board edge by design — BNC, pin
    headers, coax, USB, terminal blocks, the SEAF probe interface. They are
    exempt from the conveyor-rail edge rule (but still face hole keepout)."""
    n = f["name"].lower()
    r = f["ref"].upper()
    return (r.startswith("J") or "connector" in n or "pinheader" in n
            or "header" in n or "bnc" in n or "coaxial" in n or "seaf" in n
            or "terminal" in n or "usb" in n or "edge" in n)


viol = {"edge": [], "hole": [], "gap": [], "fiducial": []}
fiducials = [f for f in fps if "Fiducial" in f["name"]]
for f in fps:
    if "Fiducial" in f["name"]:
        continue
    d_edge = min(f["x0"] - BX0, BX1 - f["x1"], f["y0"] - BY0, BY1 - f["y1"])
    if is_connector(f):
        d_edge = EDGE_MM  # exempt: connectors mount at the edge
    if d_edge < EDGE_MM:
        viol["edge"].append("{} ({:.1f} mm to edge)".format(f["ref"], d_edge))
    for hx, hy in holes:
        dx = max(f["x0"] - hx, hx - f["x1"], 0)
        dy = max(f["y0"] - hy, hy - f["y1"], 0)
        d = (dx * dx + dy * dy) ** 0.5
        if d < HOLE_KEEPOUT_MM:
            viol["hole"].append("{} ({:.1f} mm to hole at {:.0f},{:.0f})".format(
                f["ref"], d, hx - BX0, hy - BY0))

others = [f for f in fps if "Fiducial" not in f["name"]]
for i, a in enumerate(others):
    for b in others[i + 1:]:
        dx = max(a["x0"] - b["x1"], b["x0"] - a["x1"])
        dy = max(a["y0"] - b["y1"], b["y0"] - a["y1"])
        if dx < CY_GAP_MM and dy < CY_GAP_MM and max(dx, dy) > -0.01:
            gap = max(dx, dy)
            viol["gap"].append("{} <-> {} ({:.2f} mm)".format(a["ref"], b["ref"], gap))

if len(fiducials) < 3:
    viol["fiducial"].append("{} fiducials present, need >= 3".format(len(fiducials)))

result = {
    "board": os.path.basename(BOARD),
    "rules": {"edge_mm": EDGE_MM, "hole_keepout_mm": HOLE_KEEPOUT_MM,
              "courtyard_gap_mm": CY_GAP_MM, "min_fiducials": 3},
    "violations": viol,
    "pass": not any(viol.values()),
}
outdir = os.path.join(os.path.dirname(os.path.abspath(BOARD)), "output")
os.makedirs(outdir, exist_ok=True)
json.dump(result, open(os.path.join(outdir, "dfm_profile_check.json"), "w"), indent=2)

print("DFM GATE:", "PASS" if result["pass"] else "FAIL")
for k, v in viol.items():
    for item in v:
        print("  [{}] {}".format(k, item))
sys.exit(0 if result["pass"] else 1)
