"""Move the E-stop from the front fascia to the rear panel upper-left.

Target: center (X -300, Z +300) on the rear panel outer face (Y 460),
clear of the IEC/connector column (Z <= -36), fans, DUT bulkhead, and
screw rows. The three bodies are Y-axis cylinders, so the front->rear
mirror is pure per-body translation:
  bezel  Y -468..-460 -> 460..468 (dy +928)
  stem   Y -478..-468 -> 468..478 (dy +946)
  cap    Y -490..-478 -> 478..490 (dy +968)
plus (dx -240, dz +360) from the fascia position (-60, Z -60).

Order matters (stale-partId lesson): delete the fascia hole feature
FIRST, then refetch partIds, then transform, then cut the rear hole.
Transforms keep partIds so the Motion Check instances follow.

SAFETY NOTE (documented in the report): a single rear-mounted E-stop is
not reachable from the operator position at the front — ISO 13850 wants
the emergency device readily accessible. Accepted per design direction;
recommend a second front head at DVT.
"""

from __future__ import annotations

import base64
import os
import time
import warnings

warnings.filterwarnings("ignore")

from features import FeatureBuilder, circle
from onshape_client import Client
from phase_e_production import PLANE_FRONT

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"
SCRATCH = os.environ.get("SCRATCH", "/tmp")

DX, DZ = -240.0, 360.0
DY = {"E-Stop Bezel": 928.0, "E-Stop Stem": 946.0, "E-Stop Button Cap": 968.0}


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)

    feats = fb.get_features()
    fnames = {f.get("name"): f.get("featureId") for f in feats["features"]}

    # 1. remove the front fascia hole (restores the fascia wall)
    for fn in ("PROD - EStop Fascia Hole", "PROD - EStop Fascia Hole Sketch"):
        if fn in fnames:
            fb.delete_feature(fnames[fn])
            print("deleted:", fn)
            time.sleep(2)

    # 2. FRESH partIds after the deletion
    parts = {p["name"]: p["partId"] for p in fb.c.list_parts(DID, WID, EID)
             if p.get("bodyType") != "composite"}
    boxes = fb.all_bboxes()

    # 3. per-body mirror transforms (skip if already at rear)
    if boxes["E-Stop Bezel"]["highY"] < 0:
        for n, dy in DY.items():
            fb.transform_translate([parts[n]], DX, dy, DZ,
                                   name="PROD - {} To Rear".format(n))
            print("moved:", n)
            time.sleep(2)
    else:
        print("E-stop already at rear")

    # 4. O22 panel hole through the rear panel (span Y 454..462, both-flags)
    if "PROD - EStop Rear Hole" not in fnames:
        sk = fb.add_sketch("PROD - EStop Rear Hole Sketch", PLANE_FRONT,
                           [circle("esrh", -0.300, 0.300, 0.011)])
        fb.add_extrude_remove("PROD - EStop Rear Hole", sk, depth_mm=8,
                              offset_mm=454,
                              scope_part_ids=[parts["Rear Matte Black Panel"]],
                              opposite=True, offset_opposite=True)
        print("rear panel hole cut")
        time.sleep(2)

    # 5. verify
    boxes2 = fb.all_bboxes()
    ok = True
    for n, want in [("E-Stop Bezel", (-330, -270, 460, 468, 270, 330)),
                    ("E-Stop Stem", (-311, -289, 468, 478, 289, 311)),
                    ("E-Stop Button Cap", (-322.5, -277.5, 478, 490, 277.5, 322.5))]:
        b = boxes2[n]
        got = (b["lowX"], b["highX"], b["lowY"], b["highY"], b["lowZ"], b["highZ"])
        match = all(abs(g - w) < 0.5 for g, w in zip(got, want))
        ok &= match
        print("{:20s} {} X {:7.1f}..{:7.1f} Y {:7.1f}..{:7.1f} Z {:7.1f}..{:7.1f}".format(
            n, "OK " if match else "BAD", *got))
    if not ok:
        raise SystemExit("positions wrong — inspect before continuing")

    def overlaps(a, b, tol=0.01):
        return all(a["low" + d] < b["high" + d] - tol and
                   a["high" + d] > b["low" + d] + tol for d in "XYZ")

    for n in DY:
        hits = [o for o, ob in boxes2.items()
                if o != n and not o.startswith(("Corridor", "ASM"))
                and o not in DY and overlaps(boxes2[n], ob)]
        if hits:
            print("OVERLAP:", n, "<->", hits)
            ok = False
    print("overlap scan:", "CLEAN" if ok else "SEE ABOVE")

    # 6. renders: rear + refreshed front
    for name, vm in [("rear_panel_estop", "-1,0,0,0,0,0,1,0,0,1,0,0"),
                     ("front_panel3", "1,0,0,0,0,0,1,0,0,-1,0,0")]:
        r = fb.c._request(
            "GET", "/api/v6/partstudios/d/{}/w/{}/e/{}/shadedviews".format(
                DID, WID, EID),
            params={"viewMatrix": vm, "outputHeight": 900,
                    "outputWidth": 1200, "pixelSize": 0})
        with open(SCRATCH + "/{}.png".format(name), "wb") as f:
            f.write(base64.b64decode(r["images"][0]))
        print("render saved:", name)

    ver = fb.c._request("POST", "/api/v6/documents/d/{}/versions".format(DID),
                        json={"name": "PROD-PASS-3", "documentId": DID,
                              "workspaceId": WID,
                              "description": "E-stop relocated to rear panel"})
    print("version:", ver.get("name"), ver.get("id"))
    print("ESTOP TO REAR COMPLETE")


if __name__ == "__main__":
    main()
