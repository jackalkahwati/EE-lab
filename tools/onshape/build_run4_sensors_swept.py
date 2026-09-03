"""Run 4: limit switches, home sensors, swept-volume analysis bodies, and
the static-clearance report.

Swept volumes are computed from the as-built EVT bodies: aggregate bbox of
each moving group extended by its travel (X +/-250, Y +/-200, Z +100 up).
Every static body is then bbox-tested against the swept boxes; legacy
envelope bodies and cosmetic chains are excluded from the report.
"""

from __future__ import annotations

import warnings

warnings.filterwarnings("ignore")

from onshape_client import Client
from features import FeatureBuilder, rect

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"

# EVT moving-group membership (by name prefix/suffix logic below)
X_STATIC_SUFFIX = ("Motor Mount Plate", "NEMA23 Motor Body", "Motor Shaft",
                   "BK12 Fixed Support", "BF12 Floating Support",
                   "Jaw Coupling", "SFU1605 Ballscrew", "Screw Journal",
                   "HGR20 Rail Front", "HGR20 Rail Rear",
                   "Limit Switch Min", "Limit Switch Home", "Limit Switch Max")
Y_MOVING_SUFFIX = ("HGH15 Carriage Block", "Carriage Adapter Plate",
                   "SFU1204 Ballnut", "Ballnut Flange")
Z_MOVING_SUFFIX = ("MGN12H Block", "Slide Plate", "Probe Interface Pad",
                   "Ballnut Housing", "SFU1204 Ballnut", "Ballnut Flange")

LEGACY_EXCLUDE_PREFIXES = (
    "X Rail ", "X Ballscrew", "X Servo", "X Bearing Block", "Moving X Beam",
    "Y Rail ", "Y Ballscrew", "Y Servo", "Y Carriage", "Z Stage", "Z Servo",
    "Probe ", "Pogo ", "X Drag Chain", "Y Drag Chain", "Probe Cable Loop",
    "X Axis - ", "Y Axis - ", "Z Axis - ", "Analysis - ", "ASM - ",
)


