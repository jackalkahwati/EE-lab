"""Phase H — ESD kit, powered drawer through the door, laser warp scanner.

1. DOOR-EXIT DRAWER (replaces the exterior fascia-panel concept):
   - fascia panel / handle / arms DELETED (bodies; glass door covers the
     exit instead). Physics note: the internal frame pass-under stays —
     the frame front member (Z 0..80) and front X rail (Z 80..97.5)
     cross the exit path, and lifting over them collides with the beam.
     From outside none of that is visible.
   - Glass Frame Bottom sliver (Z 78..80) cleared across the aperture;
     the AMBER DOOR EXTENDS DOWN over the drawer exit (boolean ADD into
     the glass body, X +/-288, Z 16..80, 2 mm reveals) — stepped door
     leaf; partId preserved so the Motion Check instance follows.
   - ELECTRIC DRIVE: compact leadscrew axis (igus drylin SAW class +
     NEMA17) under the plate in the clear lane X -220..-180, Z 28..40,
     motor at the rear (Z 12..54, 1 mm under the deck). Drive enabled
     ONLY with the door open; drawer-out state breaks the same G9SE
     guard circuit. Open window -> drive out -> load -> drive in ->
     close window.
2. ESD KIT (per the S20.20/61340-5-1 review):
   - drawer GROUND BRAID (flex flat braid, plate rear -> chassis)
   - WRIST-STRAP JACK (banana + 1 Mohm) on the fascia left of the display
   - IONIZER BAR on the camera bracket center arm beside the IR camera
     (same accepted sweep-exposure zone as the cameras)
   - fixture plate + standoffs finish -> CHEM-FILM (MIL-DTL-5541 Cl 3,
     conductive) — desc metadata + RFQ; anodize was an insulator
   - drag chains / cable-loop links -> igus ESD (dissipative) PN swap
3. LASER WARP SCANNER — 450 nm line-laser triangulation head (Micro-
   Epsilon scanCONTROL class) on the Z slide plate: pre-probe board
   warp map feeds probe Z-planning. Class 3R contained; the amber PMMA
   window attenuates 405-450 nm, making it a functional laser viewing
   guard (it now earns its color).

Release: Version PROD-PASS-5, STEP v13.
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
from phase_e_production import (AL6061, ELEC, PLANE_FRONT, SS, STEEL,
                                P_DESC, P_EXCLUDE, P_MATERIAL, P_NAME,
                                P_PARTNO, P_VENDOR, mat, remove_extrude)

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"
SCRATCH = os.environ.get("SCRATCH", "/tmp")
STEP_OUT = os.path.join(os.path.dirname(__file__), "..", "..",
                        "cad", "electronics-bringup-station",
                        "Part_Studio_1_v13.step")

PLANE_TOP = {"btType": "BTMParameterQueryList-148", "parameterId": "sketchPlane",
             "queries": [{"btType": "BTMIndividualQuery-138",
                          "deterministicIds": ["JDC"]}]}
P_APPEAR = "57f3fb8efa3416c06701d60c"
M = 0.001
CU = mat("Copper braid (tinned)", 8900)

DEAD = ["Drawer Front Panel", "Drawer Handle", "Drawer Arm Left",
        "Drawer Arm Right"]


def C(r, g, b, o=255):
    return {"color": {"red": r, "green": g, "blue": b}, "opacity": o}


NEW = {
    "Drawer Drive Actuator": ((-200, 0, 34), [
        ("pn", "drylin SAW-0630 + lead screw"), ("vn", "igus"),
        ("mt", AL6061), ("ap", C(120, 122, 126)),
        ("dc", "Powered drawer axis under plate; drive enabled only with "
               "door open (G9SE), stalls torque-limited")]),
    "Drawer Drive Motor": ((-199, 234, 33), [
        ("pn", "NEMA17 + encoder"), ("vn", "StepperOnline"), ("mt", ELEC),
        ("ap", C(38, 38, 40)), ("dc", "Drawer drive motor, rear of axis")]),
    "Drawer Ground Braid": ((-50, 244, 38), [
        ("pn", "flat braid 10mm + lugs"), ("vn", "Hardware"), ("mt", CU),
        ("ap", C(184, 115, 51)),
        ("dc", "ESD/PE bond: fixture plate -> chassis, survives 480 mm "
               "travel (service-loop slack)")]),
    "Wrist Strap Jack Plate": ((-350, -461, -60), [
        ("pn", "09863"), ("vn", "Desco"), ("mt", SS),
        ("ap", C(160, 162, 166)),
        ("dc", "Operator common bonding point, 1 Mohm banana jack, at "
               "the drawer loading position")]),
    "Wrist Strap Jack": ((-350, -466, -60), [
        ("pn", "09863"), ("vn", "Desco"), ("mt", ELEC),
        ("ap", C(240, 200, 50)), ("dc", "Wrist-strap banana jack")]),
    "Ionizer Bar": ((0, 100, 296), [
        ("pn", "IZS31-160"), ("vn", "SMC"), ("mt", ELEC),
        ("ap", C(45, 45, 48)),
        ("dc", "Ionizing bar over the work zone: neutralizes amber-window "
               "PMMA, chains, and DUT charge; extend coverage at DVT")]),
    "Laser Warp Scanner 450nm": ((98, 0, 145), [
        ("pn", "scanCONTROL 3060BL"), ("vn", "Micro-Epsilon"), ("mt", ELEC),
        ("ap", C(30, 30, 34)),
        ("dc", "450 nm line-laser warp mapper on Z slide (Class 3R "
               "contained). Pre-probe warp map feeds probe Z-planning. "
               "Amber PMMA window attenuates 405-450 nm = viewing guard")]),
}

CHAIN_PN = [("Drag Chain", "E2C.10 ESD (dissipative)", "igus"),
            ("Cable Loop Link", "triflex ESD (dissipative)", "igus")]

CHEMFILM = ("Finish: CHEM-FILM MIL-DTL-5541 Class 3 (conductive, ESD "
            "surface) — changed from anodize")


def add_union(fb, name, sketch_fid, depth_mm, offset_mm, scope_pids):
    """Boolean ADD extrude merged into scope bodies (partIds preserved)."""
    params = [
        {"btType": "BTMParameterEnum-145", "parameterId": "bodyType",
         "value": "SOLID", "enumName": "ExtendedToolBodyType"},
        {"btType": "BTMParameterEnum-145", "parameterId": "operationType",
         "value": "ADD", "enumName": "NewBodyOperationType"},
        {"btType": "BTMParameterQueryList-148", "parameterId": "entities",
         "queries": [{"btType": "BTMIndividualSketchRegionQuery-140",
                      "featureId": sketch_fid}]},
        {"btType": "BTMParameterEnum-145", "parameterId": "endBound",
         "value": "BLIND", "enumName": "BoundingType"},
        {"btType": "BTMParameterQuantity-147", "parameterId": "depth",
         "expression": "{} mm".format(depth_mm)},
        {"btType": "BTMParameterBoolean-144", "parameterId": "oppositeDirection",
         "value": False},
        {"btType": "BTMParameterBoolean-144", "parameterId": "defaultScope",
         "value": False},
        {"btType": "BTMParameterQueryList-148", "parameterId": "booleanScope",
         "queries": [{"btType": "BTMIndividualQuery-138",
                      "deterministicIds": scope_pids}]},
        {"btType": "BTMParameterBoolean-144", "parameterId": "startOffset",
         "value": True},
        {"btType": "BTMParameterEnum-145", "parameterId": "startOffsetBound",
         "value": "BLIND", "enumName": "StartOffsetType"},
        {"btType": "BTMParameterQuantity-147",
         "parameterId": "startOffsetDistance",
         "expression": "{} mm".format(abs(offset_mm))},
        {"btType": "BTMParameterBoolean-144",
         "parameterId": "startOffsetOppositeDirection", "value": False},
    ]
    fb._post({"btType": "BTMFeature-134", "featureType": "extrude",
              "name": name, "parameters": params})


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)
    feats = fb.get_features()
    fnames = {f.get("name") for f in feats["features"]}
    pids = {}
    for p in fb.c.list_parts(DID, WID, EID):
        if p.get("bodyType") != "composite":
            pids.setdefault(p["name"], []).append(p["partId"])

    # ---- 1a. remove the fascia-panel drawer exterior ------------------------
    dead = [pid for n in DEAD for pid in pids.get(n, [])]
    if dead:
        fb.delete_bodies(dead, name="H - Remove Fascia Drawer Parts")
        print("removed fascia drawer parts:", len(dead))
        time.sleep(2)
        pids = {}
        for p in fb.c.list_parts(DID, WID, EID):
            if p.get("bodyType") != "composite":
                pids.setdefault(p["name"], []).append(p["partId"])

    # ---- 1b. clear frame-bottom sliver + extend the amber door --------------
    if "H - Door Extension" not in fnames:
        sk = fb.add_sketch("H - Sliver Cut Sketch", PLANE_FRONT,
                           rect("slv", -0.290, 0.076, 0.290, 0.081))
        fid, st = remove_extrude(fb, "H - Sliver Cut", sk, 13, 449,
                                 pids["Glass Frame Bottom"])
        print("frame-bottom sliver:", st)
        time.sleep(2)
        sk = fb.add_sketch("H - Door Extension Sketch", PLANE_FRONT,
                           rect("dext", -0.288, 0.016, 0.288, 0.082))
        add_union(fb, "H - Door Extension", sk, 4, 456,
                  pids["Front Smoked Glass v2"])
        print("amber door extended over the drawer exit (union)")
        time.sleep(2)

    # ---- 1c. powered drive ---------------------------------------------------
    if "H - Drive Actuator" not in fnames:
        sk = fb.add_sketch("H - Drive Actuator Sketch", PLANE_TOP,
                           rect("act", -0.220, -0.210, -0.180, 0.210))
        fb.add_extrude("H - Drive Actuator", sk, 12, offset_mm=28)
        time.sleep(2)
        sk = fb.add_sketch("H - Drive Motor Sketch", PLANE_TOP,
                           rect("mot", -0.220, 0.210, -0.178, 0.258))
        fb.add_extrude("H - Drive Motor", sk, 42, offset_mm=12)
        print("drawer drive built")
        time.sleep(2)

    # ---- 2. ESD bodies --------------------------------------------------------
    if "H - Ground Braid" not in fnames:
        sk = fb.add_sketch("H - Ground Braid Sketch", PLANE_TOP,
                           rect("brd", -0.060, 0.210, -0.040, 0.278))
        fb.add_extrude("H - Ground Braid", sk, 4, offset_mm=36)
        time.sleep(2)
        sk = fb.add_sketch("H - Jack Plate Sketch", PLANE_FRONT,
                           rect("jpl", -0.365, -0.075, -0.335, -0.045))
        fb.add_extrude("H - Jack Plate", sk, 2, offset_mm=460)
        time.sleep(2)
        sk = fb.add_sketch("H - Jack Sketch", PLANE_FRONT,
                           [circle("jck", -0.350, -0.060, 0.006)])
        fb.add_extrude("H - Jack", sk, 8, offset_mm=462)
        time.sleep(2)
        sk = fb.add_sketch("H - Ionizer Sketch", PLANE_TOP,
                           rect("ion", -0.015, 0.070, 0.015, 0.130))
        fb.add_extrude("H - Ionizer", sk, 16, offset_mm=288)
        print("ESD bodies built")
        time.sleep(2)

    # ---- 3. laser warp scanner ------------------------------------------------
    if "H - Warp Scanner" not in fnames:
        sk = fb.add_sketch("H - Warp Scanner Sketch", PLANE_TOP,
                           rect("lws", 0.083, -0.025, 0.113, 0.025))
        fb.add_extrude("H - Warp Scanner", sk, 60, offset_mm=115)
        print("warp scanner built")
        time.sleep(2)

    # ---- naming + metadata -----------------------------------------------------
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
            if all(abs(c[i] - e[i]) < 4.0 for i in range(3)):
                pr = [{"propertyId": P_NAME, "value": tgt},
                      {"propertyId": P_EXCLUDE, "value": False}]
                for k, v in props:
                    pr.append({"propertyId": KEY[k], "value": v})
                items.append({"partId": plist[0], "properties": pr})
                print("  named:", tgt)
                break
    # chem-film descs
    for n in ("PCB Fixture Plate", "Fixture Standoff FL", "Fixture Standoff FR",
              "Fixture Standoff RL", "Fixture Standoff RR"):
        for pid in parts2.get(n, []):
            items.append({"partId": pid, "properties": [
                {"propertyId": P_DESC, "value": CHEMFILM}]})
    # ESD chain PN swap
    for n, plist in parts2.items():
        for pat, pn, vn in CHAIN_PN:
            if pat in n:
                for pid in plist:
                    items.append({"partId": pid, "properties": [
                        {"propertyId": P_PARTNO, "value": pn},
                        {"propertyId": P_VENDOR, "value": vn}]})
                break
    # glass desc: laser guard + door leaf
    for pid in parts2.get("Front Smoked Glass v2", []):
        items.append({"partId": pid, "properties": [{"propertyId": P_DESC,
            "value": "Amber PMMA door leaf (stepped, covers drawer exit); "
                     "attenuates 405-450 nm — viewing guard for the Class 3R "
                     "warp scanner; ESD note: chargeable insulator, managed "
                     "by ionizer bar"}]})
    for i in range(0, len(items), 40):
        batch = items[i:i + 40]
        fb.c._request("POST", "/api/v6/metadata/d/{}/w/{}/e/{}".format(
            DID, WID, EID), json={"items": [
                {"href": "{}/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
                    BASE_URL, DID, WID, EID, quote(it["partId"], safe="")),
                 "properties": it["properties"]} for it in batch]})
        print("  metadata batch applied ({})".format(len(batch)))
        time.sleep(1.5)

    # ---- verify -----------------------------------------------------------------
    print("=== verify ===")
    boxes2 = fb.all_bboxes()
    g = boxes2["Front Smoked Glass v2"]
    print("  glass (door leaf) Z {:.1f}..{:.1f} (want 16..440)".format(
        g["lowZ"], g["highZ"]))

    def overlaps(a, b, tol=0.01):
        return all(a["low" + d] < b["high" + d] - tol and
                   a["high" + d] > b["low" + d] + tol for d in "XYZ")

    clean = True
    for tgt in list(NEW):
        if tgt not in boxes2:
            print("  !! missing:", tgt)
            clean = False
            continue
        for other, ob in boxes2.items():
            if other == tgt or other.startswith(("Corridor", "ASM", "Analysis")):
                continue
            if other in NEW or other == "Base Frame":
                continue
            if overlaps(boxes2[tgt], ob):
                print("  OVERLAP: {} <-> {}".format(tgt, other))
                clean = False
    print("  overlap scan:", "CLEAN" if clean else "SEE ABOVE")

    # ---- renders + release --------------------------------------------------------
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
            ("esd_front", cam(0, -2, (0, 0, 0.09), 0.00105)),
            ("esd_hero", cam(-35, -14, (0, 0, 0.09), 0.00135))]:
        r = fb.c._request(
            "GET", "/api/v6/partstudios/d/{}/w/{}/e/{}/shadedviews".format(
                DID, WID, EID),
            params={"viewMatrix": vm, "outputHeight": 900, "outputWidth": 1200,
                    "pixelSize": px, "showAllParts": "true"})
        with open(SCRATCH + "/{}.png".format(name), "wb") as f:
            f.write(base64.b64decode(r["images"][0]))
        print("render:", name)

    ver = fb.c._request("POST", "/api/v6/documents/d/{}/versions".format(DID),
                        json={"name": "PROD-PASS-5", "documentId": DID,
                              "workspaceId": WID,
                              "description": "ESD kit, powered door-exit "
                              "drawer, 450nm warp scanner"})
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
            print("STEP v13 exported ({:.1f} MB)".format(len(resp.content) / 1e6))
            break
        if st.get("requestState") == "FAILED":
            print("!! STEP FAILED:", st.get("failureReason"))
            break
    print("PHASE H COMPLETE")


if __name__ == "__main__":
    main()
