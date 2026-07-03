"""Laser-etched firstlight logo, fascia bottom-left (2026-07-03).

Traces /Users/jackal-kahwati/Documents/firstlight-logo.png (starburst
mark with orange top dash + lowercase wordmark) into vector contours
(cv2 findContours + approxPolyDP), deletes the old block-glyph wordmark,
and reproduces the logo as a REAL laser etch:

- 0.3 mm REMOVE cut into the Plinth Fascia front face (the etch),
  using filterInnerLoops so letter counters stay open (R-glyph lesson)
- flush fill bodies in the etched void: silver (= aluminum exposed
  through the black powder coat) except the starburst's top dash,
  which is paint-filled ORANGE (matches the accent language)

Logo width 170 mm at X -405..-235, bottom edge Z -235 (clear of the
accent strip at Z -270..-264 and the wrist jack at Z -75..-45).
"""

from __future__ import annotations

import time
import warnings

warnings.filterwarnings("ignore")

from urllib.parse import quote

import cv2
import numpy as np

from features import FeatureBuilder, line
from onshape_client import Client, BASE_URL
from phase_e_production import PLANE_FRONT

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"
LOGO = "/Users/jackal-kahwati/Documents/firstlight-logo.png"

P_NAME = "57f3fb8efa3416c06701d60d"
P_DESC = "57f3fb8efa3416c06701d60e"
P_PARTNO = "57f3fb8efa3416c06701d60f"
P_APPEAR = "57f3fb8efa3416c06701d60c"
P_EXCLUDE = "57f3fb8efa3416c06701d61e"

X0, ZBOT, WIDTH_MM = -405.0, -235.0, 170.0
M = 0.001