def overlaps(a, b):
    return (a["lowX"] < b["highX"] and a["highX"] > b["lowX"] and
            a["lowY"] < b["highY"] and a["highY"] > b["lowY"] and
            a["lowZ"] < b["highZ"] and a["highZ"] > b["lowZ"])


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)
    top = fb.plane_param("Sketch - Base Frame")

    def build(name, entities, depth, offset, namer):
        if "EVT - " + name in {f.get("name") for f in fb.get_features()["features"]}:
            print("  (skipped — already built)")
            return
        before = set(fb.parts())
        sk = fb.add_sketch("Sketch EVT - " + name, top, entities)
        fb.add_extrude("EVT - " + name, sk, depth_mm=depth, offset_mm=offset)
        for pid in set(fb.parts()) - before:
            bb = fb.bbox(pid)
            fb.rename_part(pid, namer(bb))
            print("  {}  X[{:.0f},{:.0f}] Y[{:.0f},{:.0f}] Z[{:.0f},{:.0f}]".format(
                namer(bb), bb["lowX"], bb["highX"], bb["lowY"], bb["highY"],
                bb["lowZ"], bb["highZ"]))

    print("== X limit switches (frame front rail side) ==")
    def x_sw(bb):
        if bb["highX"] < -100: return "X Axis - Limit Switch Min"
        if bb["lowX"] > 100: return "X Axis - Limit Switch Max"
        return "X Axis - Limit Switch Home"
    build("X Limit Switches",
          rect("mn", -0.270, -0.288, -0.250, -0.278) +
          rect("hm", -0.010, -0.288, 0.010, -0.278) +
          rect("mx", 0.250, -0.288, 0.270, -0.278),
          depth=7.0, offset=80.0, namer=x_sw)

    print("== Y limit switches (beam left side) ==")
    def y_sw(bb):
        if bb["highY"] < -100: return "Y Axis - Limit Switch Min"
        if bb["lowY"] > 100: return "Y Axis - Limit Switch Max"
        return "Y Axis - Limit Switch Home"
    build("Y Limit Switches",
          rect("mn", -0.060, -0.210, -0.050, -0.190) +
          rect("hm", -0.060, -0.010, -0.050, 0.010) +
          rect("mx", -0.060, 0.190, -0.050, 0.210),
          depth=7.0, offset=168.0, namer=y_sw)

    print("== Z limit switches (side plate face) ==")
    def z_sw(bb):
        if bb["highZ"] < 140: return "Z Axis - Limit Switch Min"
        if bb["lowZ"] > 220: return "Z Axis - Limit Switch Max"
        return "Z Axis - Limit Switch Home"
    for nm, z0 in (("Z Limit Switch Min", 100.0), ("Z Limit Switch Home", 175.0),
                   ("Z Limit Switch Max", 250.0)):
        build(nm, rect("sw", 0.062, -0.045, 0.070, -0.035),
              depth=7.0, offset=z0, namer=z_sw)

    # ---- swept volumes from as-built extents ------------------------------
    print("\n== computing moving-group extents ==")
    parts = {p["name"]: p["partId"]
             for p in fb.c.list_parts(DID, WID, EID)
             if p.get("bodyType") != "composite"}

    def agg(names):
        boxes = [fb.bbox(parts[n]) for n in names]
        return {
            "lowX": min(b["lowX"] for b in boxes),
            "highX": max(b["highX"] for b in boxes),
            "lowY": min(b["lowY"] for b in boxes),
            "highY": max(b["highY"] for b in boxes),
            "lowZ": min(b["lowZ"] for b in boxes),
            "highZ": max(b["highZ"] for b in boxes),
        }

    x_moving = [n for n in parts
                if (n.startswith("X Axis - ") and not n.endswith(X_STATIC_SUFFIX))
                or n.startswith(("Y Axis - ", "Z Axis - "))]
    x_moving = [n for n in x_moving if "Limit Switch" not in n]
    y_moving = [n for n in parts
                if (n.startswith("Y Axis - ") and any(s in n for s in Y_MOVING_SUFFIX))
                or n.startswith("Z Axis - ")]
    y_moving = [n for n in y_moving if "Limit Switch" not in n]
    z_moving = [n for n in parts if n.startswith("Z Axis - ")
                and any(s in n for s in Z_MOVING_SUFFIX)]

    gx, gy, gz = agg(x_moving), agg(y_moving), agg(z_moving)
    sweeps = {
        "Analysis - Swept Volume X": dict(gx, lowX=gx["lowX"] - 250, highX=gx["highX"] + 250),
        "Analysis - Swept Volume Y": dict(gy, lowY=gy["lowY"] - 200, highY=gy["highY"] + 200),
        "Analysis - Swept Volume Z": dict(gz, highZ=gz["highZ"] + 100),
    }
    for nm, s in sweeps.items():
        print("{}: X[{:.0f},{:.0f}] Y[{:.0f},{:.0f}] Z[{:.0f},{:.0f}]".format(
            nm, s["lowX"], s["highX"], s["lowY"], s["highY"], s["lowZ"], s["highZ"]))

    print("\n== creating swept-volume bodies ==")
    for nm, s in sweeps.items():
        short = nm.replace("Analysis - ", "")
        ents = rect("sv", s["lowX"] / 1000.0, s["lowY"] / 1000.0,
                    s["highX"] / 1000.0, s["highY"] / 1000.0)
        build(short, ents, depth=s["highZ"] - s["lowZ"], offset=s["lowZ"],
              namer=lambda bb, nm=nm: nm)

    # ---- static clearance report ------------------------------------------
    print("\n== static bodies intersecting swept volumes ==")
    statics = {n: pid for n, pid in parts.items()
               if not n.startswith(LEGACY_EXCLUDE_PREFIXES)}
    hits = []
    static_boxes = {n: fb.bbox(pid) for n, pid in statics.items()}
    for sweep_name, s in sweeps.items():
        for n, bb in static_boxes.items():
            if overlaps(s, bb):
                pen_x = min(s["highX"], bb["highX"]) - max(s["lowX"], bb["lowX"])
                pen_y = min(s["highY"], bb["highY"]) - max(s["lowY"], bb["lowY"])
                pen_z = min(s["highZ"], bb["highZ"]) - max(s["lowZ"], bb["lowZ"])
                hits.append((sweep_name, n, min(pen_x, pen_y, pen_z)))
    if hits:
        for sweep_name, n, pen in sorted(hits):
            print("  {} <-> {}  (min penetration ~{:.0f} mm)".format(
                sweep_name.replace("Analysis - ", ""), n, pen))
    else:
        print("  none")

    bad = {fid: st for fid, st in fb.feature_states().items() if st != "OK"}
    print("\nnon-OK feature states:", bad if bad else "none")


if __name__ == "__main__":
    main()
