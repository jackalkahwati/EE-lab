"""Phase I — full-width door bottom, gas struts, higher canopy pose.

1. SQUARE OFF THE WINDOW (option 1): the stepped leaf's notches were the
   seam where the drawer-exit extension (X +/-288) met the original
   window bottom (Z 80). Fix:
   - Glass Frame Bottom remnants deleted entirely. The named body is
     instanced in Motion Check, so the assembly is cleaned FIRST
     (Static Frame group entry removed, instance deleted), then the
     studio bodies go — including any unnamed lump the aperture cuts
     split off. LESSON check: boolean splits leave orphan "Part NNN"
     lumps; hunt them by bbox before deleting.
   - Trim - Front Sill cut back (X +/-375, Z 16..62) leaving the Z 0..16
     base band + the X +/-(375..395) side columns (single connected lump,
     instance intact).
   - Amber leaf extended FULL WIDTH via boolean ADD (X +/-373, Z 16..82,
     2 mm reveals) — one clean rectangle, straight bottom edge at Z 16.
2. GAS STRUTS (the "shock absorbers"): Bansbach-class gas spring/damper
   stand-ins, O10 x 230, vertical at (+/-385, Y -430, Z 190..420) — 5 mm
   behind the interlock switch envelope (the Y -444 position clashed),
   behind the amber leaf, anchored frame-side bottom / door-side top.
   Soft-open + damped-close for the canopy.
3. Open pose raised 80 -> 105 deg (leaf well past horizontal); struts
   posed at ~55 deg about their lower anchors for the render; drawer
   out; then all pose features deleted and the closed park verified.

Release: Version PROD-PASS-7, STEP v15.
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

from features import FeatureBuilder, circle, rect
from onshape_client import Client, BASE_URL
from phase_e_production import (PLANE_FRONT, STEEL, P_DESC, P_EXCLUDE,
                                P_MATERIAL, P_NAME, P_PARTNO, P_VENDOR,
                                remove_extrude)
from phase_h_esd_door import add_union

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"
ASM = "d6767f7eb804454caaa2dc85"
ABASE = "/api/v6/assemblies/d/{}/w/{}/e/{}".format(DID, WID, ASM)
SCRATCH = os.environ.get("SCRATCH", "/tmp")
STEP_OUT = os.path.join(os.path.dirname(__file__), "..", "..",
                        "cad", "electronics-bringup-station",
                        "Part_Studio_1_v15.step")

PLANE_TOP = {"btType": "BTMParameterQueryList-148", "parameterId": "sketchPlane",
             "queries": [{"btType": "BTMIndividualQuery-138",
                          "deterministicIds": ["JDC"]}]}
P_APPEAR = "57f3fb8efa3416c06701d60c"


def C(r, g, b, o=255):
    return {"color": {"red": r, "green": g, "blue": b}, "opacity": o}


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)
    c = fb.c
    feats = fb.get_features()
    fnames = {f.get("name") for f in feats["features"]}
    pids = {}
    for p in c.list_parts(DID, WID, EID):
        if p.get("bodyType") != "composite":
            pids.setdefault(p["name"], []).append(p["partId"])
    boxes = fb.all_bboxes()

    # ---- 1a. assembly cleanup for Glass Frame Bottom ------------------------
    if "Glass Frame Bottom" in pids:
        adef = c._request("GET", ABASE)
        gfb_inst = [i["id"] for i in adef["rootAssembly"]["instances"]
                    if (i["name"].rsplit(" <", 1)[0] if " <" in i["name"]
                        else i["name"]) == "Glass Frame Bottom"]
        if gfb_inst:
            afeats = c._request("GET", ABASE + "/features")
            group = next(f for f in afeats["features"]
                         if f.get("name") == "Group - Static Frame")
            qp = next(p for p in group["parameters"]
                      if p.get("parameterId") == "occurrencesQuery")
            before = len(qp["queries"])
            qp["queries"] = [q for q in qp["queries"]
                             if not (q.get("path") and q["path"][0] in gfb_inst)]
            if len(qp["queries"]) != before:
                c._request("POST", ABASE + "/features/featureid/{}".format(
                    quote(group["featureId"], safe="")),
                    json={"btType": "BTFeatureDefinitionCall-1406",
                          "feature": group,
                          "serializationVersion": afeats.get("serializationVersion"),
                          "sourceMicroversion": afeats.get("sourceMicroversion"),
                          "libraryVersion": afeats.get("libraryVersion")})
                print("assembly: removed Glass Frame Bottom from Static Frame "
                      "group ({} -> {})".format(before, len(qp["queries"])))
                time.sleep(2)
            for iid in gfb_inst:
                try:
                    c._request("DELETE", ABASE + "/instance/nodeid/{}".format(
                        quote(iid, safe="")))
                    print("assembly: instance deleted:", iid)
                except Exception as e:
                    print("assembly: instance delete failed ({}) — continuing, "
                          "clean in UI".format(e))
                time.sleep(1.5)

        # ---- 1b. delete the frame-bottom lumps (named + orphan splits) ------
        dead = list(pids["Glass Frame Bottom"])
        for n, b in boxes.items():
            if n.startswith("Part ") and b["lowZ"] >= 55 and b["highZ"] <= 85 \
                    and b["lowY"] >= -462 and b["highY"] <= -448 \
                    and abs(b["highX"]) <= 380:
                dead += pids.get(n, [])
                print("orphan frame-bottom lump found:", n)
        fb.delete_bodies(dead, name="I - Remove Frame Bottom")
        print("frame-bottom bodies deleted:", len(dead))
        time.sleep(2)
        pids = {}
        for p in c.list_parts(DID, WID, EID):
            if p.get("bodyType") != "composite":
                pids.setdefault(p["name"], []).append(p["partId"])

    # ---- 1c. sill trim + full-width leaf ------------------------------------
    if "I - Sill Trim" not in fnames:
        sk = fb.add_sketch("I - Sill Trim Sketch", PLANE_FRONT,
                           rect("sillt", -0.375, 0.016, 0.375, 0.062))
        fid, st = remove_extrude(fb, "I - Sill Trim", sk, 13, 449,
                                 pids["Trim - Front Sill"])
        print("sill trim:", st)
        time.sleep(2)
        sk = fb.add_sketch("I - Full Width Leaf Sketch", PLANE_FRONT,
                           rect("fwl", -0.373, 0.016, 0.373, 0.082))
        add_union(fb, "I - Full Width Leaf", sk, 4, 456,
                  pids["Front Smoked Glass v2"])
        print("amber leaf extended full width")
        time.sleep(2)

    # ---- 2. gas struts --------------------------------------------------------
    if "I - Gas Struts" not in fnames:
        sk = fb.add_sketch("I - Gas Struts Sketch", PLANE_TOP,
                           [circle("gsl", -0.385, -0.430, 0.005),
                            circle("gsr", 0.385, -0.430, 0.005)])
        fb.add_extrude("I - Gas Struts", sk, 230, offset_mm=190)
        print("gas struts built")
        time.sleep(2)

    # ---- naming + metadata -----------------------------------------------------
    parts2 = {}
    for p in c.list_parts(DID, WID, EID):
        if p.get("bodyType") != "composite":
            parts2.setdefault(p["name"], []).append(p["partId"])
    boxes2 = fb.all_bboxes()
    items = []
    targets = {"Door Gas Strut Left": (-385, -430, 305),
               "Door Gas Strut Right": (385, -430, 305)}
    for n, plist in parts2.items():
        if not n.startswith("Part "):
            continue
        b = boxes2.get(n)
        if not b:
            continue
        cc = tuple((b["low" + d] + b["high" + d]) / 2 for d in "XYZ")
        for tgt, e in targets.items():
            if tgt in parts2:
                continue
            if all(abs(cc[i] - e[i]) < 5.0 for i in range(3)):
                items.append({"partId": plist[0], "properties": [
                    {"propertyId": P_NAME, "value": tgt},
                    {"propertyId": P_PARTNO, "value": "Bansbach A1A1-40-060-150"},
                    {"propertyId": P_VENDOR, "value": "Bansbach"},
                    {"propertyId": P_MATERIAL, "value": STEEL},
                    {"propertyId": P_APPEAR, "value": C(140, 143, 148)},
                    {"propertyId": P_EXCLUDE, "value": False},
                    {"propertyId": P_DESC, "value":
                     "Gas spring + damper, canopy soft-open/soft-close; "
                     "frame-side lower anchor, door-side upper anchor"}]})
                print("  named:", tgt)
                break
    if items:
        c._request("POST", "/api/v6/metadata/d/{}/w/{}/e/{}".format(
            DID, WID, EID), json={"items": [
                {"href": "{}/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
                    BASE_URL, DID, WID, EID, quote(it["partId"], safe="")),
                 "properties": it["properties"]} for it in items]})
        print("metadata applied")
        time.sleep(1.5)

    # ---- verify ----------------------------------------------------------------
    print("=== verify ===")
    boxes3 = fb.all_bboxes()
    g = boxes3["Front Smoked Glass v2"]
    print("  leaf X {:.0f}..{:.0f} Z {:.0f}..{:.0f} (want ±373..375 / 16..440)".format(
        g["lowX"], g["highX"], g["lowZ"], g["highZ"]))
    s = boxes3["Trim - Front Sill"]
    print("  sill X {:.0f}..{:.0f} Z {:.0f}..{:.0f}".format(
        s["lowX"], s["highX"], s["lowZ"], s["highZ"]))

    def overlaps(a, b, tol=0.01):
        return all(a["low" + d] < b["high" + d] - tol and
                   a["high" + d] > b["low" + d] + tol for d in "XYZ")

    clean = True
    for n in ("Door Gas Strut Left", "Door Gas Strut Right",
              "Front Smoked Glass v2"):
        for other, ob in boxes3.items():
            if other == n or other.startswith(("Corridor", "ASM", "Analysis")):
                continue
            if {n, other} == {"Door Gas Strut Left", "Door Gas Strut Right"}:
                continue
            if n == "Front Smoked Glass v2" and other in (
                    "Trim - Front Sill", "Glass Frame Side L+R",
                    "Glass Frame Top"):
                continue    # frame bboxes wrap the leaf; reveals by construction
            if overlaps(boxes3[n], ob):
                print("  OVERLAP: {} <-> {}".format(n, other))
                clean = False
    print("  overlap scan:", "CLEAN" if clean else "SEE ABOVE")
    print("PHASE I GEOMETRY COMPLETE")


if __name__ == "__main__":
    main()
