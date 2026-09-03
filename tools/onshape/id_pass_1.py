"""ID Pass 1 — Formlabs / Fuse 1+ industrial design language (2026-07-03).

Reference cues:
- Fuse 1+: monolithic two-tone — graphite front + top wrapping over
  silver body sides, dark plinth, window floating in the dark face with
  large corner radii.
- Form series: signature translucent AMBER window, orange accent light.

Changes (geometry preserved where it matters — fillets and appearance
only, no body deletions, partIds and assembly instances untouched):

1. WINDOW CORNER RADII — R60 fillets on the four glass corner edges,
   scoped to the glass's creating feature (frame edges share the corner
   points, so an unscoped qContainsPoint would catch them and error).
2. AMBER WINDOW — Front Smoked Glass v2 -> translucent amber
   (255,130,30 @ opacity 150); description updated to amber acrylic.
3. GRAPHITE TOP — Top Slab -> (52,54,58) so the dark face wraps over
   the top like the Fuse; shells stay warm silver.
4. ORANGE ACCENTS — accent light strip, power LED bar + indicator dot,
   probe-head logo emblem -> Formlabs orange (255,110,0).
5. Glass frames -> near-black (28,28,30) so the window floats.

Release: Version ID-PASS-1, STEP v9.
"""

from __future__ import annotations

import base64
import math
import os
import time
import warnings

warnings.filterwarnings("ignore")

from urllib.parse import quote

import requests

from features import FeatureBuilder
from onshape_client import Client, BASE_URL

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"
SCRATCH = os.environ.get("SCRATCH", "/tmp")
STEP_OUT = os.path.join(os.path.dirname(__file__), "..", "..",
                        "cad", "electronics-bringup-station",
                        "Part_Studio_1_v9.step")

P_APPEAR = "57f3fb8efa3416c06701d60c"
P_DESC = "57f3fb8efa3416c06701d60e"

GLASS_FEATURE = "F23nJcaMBNmxhzZ_152"      # extrude "Front Smoked Glass Panel"
CORNERS = [(-375.0, -458.0, 440.0), (375.0, -458.0, 440.0),
           (-375.0, -458.0, 80.0), (375.0, -458.0, 80.0)]

AMBER = {"color": {"red": 255, "green": 130, "blue": 30}, "opacity": 150}
GRAPHITE = {"color": {"red": 52, "green": 54, "blue": 58}, "opacity": 255}
ORANGE = {"color": {"red": 255, "green": 110, "blue": 0}, "opacity": 255}
FRAME_BLACK = {"color": {"red": 28, "green": 28, "blue": 30}, "opacity": 255}

APPEARANCES = [
    ("Front Smoked Glass v2", AMBER,
     "Window: transparent amber acrylic (UV-amber PMMA), R60 corners"),
    ("Top Slab", GRAPHITE, None),
    ("Glass Frame Top", FRAME_BLACK, None),
    ("Glass Frame Bottom", FRAME_BLACK, None),
    ("Glass Frame Side L+R", FRAME_BLACK, None),
    ("Accent Light Strip Full Width", ORANGE, None),
    ("Power LED Bar", ORANGE, None),
    ("Power Indicator Dot", ORANGE, None),
    ("Probe Head Logo Emblem", ORANGE, None),
]


def view_matrix(yaw_deg, pitch_deg):
    y, p = math.radians(yaw_deg), math.radians(pitch_deg)
    f = (math.sin(y) * math.cos(p), math.cos(y) * math.cos(p), math.sin(p))
    rx, ry, rz = (f[1], -f[0], 0.0)
    n = math.hypot(rx, ry) or 1.0
    r = (rx / n, ry / n, 0.0)
    u = (r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2],
         r[0] * f[1] - r[1] * f[0])
    rows = [r, u, tuple(-c for c in f)]
    return ",".join("{:.6f}".format(v) for row in rows for v in list(row) + [0.0])


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)
    feats = fb.get_features()
    fnames = {f.get("name") for f in feats["features"]}

    # ---- 1. window corner fillets -----------------------------------------
    if "ID - Window Corner Radii R60" not in fnames:
        qs = ", ".join(
            "qContainsPoint(qCreatedBy(makeId(\"{}\"), EntityType.EDGE), "
            "vector({:.1f}, {:.1f}, {:.1f}) * millimeter)".format(
                GLASS_FEATURE, *pt) for pt in CORNERS)
        fb._post({
            "btType": "BTMFeature-134", "featureType": "fillet",
            "name": "ID - Window Corner Radii R60",
            "parameters": [
                {"btType": "BTMParameterQueryList-148", "parameterId": "entities",
                 "queries": [{"btType": "BTMIndividualQuery-138",
                              "queryString": "query = qUnion([{}]);".format(qs)}]},
                {"btType": "BTMParameterQuantity-147", "parameterId": "radius",
                 "expression": "60 mm"},
            ],
        })
        print("window corner fillets R60: OK")
        time.sleep(2)
    else:
        print("window fillets already present")

    # ---- 2-5. appearance pass ---------------------------------------------
    name_pids = {}
    for p in fb.c.list_parts(DID, WID, EID):
        if p.get("bodyType") != "composite":
            name_pids.setdefault(p["name"], []).append(p["partId"])
    items = []
    for name, app, desc in APPEARANCES:
        for pid in name_pids.get(name, []):
            props = [{"propertyId": P_APPEAR, "value": app}]
            if desc:
                props.append({"propertyId": P_DESC, "value": desc})
            items.append({"href": "{}/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
                BASE_URL, DID, WID, EID, quote(pid, safe="")),
                "properties": props})
    fb.c._request("POST", "/api/v6/metadata/d/{}/w/{}/e/{}".format(DID, WID, EID),
                  json={"items": items})
    print("appearance applied to {} bodies".format(len(items)))
    time.sleep(2)

    # ---- renders ------------------------------------------------------------
    views = [("id_front", "1,0,0,0,0,0,1,0,0,-1,0,0"),
             ("id_hero", view_matrix(-35, -14)),
             ("id_iso", "0.707107,0.707107,0,0,-0.408248,0.408248,0.816497,0,"
              "0.57735,-0.57735,0.57735,0")]
    for name, vm in views:
        r = fb.c._request(
            "GET", "/api/v6/partstudios/d/{}/w/{}/e/{}/shadedviews".format(
                DID, WID, EID),
            params={"viewMatrix": vm, "outputHeight": 900, "outputWidth": 1200,
                    "pixelSize": 0})
        with open(SCRATCH + "/{}.png".format(name), "wb") as f:
            f.write(base64.b64decode(r["images"][0]))
        print("render:", name)

    # ---- release -------------------------------------------------------------
    ver = fb.c._request("POST", "/api/v6/documents/d/{}/versions".format(DID),
                        json={"name": "ID-PASS-1", "documentId": DID,
                              "workspaceId": WID,
                              "description": "Formlabs/Fuse ID language: amber "
                              "window R60, graphite top, orange accents"})
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
    print("ID PASS 1 COMPLETE")


if __name__ == "__main__":
    main()
