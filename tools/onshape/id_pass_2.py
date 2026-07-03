"""ID Pass 2 — Fuse-style panel breaks and shadow gaps (2026-07-03).

Geometry surgery, all scoped REMOVE cuts (no deletions — partIds and the
Motion Check assembly untouched):

1. WINDOW SHADOW GAP — 6 mm wide, 2 mm deep recess ring in the glass
   frames' front faces around the amber window. Ring = area between
   rounded_rect(±381, 74..446, r66) and rounded_rect(±374, 81..439,
   r59); the inner outline is inset 1 mm INTO the window opening so no
   cut wall lands exactly on the frame inner faces (coincident-face
   ERROR mode). Scoped to the four frame bodies; the glass is not in
   scope so the 1 mm overlap can't touch it.
2. DISPLAY SHADOW GAP — same treatment around the 15.6in bezel: ring
   between rounded_rect(22,-231 .. 404,-1, r12) and the bezel outline,
   2 mm into the fascia. The region behind the bezel recesses too
   (invisible from outside; bezel is not in scope).
3. BODY SEAM — 3 mm wide, 1.5 mm deep groove at Z=0 (the plinth line,
   where fascia meets sill on the front) wrapping the machine: both
   shell side faces, both shell front columns, and the full rear
   (shells + rear trim fillers + rear panel). Front center already
   breaks naturally at the fascia/sill joint.

Idempotent via feature names. Release: Version ID-PASS-2, STEP v10.
"""

from __future__ import annotations

import base64
import math
import os
import time
import warnings

warnings.filterwarnings("ignore")

import requests

from features import FeatureBuilder, rect, rounded_rect
from onshape_client import Client, BASE_URL
from phase_e_production import PLANE_FRONT

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"
SCRATCH = os.environ.get("SCRATCH", "/tmp")
STEP_OUT = os.path.join(os.path.dirname(__file__), "..", "..",
                        "cad", "electronics-bringup-station",
                        "Part_Studio_1_v10.step")

PLANE_RIGHT = {"btType": "BTMParameterQueryList-148", "parameterId": "sketchPlane",
               "queries": [{"btType": "BTMIndividualQuery-138",
                            "deterministicIds": ["JEC"]}]}
M = 0.001


def view_matrix(yaw_deg, pitch_deg):
    y, p = math.radians(yaw_deg), math.radians(pitch_deg)
    f = (math.sin(y) * math.cos(p), math.cos(y) * math.cos(p), math.sin(p))
    n = math.hypot(f[1], -f[0]) or 1.0
    r = (f[1] / n, -f[0] / n, 0.0)
    u = (r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2],
         r[0] * f[1] - r[1] * f[0])
    return ",".join("{:.6f}".format(v)
                    for row in [r, u, tuple(-c for c in f)]
                    for v in list(row) + [0.0])