def trace():
    img = cv2.imread(LOGO)
    mask = (img.min(axis=2) < 180).astype(np.uint8) * 255
    ys, xs = np.where(mask > 0)
    x_min, x_max, y_min, y_max = xs.min(), xs.max(), ys.min(), ys.max()
    crop = mask[y_min:y_max + 1, x_min:x_max + 1]
    scale = WIDTH_MM / crop.shape[1]
    cnts, hier = cv2.findContours(crop, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    loops, orange_idx = [], []
    for i, c in enumerate(cnts):
        eps = 1.3
        ap = cv2.approxPolyDP(c, eps, True).reshape(-1, 2)
        while len(ap) > 120:
            eps += 0.4
            ap = cv2.approxPolyDP(c, eps, True).reshape(-1, 2)
        if len(ap) < 3 or cv2.contourArea(c) < 12:
            continue
        # world coords: X right, Z up (image y down)
        pts = [(X0 + p[0] * scale, ZBOT + (crop.shape[0] - p[1]) * scale)
               for p in ap]
        # orange detection on top-level contours only
        if hier[0][i][3] == -1:
            cm = np.zeros(crop.shape, np.uint8)
            cv2.drawContours(cm, [c], -1, 255, -1)
            sel = img[y_min:y_max + 1, x_min:x_max + 1][cm > 0]
            b, g, r = sel[:, 0].mean(), sel[:, 1].mean(), sel[:, 2].mean()
            if r > 150 and r - b > 60:
                cx = X0 + c[:, 0, 0].mean() * scale
                cz = ZBOT + (crop.shape[0] - c[:, 0, 1].mean()) * scale
                orange_idx.append((cx, cz))
        loops.append(pts)
    n = sum(len(l) for l in loops)
    print("contours: {}, total points: {}, orange marks: {}".format(
        len(loops), n, len(orange_idx)))
    return loops, orange_idx


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)
    feats = fb.get_features()
    fnames = {f.get("name") for f in feats["features"]}
    pids = {}
    for p in fb.c.list_parts(DID, WID, EID):
        if p.get("bodyType") != "composite":
            pids.setdefault(p["name"], []).append(p["partId"])

    loops, orange = trace()

    # 1. retire the old block wordmark
    old = [pid for i in range(1, 15)
           for pid in pids.get("Wordmark Glyph {:02d}".format(i), [])]
    if old:
        fb.delete_bodies(old, name="LOGO - Remove Block Wordmark")
        print("old wordmark removed:", len(old))
        time.sleep(2)
        pids = {}
        for p in fb.c.list_parts(DID, WID, EID):
            if p.get("bodyType") != "composite":
                pids.setdefault(p["name"], []).append(p["partId"])

    # 2. logo sketch
    if "LOGO - firstlight Etch" not in fnames:
        ents, k = [], 0
        for loop in loops:
            for j in range(len(loop)):
                a, b = loop[j], loop[(j + 1) % len(loop)]
                ents.append(line("lg{}".format(k), a[0] * M, a[1] * M,
                                 b[0] * M, b[1] * M))
                k += 1
        sk = fb.add_sketch("LOGO - firstlight Sketch", PLANE_FRONT, ents)
        print("logo sketch:", k, "segments")
        time.sleep(2)

        # 3. the etch: 0.3 mm cut, counters preserved
        fb._post({"btType": "BTMFeature-134", "featureType": "extrude",
                  "name": "LOGO - firstlight Etch", "parameters": [
            {"btType": "BTMParameterEnum-145", "parameterId": "bodyType",
             "value": "SOLID", "enumName": "ExtendedToolBodyType"},
            {"btType": "BTMParameterEnum-145", "parameterId": "operationType",
             "value": "REMOVE", "enumName": "NewBodyOperationType"},
            {"btType": "BTMParameterQueryList-148", "parameterId": "entities",
             "queries": [{"btType": "BTMIndividualSketchRegionQuery-140",
                          "featureId": sk, "filterInnerLoops": True}]},
            {"btType": "BTMParameterEnum-145", "parameterId": "endBound",
             "value": "BLIND", "enumName": "BoundingType"},
            {"btType": "BTMParameterQuantity-147", "parameterId": "depth",
             "expression": "0.8 mm"},
            {"btType": "BTMParameterBoolean-144",
             "parameterId": "oppositeDirection", "value": False},
            {"btType": "BTMParameterBoolean-144", "parameterId": "defaultScope",
             "value": False},
            {"btType": "BTMParameterQueryList-148", "parameterId": "booleanScope",
             "queries": [{"btType": "BTMIndividualQuery-138",
                          "deterministicIds": pids["Plinth Fascia"]}]},
            {"btType": "BTMParameterBoolean-144", "parameterId": "startOffset",
             "value": True},
            {"btType": "BTMParameterEnum-145", "parameterId": "startOffsetBound",
             "value": "BLIND", "enumName": "StartOffsetType"},
            {"btType": "BTMParameterQuantity-147",
             "parameterId": "startOffsetDistance", "expression": "459.7 mm"},
            {"btType": "BTMParameterBoolean-144",
             "parameterId": "startOffsetOppositeDirection", "value": False}]})
        print("etch cut OK")
        time.sleep(2)

        # 4. flush fills in the void (renderable etch exposure)
        fb._post({"btType": "BTMFeature-134", "featureType": "extrude",
                  "name": "LOGO - firstlight Fills", "parameters": [
            {"btType": "BTMParameterEnum-145", "parameterId": "bodyType",
             "value": "SOLID", "enumName": "ExtendedToolBodyType"},
            {"btType": "BTMParameterEnum-145", "parameterId": "operationType",
             "value": "NEW", "enumName": "NewBodyOperationType"},
            {"btType": "BTMParameterQueryList-148", "parameterId": "entities",
             "queries": [{"btType": "BTMIndividualSketchRegionQuery-140",
                          "featureId": sk, "filterInnerLoops": True}]},
            {"btType": "BTMParameterEnum-145", "parameterId": "endBound",
             "value": "BLIND", "enumName": "BoundingType"},
            {"btType": "BTMParameterQuantity-147", "parameterId": "depth",
             "expression": "0.3 mm"},
            {"btType": "BTMParameterBoolean-144",
             "parameterId": "oppositeDirection", "value": False},
            {"btType": "BTMParameterBoolean-144", "parameterId": "startOffset",
             "value": True},
            {"btType": "BTMParameterEnum-145", "parameterId": "startOffsetBound",
             "value": "BLIND", "enumName": "StartOffsetType"},
            {"btType": "BTMParameterQuantity-147",
             "parameterId": "startOffsetDistance", "expression": "459.7 mm"},
            {"btType": "BTMParameterBoolean-144",
             "parameterId": "startOffsetOppositeDirection", "value": False}]})
        print("fills OK")
        time.sleep(2)

    # 5. name + color the fills
    parts2 = {}
    for p in fb.c.list_parts(DID, WID, EID):
        if p.get("bodyType") != "composite":
            parts2.setdefault(p["name"], []).append(p["partId"])
    boxes = fb.all_bboxes()
    items, idx = [], 0
    silver = {"color": {"red": 200, "green": 202, "blue": 206}, "opacity": 255}
    orange_c = {"color": {"red": 245, "green": 150, "blue": 40}, "opacity": 255}
    for n, plist in sorted(parts2.items()):
        if not n.startswith("Part "):
            continue
        b = boxes.get(n)
        if not b:
            continue
        if not (-412 < b["lowX"] and b["highX"] < -228 and
                b["lowY"] > -461 and b["highY"] < -459 and
                -240 < b["lowZ"] and b["highZ"] < -185):
            continue
        cx = (b["lowX"] + b["highX"]) / 2
        cz = (b["lowZ"] + b["highZ"]) / 2
        is_orange = any(abs(cx - ox) < 6 and abs(cz - oz) < 6
                        for ox, oz in orange)
        idx += 1
        items.append({"partId": plist[0], "properties": [
            {"propertyId": P_NAME, "value": "Logo Etch Fill {:02d}".format(idx)},
            {"propertyId": P_PARTNO, "value": "LASER ETCH (paint-filled)"},
            {"propertyId": P_APPEAR, "value": orange_c if is_orange else silver},
            {"propertyId": P_EXCLUDE, "value": True},
            {"propertyId": P_DESC, "value":
             "firstlight logo, laser-etched 0.3 mm through black powder "
             "coat; silver = exposed aluminum, top dash paint-filled orange"}]})
    print("fill bodies found:", idx)
    for i in range(0, len(items), 40):
        batch = items[i:i + 40]
        fb.c._request("POST", "/api/v6/metadata/d/{}/w/{}/e/{}".format(
            DID, WID, EID), json={"items": [
                {"href": "{}/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
                    BASE_URL, DID, WID, EID, quote(it["partId"], safe="")),
                 "properties": it["properties"]} for it in batch]})
        time.sleep(1.5)
    print("metadata applied")
    print("LOGO ETCH COMPLETE")


if __name__ == "__main__":
    main()
