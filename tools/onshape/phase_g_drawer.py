"""Phase G — slide-out fixture drawer + universal M5 fixture grid.

Answers the serviceability review: loading a PCB currently means a
~456 mm reach over a 22 mm lip through the front door. This pass adds:

1. FIXTURE DRAWER (modeled CLOSED; travel documented by an analysis body)
   - fixture standoffs (EE-FAB-STDF) trimmed from Z 0..40 to Z 28..40
     via a scoped cut (partIds preserved; RFQ envelope updated)
   - drawer tray plate 570x430x8 (Z 20..28) under the standoffs
   - 2x full-extension slide envelopes (Accuride DZ9301-class,
     X +/-(285..300), Z 20..32)
   - 2x support rails (X +/-(300..316), Z 14..34) spanning between the
     base frame front/rear members (abut at Y +/-278 vs faces at 280)
   - front aperture X +/-290, Z 14..78 cut through Trim - Front Sill and
     Glass Frame Bottom; black drawer front panel X +/-288, Z 14..78
     (Y -462..-452) with 2 mm reveal + handle bar X +/-120, Z 38..54
   - drawer latch block (kinematic re-registration stand-in) rear center
   - "Analysis - Drawer Travel" translucent body: 480 mm pull-out
2. UNIVERSAL FIXTURE GRID — O4.2 (M5 tap) holes, 25 mm pitch, X +/-225,
   Y +/-175, keep-outs auto-skipped around vacuum ports/bosses and the
   calibration assets. One REMOVE feature scoped to the fixture plate.

Registration note (metadata desc): drawer closes against hard stops onto
two kinematic pins + the latch; fixture locating pins keep board datum,
so camera re-registration handles residual (<0.1 mm class) repeatability.
Interlock: drawer-open breaks the same G9SE guard circuit as the door.

Release: Version PROD-PASS-4, STEP v12.
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

from features import FeatureBuilder, circle, rect, rounded_rect
from onshape_client import Client, BASE_URL
from phase_e_production import (AL6061, PLANE_FRONT, STEEL, P_DESC,
                                P_EXCLUDE, P_MATERIAL, P_NAME, P_PARTNO,
                                P_VENDOR, mat, remove_extrude)

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"
SCRATCH = os.environ.get("SCRATCH", "/tmp")
STEP_OUT = os.path.join(os.path.dirname(__file__), "..", "..",
                        "cad", "electronics-bringup-station",
                        "Part_Studio_1_v12.step")

PLANE_TOP = {"btType": "BTMParameterQueryList-148", "parameterId": "sketchPlane",
             "queries": [{"btType": "BTMIndividualQuery-138",
                          "deterministicIds": ["JDC"]}]}
P_APPEAR = "57f3fb8efa3416c06701d60c"
M = 0.001
AL5052 = mat("Aluminum 5052 sheet", 2700)
NONE_ = mat("Analysis body (no fab)", 1)


def C(r, g, b, o=255):
    return {"color": {"red": r, "green": g, "blue": b}, "opacity": o}


#: expected new bodies: name -> (bbox center, props)
NEW = {
    "Drawer Tray Plate": ((0, 0, 24), [
        ("pn", "EE-FAB-DRWTRAY"), ("vn", "FAB - machine"), ("mt", AL6061),
        ("ap", C(186, 189, 193)),
        ("dc", "Fixture drawer tray 570x430x8; fixture standoffs bolt on top")]),
    "Drawer Slide Left": ((-292.5, 0, 26), [
        ("pn", "DZ9301-0450"), ("vn", "Accuride"), ("mt", STEEL),
        ("ap", C(140, 143, 148)),
        ("dc", "Full-extension slide, 450 mm travel class")]),
    "Drawer Slide Right": ((292.5, 0, 26), [
        ("pn", "DZ9301-0450"), ("vn", "Accuride"), ("mt", STEEL),
        ("ap", C(140, 143, 148)),
        ("dc", "Full-extension slide, 450 mm travel class")]),
    "Drawer Support Rail Left": ((-308, 0, 24), [
        ("pn", "EE-FAB-DRWRAIL"), ("vn", "FAB - machine"), ("mt", AL6061),
        ("ap", C(120, 122, 126)),
        ("dc", "Slide support rail, spans frame front/rear members")]),
    "Drawer Support Rail Right": ((308, 0, 24), [
        ("pn", "EE-FAB-DRWRAIL"), ("vn", "FAB - machine"), ("mt", AL6061),
        ("ap", C(120, 122, 126)),
        ("dc", "Slide support rail, spans frame front/rear members")]),
    "Drawer Front Panel": ((0, -457, 46), [
        ("pn", "EE-FAB-DRWPNL"), ("vn", "FAB - machine"), ("mt", AL5052),
        ("ap", C(22, 22, 25)),
        ("dc", "Drawer fascia panel, 2 mm reveal, Cosmetic Class A black")]),
    "Drawer Handle": ((0, -469, 46), [
        ("pn", "EE-FAB-DRWHNDL"), ("vn", "FAB - machine"), ("mt", AL6061),
        ("ap", C(22, 22, 25)),
        ("dc", "Drawer pull, black anodize")]),
    "Drawer Latch Block": ((0, 224, 27), [
        ("pn", "E5-10-505-50"), ("vn", "Southco"), ("mt", STEEL),
        ("ap", C(45, 45, 48)),
        ("dc", "Closed-position latch + kinematic stop; drawer-open breaks "
               "the G9SE guard circuit (wired with door interlock)")]),
    "Analysis - Drawer Travel": ((0, -240, 45), [
        ("pn", "ANALYSIS"), ("vn", ""), ("mt", NONE_),
        ("ap", C(255, 140, 0, 40)), ("ex", True),
        ("dc", "Drawer pull-out travel envelope, 480 mm")]),
}

#: M5 grid keep-out centers (x, y) and clearance radius
KEEPOUTS = ([(sx * 120, sy * 80) for sx in (1, -1) for sy in (1, -1)] +
            [(sx * 110, sy * 75) for sx in (1, -1) for sy in (1, -1)] +
            [(-220, 60), (200, 60)])
KEEPOUT_R = 16.0
FID_RECT = (-245, -165, -195, -115)     # fiducial target region grown 5


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)
    feats = fb.get_features()
    fnames = {f.get("name") for f in feats["features"]}
    pids = {}
    for p in fb.c.list_parts(DID, WID, EID):
        if p.get("bodyType") != "composite":
            pids.setdefault(p["name"], []).append(p["partId"])

    # ---- 1a. trim the standoffs (Z 0..40 -> 28..40) -----------------------
    print("=== drawer ===")
    if "DRW - Standoff Trim" not in fnames:
        ents = []
        for i, (sx, sy) in enumerate([(230, -180), (230, 180),
                                      (-230, -180), (-230, 180)]):
            ents += rect("st{}".format(i), (sx - 10) * M, (sy - 10) * M,
                         (sx + 10) * M, (sy + 10) * M)
        sk = fb.add_sketch("DRW - Standoff Trim Sketch", PLANE_TOP, ents)
        scope = (pids["Fixture Standoff FL"] + pids["Fixture Standoff FR"] +
                 pids["Fixture Standoff RL"] + pids["Fixture Standoff RR"])
        fid, st = remove_extrude(fb, "DRW - Standoff Trim", sk, 30, -2, scope)
        print("  standoff trim:", st)
        time.sleep(2)

    # ---- 1b. tray, slides, rails ------------------------------------------
    if "DRW - Tray Plate" not in fnames:
        sk = fb.add_sketch("DRW - Tray Sketch", PLANE_TOP,
                           rect("tray", -0.285, -0.215, 0.285, 0.215))
        fb.add_extrude("DRW - Tray Plate", sk, 8, offset_mm=20)
        time.sleep(2)
        sk = fb.add_sketch("DRW - Slides Sketch", PLANE_TOP,
                           rect("sldL", -0.300, -0.215, -0.285, 0.215) +
                           rect("sldR", 0.285, -0.215, 0.300, 0.215))
        fb.add_extrude("DRW - Slides", sk, 12, offset_mm=20)
        time.sleep(2)
        sk = fb.add_sketch("DRW - Rails Sketch", PLANE_TOP,
                           rect("rlL", -0.316, -0.278, -0.300, 0.278) +
                           rect("rlR", 0.300, -0.278, 0.316, 0.278))
        fb.add_extrude("DRW - Support Rails", sk, 20, offset_mm=14)
        print("  tray + slides + rails built")
        time.sleep(2)

    # ---- 1c. front aperture + drawer panel + handle ------------------------
    if "DRW - Front Aperture" not in fnames:
        sk = fb.add_sketch("DRW - Aperture Sketch", PLANE_FRONT,
                           rect("aper", -0.290, 0.014, 0.290, 0.078))
        fid, st = remove_extrude(
            fb, "DRW - Front Aperture", sk, 13, 449,
            pids["Trim - Front Sill"] + pids["Glass Frame Bottom"])
        print("  front aperture:", st)
        time.sleep(2)
        sk = fb.add_sketch("DRW - Panel Sketch", PLANE_FRONT,
                           rect("dpnl", -0.288, 0.014, 0.288, 0.078))
        fb.add_extrude("DRW - Front Panel", sk, 10, offset_mm=452)
        time.sleep(2)
        sk = fb.add_sketch("DRW - Handle Sketch", PLANE_FRONT,
                           rounded_rect("dhnd", -0.120, 0.038, 0.120, 0.054,
                                        0.006))
        fb.add_extrude("DRW - Handle", sk, 14, offset_mm=462)
        time.sleep(2)
        sk = fb.add_sketch("DRW - Latch Sketch", PLANE_TOP,
                           rect("dlat", -0.015, 0.218, 0.015, 0.230))
        fb.add_extrude("DRW - Latch Block", sk, 14, offset_mm=20)
        time.sleep(2)
        sk = fb.add_sketch("DRW - Travel Sketch", PLANE_TOP,
                           rect("dtrv", -0.285, -0.695, 0.285, 0.215))
        fb.add_extrude("DRW - Travel Envelope", sk, 50, offset_mm=20)
        print("  panel + handle + latch + travel envelope built")
        time.sleep(2)

    # ---- 2. M5 grid ---------------------------------------------------------
    print("=== M5 fixture grid ===")
    if "DRW - Fixture M5 Grid" not in fnames:
        ents, n = [], 0
        for ix in range(-9, 10):
            for iy in range(-7, 8):
                x, y = ix * 25.0, iy * 25.0
                if FID_RECT[0] <= x <= FID_RECT[2] and \
                        FID_RECT[1] <= y <= FID_RECT[3]:
                    continue
                if any(math.hypot(x - kx, y - ky) < KEEPOUT_R
                       for kx, ky in KEEPOUTS):
                    continue
                ents.append(circle("g{}".format(n), x * M, y * M, 0.0021))
                n += 1
        print("  grid holes:", n)
        sk = fb.add_sketch("DRW - Fixture M5 Grid Sketch", PLANE_TOP, ents)
        fid, st = remove_extrude(fb, "DRW - Fixture M5 Grid", sk, 20, 39,
                                 pids["PCB Fixture Plate"])
        print("  grid cut:", st)
        time.sleep(2)

    # ---- naming + metadata --------------------------------------------------
    parts2 = {}
    for p in fb.c.list_parts(DID, WID, EID):
        if p.get("bodyType") != "composite":
            parts2.setdefault(p["name"], []).append(p["partId"])
    boxes = fb.all_bboxes()
    KEY = {"pn": P_PARTNO, "vn": P_VENDOR, "mt": P_MATERIAL, "ap": P_APPEAR,
           "dc": P_DESC, "ex": P_EXCLUDE}
    items = []
    for n, plist in parts2.items():
        if not n.startswith("Part "):
            continue
        b = boxes.get(n)
        if not b:
            continue
        c = tuple((b["low" + d] + b["high" + d]) / 2 for d in "XYZ")
        for tgt, (e, props) in NEW.items():
            if tgt in parts2:
                continue
            if all(abs(c[i] - e[i]) < 8.0 for i in range(3)):
                pr = [{"propertyId": P_NAME, "value": tgt}]
                if not any(k == "ex" for k, _v in props):
                    pr.append({"propertyId": P_EXCLUDE, "value": False})
                for k, v in props:
                    pr.append({"propertyId": KEY[k], "value": v})
                items.append({"partId": plist[0], "properties": pr})
                print("  named:", tgt)
                break
    for i in range(0, len(items), 40):
        batch = items[i:i + 40]
        fb.c._request("POST", "/api/v6/metadata/d/{}/w/{}/e/{}".format(
            DID, WID, EID), json={"items": [
                {"href": "{}/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
                    BASE_URL, DID, WID, EID, quote(it["partId"], safe="")),
                 "properties": it["properties"]} for it in batch]})
        print("  metadata batch applied")
        time.sleep(1.5)

    # ---- verify -------------------------------------------------------------
    print("=== verify ===")
    boxes2 = fb.all_bboxes()

    def overlaps(a, b, tol=0.01):
        return all(a["low" + d] < b["high" + d] - tol and
                   a["high" + d] > b["low" + d] + tol for d in "XYZ")

    plate = boxes2["PCB Fixture Plate"]
    print("  fixture plate bbox Z {:.1f}..{:.1f} (grid cut inside)".format(
        plate["lowZ"], plate["highZ"]))
    so = boxes2["Fixture Standoff FL"]
    print("  standoff FL Z {:.1f}..{:.1f} (want 28..40)".format(
        so["lowZ"], so["highZ"]))
    clean = True
    for tgt in NEW:
        if tgt == "Analysis - Drawer Travel":
            continue
        if tgt not in boxes2:
            print("  !! missing:", tgt)
            clean = False
            continue
        for other, ob in boxes2.items():
            if other == tgt or other.startswith(("Corridor", "ASM", "Analysis")):
                continue
            if other in NEW:
                continue
            if overlaps(boxes2[tgt], ob):
                print("  OVERLAP: {} <-> {}".format(tgt, other))
                clean = False
    print("  overlap scan:", "CLEAN" if clean else "SEE ABOVE")

    # ---- renders + release ----------------------------------------------------
    def cam(yaw_deg, pitch_deg, target, px):
        y, p = math.radians(yaw_deg), math.radians(pitch_deg)
        f = (math.sin(y) * math.cos(p), math.cos(y) * math.cos(p), math.sin(p))
        nn = math.hypot(f[1], -f[0]) or 1.0
        r = (f[1] / nn, -f[0] / nn, 0.0)
        u = (r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2],
             r[0] * f[1] - r[1] * f[0])
        vals = []
        for row in [r, u, tuple(-c for c in f)]:
            t = -(row[0] * target[0] + row[1] * target[1] + row[2] * target[2])
            vals += list(row) + [t]
        return ",".join("{:.6f}".format(v) for v in vals), px

    for name, (vm, px) in [
            ("drawer_front", cam(0, -2, (0, 0, 0.09), 0.00105)),
            ("drawer_detail", cam(-18, -24, (0, -0.15, 0.05), 0.00060)),
            ("grid_top", cam(0, -62, (0, 0, 0.06), 0.00055))]:
        r = fb.c._request(
            "GET", "/api/v6/partstudios/d/{}/w/{}/e/{}/shadedviews".format(
                DID, WID, EID),
            params={"viewMatrix": vm, "outputHeight": 900, "outputWidth": 1200,
                    "pixelSize": px, "showAllParts": "true"})
        with open(SCRATCH + "/{}.png".format(name), "wb") as f:
            f.write(base64.b64decode(r["images"][0]))
        print("render:", name)

    ver = fb.c._request("POST", "/api/v6/documents/d/{}/versions".format(DID),
                        json={"name": "PROD-PASS-4", "documentId": DID,
                              "workspaceId": WID,
                              "description": "Fixture drawer + universal M5 "
                              "grid"})
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
            print("!! STEP FAILED:", st.get("failureReason"))
            break
    print("PHASE G COMPLETE")


if __name__ == "__main__":
    main()