def cut(fb, name, sketch_fid, depth, offset, scope, opposite=False,
        offset_opposite=False):
    fb.add_extrude_remove(name, sketch_fid, depth_mm=depth, offset_mm=offset,
                          scope_part_ids=scope, opposite=opposite,
                          offset_opposite=offset_opposite)
    print("  cut:", name)
    time.sleep(2)


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)
    feats = fb.get_features()
    fnames = {f.get("name") for f in feats["features"]}
    pids = {}
    for p in fb.c.list_parts(DID, WID, EID):
        if p.get("bodyType") != "composite":
            pids.setdefault(p["name"], []).append(p["partId"])

    frames = (pids["Glass Frame Top"] + pids["Glass Frame Bottom"] +
              pids["Glass Frame Side L+R"])
    shells = pids["Side Shell Left"] + pids["Side Shell Right"]

    # ---- 1. window shadow gap ---------------------------------------------
    print("=== 1. window shadow gap ===")
    if "ID2 - Window Shadow Gap" not in fnames:
        ents = (rounded_rect("wsgo", -381 * M, 74 * M, 381 * M, 446 * M, 66 * M) +
                rounded_rect("wsgi", -374 * M, 81 * M, 374 * M, 439 * M, 59 * M))
        sk = fb.add_sketch("ID2 - Window Shadow Gap Sketch", PLANE_FRONT, ents)
        cut(fb, "ID2 - Window Shadow Gap", sk, 4, 458, frames)
    else:
        print("  already present")

    # ---- 2. display shadow gap --------------------------------------------
    print("=== 2. display shadow gap ===")
    if "ID2 - Display Shadow Gap" not in fnames:
        ents = (rounded_rect("dsgo", 22 * M, -231 * M, 404 * M, -1 * M, 12 * M) +
                rounded_rect("dsgi", 28 * M, -225 * M, 398 * M, -5 * M, 8 * M))
        sk = fb.add_sketch("ID2 - Display Shadow Gap Sketch", PLANE_FRONT, ents)
        cut(fb, "ID2 - Display Shadow Gap", sk, 4, 458, pids["Plinth Fascia"])
    else:
        print("  already present")

    # ---- 3. body seam at Z = 0 --------------------------------------------
    print("=== 3. plinth-line body seam ===")
    if "ID2 - Seam Side Right" not in fnames:
        sk = fb.add_sketch("ID2 - Seam Sides Sketch", PLANE_RIGHT,
                           rect("seams", -461 * M, -1.5 * M, 461 * M, 1.5 * M))
        cut(fb, "ID2 - Seam Side Right", sk, 3, 503.5, pids["Side Shell Right"])
        cut(fb, "ID2 - Seam Side Left", sk, 3, -506.5, pids["Side Shell Left"],
            offset_opposite=True)
        sk = fb.add_sketch("ID2 - Seam Front Sketch", PLANE_FRONT,
                           rect("seamfl", -505 * M, -1.5 * M, -435 * M, 1.5 * M) +
                           rect("seamfr", 435 * M, -1.5 * M, 505 * M, 1.5 * M))
        cut(fb, "ID2 - Seam Front", sk, 4, 458, shells)
        sk = fb.add_sketch("ID2 - Seam Rear Sketch", PLANE_FRONT,
                           rect("seamr", -505 * M, -1.5 * M, 505 * M, 1.5 * M))
        cut(fb, "ID2 - Seam Rear", sk, 4, 458,
            shells + pids["Trim - Rear Filler Left"] +
            pids["Trim - Rear Filler Right"] + pids["Rear Matte Black Panel"],
            opposite=True, offset_opposite=True)
    else:
        print("  already present")

    # ---- renders + release ---------------------------------------------------
    S = SCRATCH
    for name, vm in [("id2_front", "1,0,0,0,0,0,1,0,0,-1,0,0"),
                     ("id2_hero", view_matrix(-35, -14)),
                     ("id2_side", view_matrix(-80, -8))]:
        r = fb.c._request(
            "GET", "/api/v6/partstudios/d/{}/w/{}/e/{}/shadedviews".format(
                DID, WID, EID),
            params={"viewMatrix": vm, "outputHeight": 900, "outputWidth": 1200,
                    "pixelSize": 0, "showAllParts": "true"})
        with open(S + "/{}.png".format(name), "wb") as f:
            f.write(base64.b64decode(r["images"][0]))
        print("render:", name)

    ver = fb.c._request("POST", "/api/v6/documents/d/{}/versions".format(DID),
                        json={"name": "ID-PASS-2", "documentId": DID,
                              "workspaceId": WID,
                              "description": "Fuse panel breaks: window + "
                              "display shadow gaps, plinth-line body seam"})
    print("version:", ver.get("name"), ver.get("id"))

    tr = fb.c._request(
        "POST", "/api/v6/partstudios/d/{}/w/{}/e/{}/translations".format(
            DID, WID, EID),
        json={"formatName": "STEP", "storeInDocument": False,
              "flattenAssemblies": False, "yAxisIsUp": False})
    tid = tr.get("id")
    for _ in range(30):
        time.sleep(5)
        st = fb.c._request("GET", "/api/v6/translations/{}".format(tid))
        if st.get("requestState") == "DONE":
            xid = (st.get("resultExternalDataIds") or [None])[0]
            resp = requests.get(
                "{}/api/v6/documents/d/{}/externaldata/{}".format(
                    BASE_URL, DID, xid), auth=fb.c._auth, timeout=120)
            resp.raise_for_status()
            with open(os.path.abspath(STEP_OUT), "wb") as f:
                f.write(resp.content)
            print("STEP exported:", os.path.abspath(STEP_OUT),
                  "({:.1f} MB)".format(len(resp.content) / 1e6))
            break
        if st.get("requestState") == "FAILED":
            print("!! STEP translation FAILED:", st.get("failureReason"))
            break
    print("ID PASS 2 COMPLETE")


if __name__ == "__main__":
    main()
