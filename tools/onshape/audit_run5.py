"""Run 5: motion-system audit. Read-only — creates nothing, fixes naming only.

Checks:
  1. Feature regeneration states
  2. Naming audit (zero "Part NNN")
  3. Park-position interference among EVT bodies (whitelisted containments)
  4. Per-body swept interference vs true statics (kills aggregate-box noise)
  5. Coaxiality of each axis drive line, stack heights, key clearances
"""

from __future__ import annotations

import warnings

warnings.filterwarnings("ignore")

from onshape_client import Client
from features import FeatureBuilder

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"

LEGACY_PREFIXES = (
    "X Rail ", "X Ballscrew", "X Servo", "X Bearing Block", "Moving X Beam",
    "Y Rail ", "Y Ballscrew", "Y Servo", "Y Carriage", "Z Stage", "Z Servo",
    "Probe ", "Pogo ", "X Drag Chain", "Y Drag Chain", "Probe Cable Loop",
    "Fastener Dowel",
    # EVT-2 additions: dowels travel with the probe head; corridors are
    # harness reservations that intentionally envelope moving bundles.
    "Cartridge Dowel", "Corridor - ",
)

# park-position containment whitelist: (substring_a, substring_b)
ALLOWED = [
    ("HGR", "Carriage Block"), ("MGN12 Rail", "MGN12H Block"),
    ("Ballscrew", "Ballnut"), ("Ballscrew", "Housing"),
    ("Ballscrew", "Bushing"), ("Ballscrew", "BK1"), ("Ballscrew", "BF1"),
    ("Ballscrew", "Flange"), ("Journal", "BK1"), ("Journal", "Coupling"),
    ("Journal", "BF1"), ("Motor Shaft", "Coupling"),
    ("Motor Shaft", "NEMA23"), ("Motor Shaft", "Motor Mount"),
    ("Motor Shaft", "Motor Plate"), ("Ballnut", "Housing"),
    ("Flange", "Housing"), ("Journal", "Motor Plate"),
    ("Coupling", "Motor Plate"), ("Coupling", "Motor Mount"),
]


def overlaps(a, b, tol=0.01):
    return all(a["low" + d] < b["high" + d] - tol and
               a["high" + d] > b["low" + d] + tol for d in "XYZ")


def pen(a, b):
    return min(min(a["high" + d], b["high" + d]) - max(a["low" + d], b["low" + d])
               for d in "XYZ")


