"""Build the EVT Y axis on the Moving X Beam via the Onshape API.

Run 2 of the EVT motion pass, non-destructive. Engineering deviations from
the prompt text (reported in output):
- New rails lengthened to Y +/-270 (legacy 480 mm was shorter than the
  block sweep at +/-200 travel: blocks reach Y +/-265.7).
- EVT screw centerline at Z=180 (legacy 177) so the O20 coupling clears the
  beam top at Z=168.
- BK10/BF10 placed beyond the rail ends (Y 275..300) on the beam top.
- EVT carriage plane is the new adapter plate top at Z=200; the legacy
  Y Carriage (Z 168-218) stays as reference and overlaps it.
- Motor hangs off the beam +Y end face on a mount plate at Y 310-318;
  coupling/shaft cross the plate plane through an implied clearance bore.
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
    front = fb.plane_param("Sketch - Y Ballscrew")

    count = 0

    existing_names = set(fb.parts().values())

    def build(name, plane, entities, depth, offset, namer,
              symmetric=False, opposite=False, offset_opposite=False):
        nonlocal count
        if "EVT - " + name in {f.get("name") for f in fb.get_features()["features"]}:
            print("  (skipped — already built)")
            return
        before = set(fb.parts())
        sk = fb.add_sketch("Sketch EVT - " + name, plane, entities)
        fb.add_extrude("EVT - " + name, sk, depth_mm=depth, offset_mm=offset,
                       symmetric=symmetric, opposite=opposite,
                       offset_opposite=offset_opposite)
        for pid in set(fb.parts()) - before:
            bb = fb.bbox(pid)
            part_name = namer(bb)
            fb.rename_part(pid, part_name)
            count += 1
            print("  {}  X[{:.1f},{:.1f}] Y[{:.1f},{:.1f}] Z[{:.1f},{:.1f}]".format(
                part_name, bb["lowX"], bb["highX"], bb["lowY"], bb["highY"],
                bb["lowZ"], bb["highZ"]))

    print("== rails ==")
    build("Y HGR15 Rails", top,
          rect("rl", -0.0355, -0.270, -0.0205, 0.270) +
          rect("rr", 0.0205, -0.270, 0.0355, 0.270),
          depth=15.0, offset=168.0,
          namer=lambda bb: "Y Axis - HGR15 Rail {}".format(
              "Right" if bb["lowX"] > 0 else "Left"))

    print("== carriage blocks ==")
    ents = []
    n = 0
    for xc in (-0.028, 0.028):
        for yc in (-0.035, 0.035):
            n += 1
            ents += rect("b{}".format(n), xc - 0.017, yc - 0.0307,
                         xc + 0.017, yc + 0.0307)
    def block_namer(bb):
        idx = {(False, False): 1, (False, True): 2,
               (True, False): 3, (True, True): 4}[
            (bb["lowX"] > 0, bb["lowY"] > 0)]
        return "Y Axis - HGH15 Carriage Block {}".format(idx)
    build("Y HGH15 Blocks", top, ents, depth=19.4, offset=172.6,
          namer=block_namer)

    print("== carriage adapter plate ==")
    build("Y Carriage Adapter", top, rect("ca", -0.050, -0.070, 0.050, 0.070),
          depth=8.0, offset=192.0,
          namer=lambda bb: "Y Axis - Carriage Adapter Plate")

    print("== screw end supports ==")
    build("Y Screw Supports", top,
          rect("bk", -0.030, 0.275, 0.030, 0.300) +
          rect("bf", -0.030, -0.300, 0.030, -0.275),
          depth=32.0, offset=168.0,
          namer=lambda bb: ("Y Axis - BK10 Fixed Support" if bb["lowY"] > 0
                            else "Y Axis - BF10 Floating Support"))

    print("== motor mount plate ==")
    build("Y Motor Mount Plate", top, rect("mp", -0.040, 0.310, 0.040, 0.318),
          depth=80.0, offset=140.0,
          namer=lambda bb: "Y Axis - Motor Mount Plate")

    print("== motor body ==")
    build("Y NEMA23 Body", top, rect("mb", -0.0285, 0.318, 0.0285, 0.374),
          depth=57.0, offset=151.5,
          namer=lambda bb: "Y Axis - NEMA23 Motor Body")

    # Front plane: local-x = world X, local-y = world Z.
    # +Y placement: opposite=True, offset_opposite=True, span [offset, offset+depth].
    z = 0.180
    print("== ballscrew (symmetric +/-260) ==")
    build("Y SFU1204 Screw", front, [circle("sc", 0.0, z, 0.006)],
          depth=520.0, offset=None, symmetric=True,
          namer=lambda bb: "Y Axis - SFU1204 Ballscrew")

    print("== screw journal ==")
    build("Y Screw Journal", front, [circle("jn", 0.0, z, 0.004)],
          depth=52.0, offset=260.0, opposite=True, offset_opposite=True,
          namer=lambda bb: "Y Axis - Screw Journal")

    print("== ballnut + flange ==")
    build("Y Ballnut", front, [circle("bn", 0.0, z, 0.012)],
          depth=40.0, offset=None, symmetric=True,
          namer=lambda bb: "Y Axis - SFU1204 Ballnut")
    build("Y Ballnut Flange", front, [circle("bfl", 0.0, z, 0.020)],
          depth=10.0, offset=20.0, opposite=True, offset_opposite=True,
          namer=lambda bb: "Y Axis - Ballnut Flange")

    print("== coupling + motor shaft ==")
    build("Y Jaw Coupling", front, [circle("cp", 0.0, z, 0.010)],
          depth=24.0, offset=290.0, opposite=True, offset_opposite=True,
          namer=lambda bb: "Y Axis - Jaw Coupling")
    build("Y Motor Shaft", front, [circle("ms", 0.0, z, 0.004)],
          depth=20.0, offset=298.0, opposite=True, offset_opposite=True,
          namer=lambda bb: "Y Axis - Motor Shaft")

    print("\n== audit ==")
    bad = {fid: st for fid, st in fb.feature_states().items()
           if st not in ("OK",)}
    print("non-OK feature states:", bad if bad else "none (1 pre-existing INFO expected)")
    print("new bodies created:", count)


if __name__ == "__main__":
    main()
