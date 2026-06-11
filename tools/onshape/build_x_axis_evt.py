"""Build the EVT X axis in Part Studio 1 via the Onshape API.

Implements Run 1 of the EVT motion pass (adam-cad-evt-pass-1-run-prompts.md)
non-destructively: adds vendor-interface geometry alongside the legacy
envelopes, touches nothing existing.

Engineering deviations from the prompt text (reported in output):
- EVT screw centerline at Z=95 (legacy 90): the legacy 10 mm center height
  cannot clear a 25 mm jaw coupling above the frame top at Z=80.
- Carriage blocks at X = +/-75 (prompt said +/-150): the beam is only 90 mm
  wide; +/-150 is outside it. Blocks sit under 240 mm rail saddle plates.
- EVT beam plane lands at Z=120 (block top 110 + 10 saddle); legacy beam
  stays at Z=98 until the legacy-retirement pass.
"""

from __future__ import annotations

import warnings

warnings.filterwarnings("ignore")

from onshape_client import Client
from features import FeatureBuilder, circle, rect

DID = "cfd5d2c28305575210ed8678"
WID = "6bf7390efd64f5e66777f769"
EID = "3ebb146a22425b80a016f78c"

MM = 0.001


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)
    top = fb.plane_param("Sketch - Base Frame")
    right = fb.plane_param("Sketch - X Ballscrew")

    created = {}  # name -> partId

    def build(name, plane, entities, depth, offset, namer, symmetric=False):
        before = set(fb.parts())
        sk = fb.add_sketch("Sketch EVT - " + name, plane, entities)
        fb.add_extrude("EVT - " + name, sk, depth_mm=depth,
                       offset_mm=offset, symmetric=symmetric)
        new = set(fb.parts()) - before
        for pid in new:
            bb = fb.bbox(pid)
            part_name = namer(bb)
            fb.rename_part(pid, part_name)
            created[part_name] = pid
            print("  {}  X[{:.1f},{:.1f}] Y[{:.1f},{:.1f}] Z[{:.1f},{:.1f}]".format(
                part_name, bb["lowX"], bb["highX"], bb["lowY"], bb["highY"],
                bb["lowZ"], bb["highZ"]))

    print("== rails ==")
    build("X HGR20 Rails", top,
          rect("rr", -0.300, 0.290, 0.300, 0.310) +
          rect("rf", -0.300, -0.310, 0.300, -0.290),
          depth=17.5, offset=80.0,
          namer=lambda bb: "X Axis - HGR20 Rail {}".format(
              "Rear" if bb["lowY"] > 0 else "Front"))

    print("== carriage blocks ==")
    ents = []
    coords = []
    n = 0
    for xc in (-0.075, 0.075):
        for yc in (-0.300, 0.300):
            n += 1
            ents += rect("b{}".format(n), xc - 0.03875, yc - 0.0222,
                         xc + 0.03875, yc + 0.0222)
    def block_namer(bb):
        idx = {(False, False): 1, (False, True): 2,
               (True, False): 3, (True, True): 4}[
            (bb["lowX"] > 0, bb["lowY"] > 0)]
        return "X Axis - HGH20 Carriage Block {}".format(idx)
    build("X HGH20 Blocks", top, ents, depth=25.4, offset=84.6,
          namer=block_namer)

    print("== rail saddles ==")
    build("X Rail Saddles", top,
          rect("sr", -0.120, 0.270, 0.120, 0.330) +
          rect("sf", -0.120, -0.330, 0.120, -0.270),
          depth=10.0, offset=110.0,
          namer=lambda bb: "X Axis - Rail Saddle {}".format(
              "Rear" if bb["lowY"] > 0 else "Front"))

    print("== screw end supports ==")
    build("X Screw Supports", top,
          rect("bk", 0.330, -0.030, 0.355, 0.030) +
          rect("bf", -0.300, -0.030, -0.275, 0.030),
          depth=35.0, offset=80.0,
          namer=lambda bb: ("X Axis - BK12 Fixed Support" if bb["lowX"] > 0
                            else "X Axis - BF12 Floating Support"))

    print("== ballnut housing ==")
    build("X Ballnut Housing", top, rect("nh", -0.005, -0.030, 0.055, 0.030),
          depth=22.0, offset=76.0,
          namer=lambda bb: "X Axis - Ballnut Housing")

    print("== motor mount plate ==")
    build("X Motor Mount Plate", top, rect("mp", 0.370, -0.050, 0.380, 0.050),
          depth=100.0, offset=40.0,
          namer=lambda bb: "X Axis - Motor Mount Plate")

    print("== motor body ==")
    build("X NEMA23 Body", top, rect("mb", 0.380, -0.0285, 0.436, 0.0285),
          depth=57.0, offset=66.5,
          namer=lambda bb: "X Axis - NEMA23 Motor Body")

    # Right plane: local-x = world Y, local-y = world Z; extrude default +X.
    z = 0.095
    print("== ballscrew (symmetric +/-300) ==")
    build("X SFU1605 Screw", right, [circle("sc", 0.0, z, 0.008)],
          depth=600.0, offset=None, symmetric=True,
          namer=lambda bb: "X Axis - SFU1605 Ballscrew")

    print("== screw journal ==")
    build("X Screw Journal", right, [circle("jn", 0.0, z, 0.005)],
          depth=65.0, offset=300.0,
          namer=lambda bb: "X Axis - Screw Journal")

    print("== ballnut + flange ==")
    build("X Ballnut", right, [circle("bn", 0.0, z, 0.014)],
          depth=40.0, offset=0.0,
          namer=lambda bb: "X Axis - SFU1605 Ballnut")
    build("X Ballnut Flange", right, [circle("bfl", 0.0, z, 0.024)],
          depth=10.0, offset=40.0,
          namer=lambda bb: "X Axis - Ballnut Flange")

    print("== coupling + motor shaft ==")
    build("X Jaw Coupling", right, [circle("cp", 0.0, z, 0.0125)],
          depth=30.0, offset=348.0,
          namer=lambda bb: "X Axis - Jaw Coupling")
    build("X Motor Shaft", right, [circle("ms", 0.0, z, 0.004)],
          depth=20.0, offset=360.0,
          namer=lambda bb: "X Axis - Motor Shaft")

    # audit
    print("\n== audit ==")
    bad = {fid: st for fid, st in fb.feature_states().items() if st != "OK"}
    print("feature states:", "ALL OK" if not bad else bad)
    print("new bodies created:", len(created))


if __name__ == "__main__":
    main()