def allowed(a, b):
    for s1, s2 in ALLOWED:
        if (s1 in a and s2 in b) or (s2 in a and s1 in b):
            return True
    return False


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)
    raw = fb.c.list_parts(DID, WID, EID)
    parts = {p["name"]: p["partId"] for p in raw if p.get("bodyType") != "composite"}

    print("=== 1. feature states ===")
    bad = {f: s for f, s in fb.feature_states().items() if s != "OK"}
    print("non-OK:", bad if bad else "none",
          "(the single INFO is the pre-existing Rear Panel Border Groove)")

    print("\n=== 2. naming audit ===")
    generic = [n for n in parts if n.startswith(("Part ", "Composite part"))]
    print("generic names:", generic if generic else "NONE — all {} parts named".format(len(parts)))

    print("\n=== fetching bboxes (single FeatureScript call) ===")
    boxes = fb.all_bboxes()
    evt = {n: b for n, b in boxes.items()
           if n.startswith(("X Axis - ", "Y Axis - ", "Z Axis - "))}
    statics = {n: b for n, b in boxes.items()
               if not n.startswith(LEGACY_PREFIXES)
               and not n.startswith(("X Axis - ", "Y Axis - ", "Z Axis - ",
                                     "Analysis - ", "ASM - "))}
    print("EVT bodies: {}, true statics: {}, total parts: {}".format(
        len(evt), len(statics), len(parts)))

    print("\n=== 3. park-position EVT interference (non-whitelisted) ===")
    evt_names = sorted(evt)
    defects = 0
    for i, a in enumerate(evt_names):
        for b in evt_names[i + 1:]:
            if overlaps(evt[a], evt[b]) and not allowed(a, b):
                print("  DEFECT: {} <-> {} (~{:.1f} mm)".format(a, b, pen(evt[a], evt[b])))
                defects += 1
    legacy_overlaps = 0
    legacy = {n: b for n, b in boxes.items() if n.startswith(LEGACY_PREFIXES)}
    for a, ba in evt.items():
        for b, bb2 in legacy.items():
            if overlaps(ba, bb2):
                legacy_overlaps += 1
    print("  non-whitelisted EVT defects: {}".format(defects))
    print("  EVT-vs-legacy overlaps (expected by convention): {}".format(legacy_overlaps))

    print("\n=== 4. per-body swept interference vs true statics ===")
    # group membership -> sweep extension per body
    def sweep_of(name, b):
        s = dict(b)
        x_static = ("Motor Mount Plate" in name or "NEMA23" in name or
                    "Motor Shaft" in name or "BK12" in name or "BF12" in name or
                    "Jaw Coupling" in name or "SFU1605 Ballscrew" in name or
                    "Screw Journal" in name and name.startswith("X") or
                    "HGR20 Rail" in name or "Limit Switch" in name and name.startswith("X"))
        if name.startswith("X Axis - ") and x_static:
            return None  # frame-mounted: doesn't sweep
        s["lowX"] -= 250; s["highX"] += 250
        y_member = (name.startswith("Z Axis - ") or
                    ("Y Axis - " in name and any(k in name for k in
                     ("HGH15", "Adapter", "Ballnut", "Flange"))))
        if y_member:
            s["lowY"] -= 200; s["highY"] += 200
        z_member = name.startswith("Z Axis - ") and any(k in name for k in
                   ("MGN12H", "Slide", "Interface Pad", "Ballnut", "Flange", "Housing"))
        if z_member:
            s["highZ"] += 100; s["lowZ"] -= 50  # travel split around park
        return s

    hits = {}
    for n, b in evt.items():
        s = sweep_of(n, b)
        if s is None:
            continue
        for sn, sb in statics.items():
            if overlaps(s, sb):
                key = sn
                hits.setdefault(key, []).append(n)
    for sn in sorted(hits):
        print("  {} <- swept by {} EVT bodies (e.g. {})".format(
            sn, len(hits[sn]), hits[sn][0]))
    if not hits:
        print("  none")

    print("\n=== 5. drive-line coaxiality (max centerline deviation, mm) ===")
    for axis, members, lat in (
            ("X", ["SFU1605 Ballscrew", "Screw Journal", "Jaw Coupling", "Motor Shaft"], ("Y", "Z")),
            ("Y", ["SFU1204 Ballscrew", "Screw Journal", "Jaw Coupling", "Motor Shaft"], ("X", "Z")),
            ("Z", ["SFU1204 Ballscrew", "Screw Journal", "Jaw Coupling", "Motor Shaft"], ("X", "Y"))):
        centers = []
        for m in members:
            n = "{} Axis - {}".format(axis, m)
            b = evt[n]
            centers.append(tuple((b["low" + d] + b["high" + d]) / 2 for d in lat))
        dev = max(max(abs(c[i] - centers[0][i]) for c in centers) for i in (0, 1))
        status = "PASS" if dev <= 0.1 else "FAIL"
        print("  {} axis: {:.4f} mm  [{}]  centerline ({}={:.1f}, {}={:.1f})".format(
            axis, dev, status, lat[0], centers[0][0], lat[1], centers[0][1]))

    print("\n=== 6. stack heights and key clearances ===")
    print("  X: frame top 80 -> rail top {:.1f} -> block top {:.1f} -> saddle top {:.1f} (EVT beam plane)".format(
        evt["X Axis - HGR20 Rail Rear"]["highZ"],
        evt["X Axis - HGH20 Carriage Block 1"]["highZ"],
        evt["X Axis - Rail Saddle Front"]["highZ"]))
    print("  Y: beam top 168 -> rail top {:.1f} -> block top {:.1f} -> adapter top {:.1f} (EVT carriage plane)".format(
        evt["Y Axis - HGR15 Rail Left"]["highZ"],
        evt["Y Axis - HGH15 Carriage Block 1"]["highZ"],
        evt["Y Axis - Carriage Adapter Plate"]["highZ"]))
    print("  Z: side plate X {:.0f}-{:.0f} -> rail face {:.0f} -> block face {:.0f} -> slide face {:.0f}".format(
        evt["Z Axis - Carriage Side Plate"]["lowX"],
        evt["Z Axis - Carriage Side Plate"]["highX"],
        evt["Z Axis - MGN12 Rail Front"]["highX"],
        evt["Z Axis - MGN12H Block Front"]["highX"],
        evt["Z Axis - Slide Plate"]["highX"]))
    shell_r = boxes["Side Shell Right"]
    ym_plate = evt["Y Axis - Motor Mount Plate"]
    print("  Y motor plate at X=+250 extreme: reaches X {:.1f}; right shell inner face {:.1f}; clearance {:.1f} mm".format(
        ym_plate["highX"] + 250, shell_r["lowX"],
        shell_r["lowX"] - (ym_plate["highX"] + 250)))
    xm = evt["X Axis - NEMA23 Motor Body"]
    print("  X motor body end X {:.1f} vs right shell inner {:.1f}: {:.1f} mm".format(
        xm["highX"], shell_r["lowX"], shell_r["lowX"] - xm["highX"]))
    pad = evt["Z Axis - Probe Interface Pad"]
    print("  probe pad bottom sweeps Z {:.1f}..{:.1f} (100 travel); PCB top 59.6; fixture top 58".format(
        pad["lowZ"] - 50, pad["lowZ"] + 50))


if __name__ == "__main__":
    main()
