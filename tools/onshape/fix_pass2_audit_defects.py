"""Fix pass 2: resolve the 19 park-position defects from the Run 5 audit.

X axis: coupling pulled off the BK12 (357-378); journal shortened to butt the
motor shaft (300-360); flange to r19 (trimmed-flat representation) so it
clears the saddle plane; housing extended up to the saddle bottom (Z 76-110);
limit switches shifted to Y -320..-312 clear of the rail.

Y axis: rails/blocks spread to centers +/-32 so the ballnut fits between the
block pairs; bare flange deleted (integrated-flange nut in a housing);
nut housing added (X +/-14, Z 168-192, bolts to adapter underside); journal
260-300, coupling/shaft 302-318 (coupling and shaft pass the motor plate
through its clearance bore).

Z axis: probe interface pad narrowed to X 75-86 (mounting tab marker only —
the real probe bracket is EVT Pass 2 scope) so the slide sweep clears the
bottom bushing and screw.
"""

from __future__ import annotations

import warnings

warnings.filterwarnings("ignore")

from onshape_client import Client
from features import FeatureBuilder, circle, rect

DID = "cfd5d2c28305575210ed8678"
WID = "6bf7390efd64f5e66777f769"
EID = "3ebb146a22425b80a016f78c"

DELETE = [
    "X Jaw Coupling", "X Screw Journal", "X Ballnut Flange",
    "X Ballnut Housing", "X Limit Switches",
    "Y HGR15 Rails", "Y HGH15 Blocks", "Y Ballnut Flange",
    "Y Screw Journal", "Y Jaw Coupling", "Y Motor Shaft",
    "Z Probe Interface Pad",
]


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)
    top = fb.plane_param("Sketch - Base Frame")
    right = fb.plane_param("Sketch - X Ballscrew")
    front = fb.plane_param("Sketch - Y Ballscrew")

    print("== deleting superseded features ==")
    names = {}
    for f in fb.get_features()["features"]:
        names.setdefault(f.get("name", ""), []).append(f["featureId"])
    for base in DELETE:
        for prefix in ("EVT - ", "Sketch EVT - "):
            for fid in names.get(prefix + base, []):
                fb.delete_feature(fid)
                print("  deleted", prefix + base)

    existing = {f.get("name") for f in fb.get_features()["features"]}

    def build(name, plane, entities, depth, offset, namer,
              symmetric=False, opposite=False, offset_opposite=False):
        if "EVT - " + name in existing:
            print("  (skip, exists)", name)
            return
        before = set(fb.parts())
        sk = fb.add_sketch("Sketch EVT - " + name, plane, entities)
        fb.add_extrude("EVT - " + name, sk, depth_mm=depth, offset_mm=offset,
                       symmetric=symmetric, opposite=opposite,
                       offset_opposite=offset_opposite)
        for pid in set(fb.parts()) - before:
            bb = fb.bbox(pid)
            fb.rename_part(pid, namer(bb))
            print("  {}  X[{:.1f},{:.1f}] Y[{:.1f},{:.1f}] Z[{:.1f},{:.1f}]".format(
                namer(bb), bb["lowX"], bb["highX"], bb["lowY"], bb["highY"],
                bb["lowZ"], bb["highZ"]))

    yx, z95 = -0.257, 0.095
    print("== X axis fixes ==")
    build("X Screw Journal", right, [circle("jn", yx, z95, 0.005)],
          depth=60.0, offset=300.0,
          namer=lambda bb: "X Axis - Screw Journal")
    build("X Jaw Coupling", right, [circle("cp", yx, z95, 0.0125)],
          depth=21.0, offset=357.0,
          namer=lambda bb: "X Axis - Jaw Coupling")
    build("X Ballnut Flange", right, [circle("bfl", yx, z95, 0.019)],
          depth=10.0, offset=10.0, offset_opposite=True,
          namer=lambda bb: "X Axis - Ballnut Flange")
    build("X Ballnut Housing", top, rect("nh", -0.005, -0.276, 0.045, -0.238),
          depth=34.0, offset=76.0,
          namer=lambda bb: "X Axis - Ballnut Housing")
    def x_sw(bb):
        if bb["highX"] < -100: return "X Axis - Limit Switch Min"
        if bb["lowX"] > 100: return "X Axis - Limit Switch Max"
        return "X Axis - Limit Switch Home"
    build("X Limit Switches", top,
          rect("mn", -0.270, -0.320, -0.250, -0.312) +
          rect("hm", -0.010, -0.320, 0.010, -0.312) +
          rect("mx", 0.250, -0.320, 0.270, -0.312),
          depth=3.5, offset=80.0, namer=x_sw)

    print("== Y axis fixes ==")
    build("Y HGR15 Rails", top,
          rect("rl", -0.0395, -0.270, -0.0245, 0.270) +
          rect("rr", 0.0245, -0.270, 0.0395, 0.270),
          depth=15.0, offset=168.0,
          namer=lambda bb: "Y Axis - HGR15 Rail {}".format(
              "Right" if bb["lowX"] > 0 else "Left"))
    ents = []
    n = 0
    for xc in (-0.032, 0.032):
        for yc in (-0.035, 0.035):
            n += 1
            ents += rect("b{}".format(n), xc - 0.017, yc - 0.0307,
                         xc + 0.017, yc + 0.0307)
    def y_block(bb):
        idx = {(False, False): 1, (False, True): 2,
               (True, False): 3, (True, True): 4}[
            (bb["lowX"] > 0, bb["lowY"] > 0)]
        return "Y Axis - HGH15 Carriage Block {}".format(idx)
    build("Y HGH15 Blocks", top, ents, depth=19.4, offset=172.6, namer=y_block)
    build("Y Ballnut Housing", top, rect("nh", -0.014, -0.025, 0.014, 0.025),
          depth=24.0, offset=168.0,
          namer=lambda bb: "Y Axis - Ballnut Housing")
    z180 = 0.180
    build("Y Screw Journal", front, [circle("jn", 0.0, z180, 0.004)],
          depth=40.0, offset=260.0, opposite=True, offset_opposite=True,
          namer=lambda bb: "Y Axis - Screw Journal")
    build("Y Jaw Coupling", front, [circle("cp", 0.0, z180, 0.010)],
          depth=16.0, offset=302.0, opposite=True, offset_opposite=True,
          namer=lambda bb: "Y Axis - Jaw Coupling")
    build("Y Motor Shaft", front, [circle("ms", 0.0, z180, 0.004)],
          depth=16.0, offset=302.0, opposite=True, offset_opposite=True,
          namer=lambda bb: "Y Axis - Motor Shaft")

    print("== Z axis fix ==")
    build("Z Probe Interface Pad", top, rect("pp", 0.075, -0.030, 0.086, 0.030),
          depth=10.0, offset=100.0,
          namer=lambda bb: "Z Axis - Probe Interface Pad")

    bad = {fid: st for fid, st in fb.feature_states().items() if st != "OK"}
    print("\nnon-OK feature states:", bad if bad else "none")


if __name__ == "__main__":
    main()
