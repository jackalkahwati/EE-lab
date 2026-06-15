"""DFM quality gate — FL-1 Electronic Load + Discharge Board Rev A.

Rules:
  1. courtyard-to-board-edge >= 3.0 mm
  2. courtyard-to-mounting-hole >= 3.5 mm radial
  3. >= 3 fiducials
  4. courtyard-to-courtyard >= 0.4 mm

Writes elec/layout/eload-rev-a/output/dfm_profile_check.json; exits 1 on FAIL.
"""
import json
import os
import re
import sys

BOARD = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "elec", "layout", "eload-rev-a", "eload-rev-a.kicad_pcb")
EDGE_MM          = 3.0
HOLE_KEEPOUT_MM  = 3.5
CY_GAP_MM        = 0.4

text = open(os.path.abspath(BOARD)).read()

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
    print("DFM GATE: FAIL\n  [outline] no Edge.Cuts geometry found")
    sys.exit(1)

BX0, BY0, BX1, BY1 = min(edge_xs), min(edge_ys), max(edge_xs), max(edge_ys)
CORNER_MARGIN = 12.0
corners = [(BX0, BY0), (BX1, BY0), (BX0, BY1), (BX1, BY1)]
holes   = [c for c in circles
           if all((c[0] - cx) ** 2 + (c[1] - cy) ** 2 > CORNER_MARGIN ** 2
                  for cx, cy in corners)]

fps = []
pos_iter = list(re.finditer(r'\(footprint "([^"]+)"', text))
for i, m0 in enumerate(pos_iter):
    end   = pos_iter[i + 1].start() if i + 1 < len(pos_iter) else len(text)
    block = text[m0.start():end]
    am    = re.search(r'\(at ([\d.+-]+) ([\d.+-]+)(?: ([\d.+-]+))?\)', block)
    if not am:
        continue
    x, y  = float(am.group(1)), float(am.group(2))
    rot   = float(am.group(3) or 0)
    ref   = re.search(r'\(property "Reference" "([^"]+)"', block) or \
            re.search(r'\(fp_text reference "([^"]+)"', block)
    ref   = ref.group(1) if ref else "?"
    cs    = []
    for chunk in re.split(r'(?=\(fp_(?:rect|poly|circle|line|arc))', block):
        if 'CrtYd"' in chunk:
            cs += [(float(a), float(b)) for a, b in re.findall(
                r'\((?:start|end|xy|center) ([\d.+-]+) ([\d.+-]+)\)', chunk)]
    if not cs:
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

fiducials = [f for f in fps if "Fiducial" in f["name"]]
others    = [f for f in fps if "Fiducial" not in f["name"]]
viol      = {"edge": [], "hole": [], "gap": [], "fiducial": []}

for f in others:
    d_edge = min(f["x0"] - BX0, BX1 - f["x1"], f["y0"] - BY0, BY1 - f["y1"])
    if d_edge < EDGE_MM:
        viol["edge"].append(f"{f['ref']} ({d_edge:.1f} mm to edge)")
    for hx, hy in holes:
        dx = max(f["x0"] - hx, hx - f["x1"], 0)
        dy = max(f["y0"] - hy, hy - f["y1"], 0)
        d  = (dx * dx + dy * dy) ** 0.5
        if d < HOLE_KEEPOUT_MM:
            viol["hole"].append(f"{f['ref']} ({d:.1f} mm to hole at {hx - BX0:.0f},{hy - BY0:.0f})")

for i, a in enumerate(others):
    for bfp in others[i + 1:]:
        dx = max(a["x0"] - bfp["x1"], bfp["x0"] - a["x1"])
        dy = max(a["y0"] - bfp["y1"], bfp["y0"] - a["y1"])
        if dx < CY_GAP_MM and dy < CY_GAP_MM and max(dx, dy) > -0.01:
            viol["gap"].append(f"{a['ref']} <-> {bfp['ref']} ({max(dx, dy):.2f} mm)")

if len(fiducials) < 3:
    viol["fiducial"].append(f"{len(fiducials)} fiducials present, need >= 3")

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
        print(f"  [{k}] {item}")
sys.exit(0 if result["pass"] else 1)
