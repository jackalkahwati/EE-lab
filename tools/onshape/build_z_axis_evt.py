"""Build the EVT Z stack via the Onshape API.

Run 3 of the EVT motion pass, non-destructive. Key engineering change
(reported in output): the Z stack is SIDE-MOUNTED on the +X face of the Y
carriage, not front-mounted. The beam spans the full Y width at X +/-45,
Z 98-168, so any Z stage at the carriage front face must pass through the
beam — that is exactly the v4 embedded-slide defect. Offsetting the stack
to X 50+ clears the beam by 5 mm at all Y positions; the probe centerline
moves to X ~100 (a fixed calibration offset).

Stack (bottom to top): side plate on the carriage adapter edge, two
vertical MGN12 rails + MGN12H blocks, slide plate, probe interface pad at
the slide bottom (the future probe-head mounting datum), SFU1204 vertical
screw with ballnut + housing, bottom bushing, BK10 top support, jaw
coupling, NEMA23 motor on a top plate.
"""

from __future__ import annotations

import warnings

warnings.filterwarnings("ignore")

from onshape_client import Client
from features import FeatureBuilder, circle, rect

DID = "cfd5d2c28305575210ed8678"
WID = "6bf7390efd64f5e66777f769"
EID = "3ebb146a22425b80a016f78c"


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)
    top = fb.plane_param("Sketch - Base Frame")

    count = 0

    def build(name, entities, depth, offset, namer):
        nonlocal count
        if "EVT - " + name in {f.get("name") for f in fb.get_features()["features"]}:
            print("  (skipped — already built)")
            return
        before = set(fb.parts())
        sk = fb.add_sketch("Sketch EVT - " + name, top, entities)
        fb.add_extrude("EVT - " + name, sk, depth_mm=depth, offset_mm=offset)
        for pid in set(fb.parts()) - before:
            bb = fb.bbox(pid)
            part_name = namer(bb)
            fb.rename_part(pid, part_name)
            count += 1
            print("  {}  X[{:.1f},{:.1f}] Y[{:.1f},{:.1f}] Z[{:.1f},{:.1f}]".format(
                part_name, bb["lowX"], bb["highX"], bb["lowY"], bb["highY"],
                bb["lowZ"], bb["highZ"]))

    print("== carriage side plate ==")
    build("Z Side Plate", rect("sp", 0.050, -0.060, 0.062, 0.060),
          depth=195.0, offset=85.0,
          namer=lambda bb: "Z Axis - Carriage Side Plate")

    print("== MGN12 rails (vertical) ==")
    build("Z MGN12 Rails",
          rect("r1", 0.062, -0.026, 0.070, -0.014) +
          rect("r2", 0.062, 0.014, 0.070, 0.026),
          depth=180.0, offset=90.0,
          namer=lambda bb: "Z Axis - MGN12 Rail {}".format(
              "Rear" if bb["lowY"] > 0 else "Front"))

    print("== MGN12H blocks ==")
    build("Z MGN12H Blocks",
          rect("b1", 0.062, -0.0335, 0.075, -0.0065) +
          rect("b2", 0.062, 0.0065, 0.075, 0.0335),
          depth=45.4, offset=160.0,
          namer=lambda bb: "Z Axis - MGN12H Block {}".format(
              "Rear" if bb["lowY"] > 0 else "Front"))

    print("== slide plate ==")
    build("Z Slide Plate", rect("sl", 0.075, -0.035, 0.083, 0.035),
          depth=150.0, offset=110.0,
          namer=lambda bb: "Z Axis - Slide Plate")

    print("== probe interface pad ==")
    build("Z Probe Interface Pad", rect("pp", 0.075, -0.030, 0.125, 0.030),
          depth=10.0, offset=100.0,
          namer=lambda bb: "Z Axis - Probe Interface Pad")

    print("== ballnut housing + bottom bushing + BK10 + motor plate ==")
    build("Z Ballnut Housing", rect("nh", 0.083, -0.015, 0.115, 0.015),
          depth=45.0, offset=155.0,
          namer=lambda bb: "Z Axis - Ballnut Housing")
    build("Z Bottom Bushing", rect("bb", 0.087, -0.012, 0.111, 0.012),
          depth=15.0, offset=88.0,
          namer=lambda bb: "Z Axis - Bottom Bushing Block")
    build("Z BK10 Top Support", rect("bk", 0.084, -0.015, 0.114, 0.015),
          depth=20.0, offset=270.0,
          namer=lambda bb: "Z Axis - BK10 Top Support")
    build("Z Motor Plate", rect("mp", 0.074, -0.025, 0.124, 0.025),
          depth=8.0, offset=320.0,
          namer=lambda bb: "Z Axis - Motor Plate")

    print("== motor body ==")
    build("Z NEMA23 Body", rect("mb", 0.0705, -0.0285, 0.1275, 0.0285),
          depth=56.0, offset=328.0,
          namer=lambda bb: "Z Axis - NEMA23 Motor Body")

    # vertical cylinders, screw axis at (99, 0)
    cx = 0.099
    print("== screw / journal / nut / flange / coupling / shaft ==")
    build("Z SFU1204 Screw", [circle("sc", cx, 0.0, 0.006)],
          depth=175.0, offset=95.0,
          namer=lambda bb: "Z Axis - SFU1204 Ballscrew")
    build("Z Screw Journal", [circle("jn", cx, 0.0, 0.004)],
          depth=38.0, offset=270.0,
          namer=lambda bb: "Z Axis - Screw Journal")
    build("Z Ballnut", [circle("bn", cx, 0.0, 0.012)],
          depth=35.0, offset=160.0,
          namer=lambda bb: "Z Axis - SFU1204 Ballnut")
    build("Z Ballnut Flange", [circle("bf", cx, 0.0, 0.016)],
          depth=10.0, offset=195.0,
          namer=lambda bb: "Z Axis - Ballnut Flange")
    build("Z Jaw Coupling", [circle("cp", cx, 0.0, 0.010)],
          depth=20.0, offset=295.0,
          namer=lambda bb: "Z Axis - Jaw Coupling")
    build("Z Motor Shaft", [circle("ms", cx, 0.0, 0.004)],
          depth=20.0, offset=308.0,
          namer=lambda bb: "Z Axis - Motor Shaft")

    print("\n== audit ==")
    bad = {fid: st for fid, st in fb.feature_states().items() if st != "OK"}
    print("non-OK feature states:", bad if bad else "none")
    print("new bodies created:", count)


if __name__ == "__main__":
    main()
