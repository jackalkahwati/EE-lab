"""Fix pass after Run 4 findings: relocate the EVT X drive out of the work
corridor and re-seat the X limit switches.

Changes (EVT bodies only — legacy untouched):
- X drive line moves from (Y=0, Z=95) to (Y=-257, Z=95): inboard of the
  front rail, outside the fixture footprint (Y -210) and outside the
  Z-stack sweep. Nut flange flips to the -X face of the nut so it clears
  the front carriage blocks; nut housing narrows to Y -276..-238 to fit
  the free corridor between the block band (-277.8) and the side-plate
  sweep.
- Z side plate narrows from Y +/-60 to Y +/-35 (rails only span +/-26),
  which pulls the Z-stack sweep in to Y +/-235 and opens that corridor.
- X limit switches become low-profile inductive-style sensors on the
  frame front member (Z 80-83.5, under the 84.6 block sweep plane),
  sensing the saddle/block pass from below.
- Swept volumes are deleted; rebuild them by re-running
  build_run4_sensors_swept.py (idempotent), which also re-runs the report.
"""

from __future__ import annotations

import warnings

warnings.filterwarnings("ignore")

from onshape_client import Client
from features import FeatureBuilder, circle, rect

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"

DELETE_FEATURES = [
    "X SFU1605 Screw", "X Screw Journal", "X Ballnut", "X Ballnut Flange",
    "X Ballnut Housing", "X Screw Supports", "X Motor Mount Plate",
    "X NEMA23 Body", "X Jaw Coupling", "X Motor Shaft", "X Limit Switches",
    "Z Side Plate", "Swept Volume X", "Swept Volume Y", "Swept Volume Z",
]


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)
    top = fb.plane_param("Sketch - Base Frame")
    right = fb.plane_param("Sketch - X Ballscrew")

    print("== deleting superseded features ==")
    feats = fb.get_features()["features"]
    names = {}
    for f in feats:
        names.setdefault(f.get("name", ""), []).append(f["featureId"])
    for base in DELETE_FEATURES:
        for prefix in ("EVT - ", "Sketch EVT - "):
            for fid in names.get(prefix + base, []):
                fb.delete_feature(fid)
                print("  deleted", prefix + base)

    def build(name, plane, entities, depth, offset, namer,
              symmetric=False, offset_opposite=False):
        before = set(fb.parts())
        sk = fb.add_sketch("Sketch EVT - " + name, plane, entities)
        fb.add_extrude("EVT - " + name, sk, depth_mm=depth, offset_mm=offset,
                       symmetric=symmetric, offset_opposite=offset_opposite)
        for pid in set(fb.parts()) - before:
            bb = fb.bbox(pid)
            fb.rename_part(pid, namer(bb))
            print("  {}  X[{:.1f},{:.1f}] Y[{:.1f},{:.1f}] Z[{:.1f},{:.1f}]".format(
                namer(bb), bb["lowX"], bb["highX"], bb["lowY"], bb["highY"],
                bb["lowZ"], bb["highZ"]))

    print("== rebuilt Z side plate (Y +/-35) ==")
    build("Z Side Plate", top, rect("sp", 0.050, -0.035, 0.062, 0.035),
          depth=195.0, offset=85.0,
          namer=lambda bb: "Z Axis - Carriage Side Plate")

    print("== relocated X drive: boxes ==")
    build("X Ballnut Housing", top, rect("nh", -0.005, -0.276, 0.045, -0.238),
          depth=22.0, offset=76.0, namer=lambda bb: "X Axis - Ballnut Housing")
    build("X Screw Supports", top,
          rect("bk", 0.330, -0.277, 0.355, -0.237) +
          rect("bf", -0.300, -0.277, -0.275, -0.237),
          depth=35.0, offset=80.0,
          namer=lambda bb: ("X Axis - BK12 Fixed Support" if bb["lowX"] > 0
                            else "X Axis - BF12 Floating Support"))
    build("X Motor Mount Plate", top, rect("mp", 0.370, -0.285, 0.380, -0.230),
          depth=100.0, offset=40.0,
          namer=lambda bb: "X Axis - Motor Mount Plate")
    build("X NEMA23 Body", top, rect("mb", 0.380, -0.2855, 0.436, -0.2285),
          depth=57.0, offset=66.5,
          namer=lambda bb: "X Axis - NEMA23 Motor Body")

    # Right plane: local-x = +world Y (verified), local-y = world Z.
    y, z = -0.257, 0.095
    print("== relocated X drive: cylinders ==")
    build("X SFU1605 Screw", right, [circle("sc", y, z, 0.008)],
          depth=600.0, offset=None, symmetric=True,
          namer=lambda bb: "X Axis - SFU1605 Ballscrew")
    build("X Screw Journal", right, [circle("jn", y, z, 0.005)],
          depth=65.0, offset=300.0,
          namer=lambda bb: "X Axis - Screw Journal")
    build("X Ballnut", right, [circle("bn", y, z, 0.014)],
          depth=40.0, offset=0.0,
          namer=lambda bb: "X Axis - SFU1605 Ballnut")
    build("X Ballnut Flange", right, [circle("bfl", y, z, 0.024)],
          depth=10.0, offset=10.0, offset_opposite=True,
          namer=lambda bb: "X Axis - Ballnut Flange")
    build("X Jaw Coupling", right, [circle("cp", y, z, 0.0125)],
          depth=30.0, offset=348.0,
          namer=lambda bb: "X Axis - Jaw Coupling")
    build("X Motor Shaft", right, [circle("ms", y, z, 0.004)],
          depth=20.0, offset=360.0,
          namer=lambda bb: "X Axis - Motor Shaft")

    print("== re-seated X limit switches (low-profile, under block sweep) ==")
    def x_sw(bb):
        if bb["highX"] < -100: return "X Axis - Limit Switch Min"
        if bb["lowX"] > 100: return "X Axis - Limit Switch Max"
        return "X Axis - Limit Switch Home"
    build("X Limit Switches", top,
          rect("mn", -0.270, -0.318, -0.250, -0.308) +
          rect("hm", -0.010, -0.318, 0.010, -0.308) +
          rect("mx", 0.250, -0.318, 0.270, -0.308),
          depth=3.5, offset=80.0, namer=x_sw)

    bad = {fid: st for fid, st in fb.feature_states().items() if st != "OK"}
    print("\nnon-OK feature states:", bad if bad else "none")


if __name__ == "__main__":
    main()
