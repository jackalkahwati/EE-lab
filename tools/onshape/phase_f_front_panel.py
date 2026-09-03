"""Phase F — front panel rework (2026-07-03), per design review feedback.

1. E-STOP RELOCATION — from the right shell front (470, Z+300) to the
   front fascia beside the display cluster, center (-60, Z-60):
   - delete the old O22 panel hole in the right shell (feature delete
     restores the shell wall)
   - TRANSFORM the three E-stop bodies (-530, 0, -360). Transforms keep
     partIds, so the Motion Check instances + Static Frame group follow
     with no assembly surgery.
   - cut a new O22 panel hole through the Plinth Fascia
   - appearance: bezel + stem black (22,22,25) to match the display
     bezel; cap stays RED — ISO 13850 requires a red actuator, so the
     housing matches the machine but the mushroom itself must not.
2. DISPLAY UPSIZE 10.1in -> 15.6in (1920x1080) — display bodies are NOT
   in the Motion Check assembly, so delete + rebuild is safe:
   bezel 370x220 (X 28..398, Z -225..-5), glass 344x194 16:9
   (X 41..385, Z -212..-18), UI layer + status bar overlays to match.
   Same Y stack as before (bezel proud 2, glass 1 more, UI 0.5).
3. WORDMARK R FIX — Glyph 03's bowl counter solidified when the sketch
   regions unioned (the enclosed region extruded too). REMOVE cut of the
   counter rect (X -340.4..-334.0, Z -135.6..-130.8) scoped to the glyph;
   boundaries are interior to the solid so no coincident-face risk.
4. Verify (bboxes + front render), Version PROD-PASS-2, STEP v7 export.

Idempotent via the feature-name list fetched once at start.
"""

from __future__ import annotations

import base64
import json
import os
import time
import warnings

warnings.filterwarnings("ignore")

from urllib.parse import quote

import requests

from features import FeatureBuilder, circle, rect, rounded_rect
from onshape_client import Client, BASE_URL
from phase_e_production import (ABS, AL6061, ELEC, P_DESC, P_EXCLUDE,
                                P_MATERIAL, P_NAME, P_PARTNO, P_VENDOR,
                                PLANE_FRONT, remove_extrude)

P_APPEAR = "57f3fb8efa3416c06701d60c"

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"

SCRATCH = os.environ.get("SCRATCH", "/tmp")
STEP_OUT = os.path.join(os.path.dirname(__file__), "..", "..",
                        "cad", "electronics-bringup-station",
                        "Part_Studio_1_v7.step")

M = 0.001

DISPLAY_OLD = ["Touch Display Bezel", "Touch Display 10.1in",
               "Display UI Layer", "Display Status Bar"]

#: new display geometry (mm): (X0, Z0, X1, Z1, corner r, Y offset, depth)
BEZEL = (28, -225, 398, -5, 8, 460, 2)
GLASS = (41, -212, 385, -18, 5, 462, 1)
UILAY = (49, -205, 377, -41, None, 462.6, 0.5)
SBAR = (49, -39, 377, -25, None, 462.6, 0.6)

ESTOP_NAMES = ["E-Stop Bezel", "E-Stop Stem", "E-Stop Button Cap"]
ESTOP_D = (-530.0, 0.0, -360.0)          # (470, Z+300) -> (-60, Z-60)
ESTOP_NEW_X = -60.0


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)
    parts = {p["name"]: p["partId"] for p in fb.c.list_parts(DID, WID, EID)
             if p.get("bodyType") != "composite"}
    boxes = fb.all_bboxes()
    feats = fb.get_features()
    fnames = {f.get("name"): f.get("featureId") for f in feats["features"]}

    # ---- 1a. delete the old shell panel hole ----------------------------
    print("=== 1. E-stop relocation ===")
    if "PROD - EStop Panel Hole" in fnames:
        fb.delete_feature(fnames["PROD - EStop Panel Hole"])
        fb.delete_feature(fnames["PROD - EStop Panel Hole Sketch"])
        print("  old shell hole feature deleted (shell wall restored)")
        time.sleep(2)
    else:
        print("  old shell hole already gone")

    # ---- 1b. move the three E-stop bodies -------------------------------
    bez = boxes["E-Stop Bezel"]
    if abs((bez["lowX"] + bez["highX"]) / 2 - ESTOP_NEW_X) > 1.0:
        fb.transform_translate([parts[n] for n in ESTOP_NAMES], *ESTOP_D,
                               name="PROD - EStop Relocate")
        print("  E-stop translated by", ESTOP_D)
        time.sleep(2)
    else:
        print("  E-stop already at new location")

    # ---- 1c. new fascia panel hole ---------------------------------------
    if "PROD - EStop Fascia Hole" not in fnames:
        sk = fb.add_sketch("PROD - EStop Fascia Hole Sketch", PLANE_FRONT,
                           [circle("esfh", -0.060, -0.060, 0.011)])
        fid, st = remove_extrude(fb, "PROD - EStop Fascia Hole", sk, 24, 438,
                                 [parts["Plinth Fascia"]])
        print("  fascia hole O22:", st)
        time.sleep(2)
    else:
        print("  fascia hole already present")

    # ---- 1d. colors -------------------------------------------------------
    black = {"color": {"red": 22, "green": 22, "blue": 25}, "opacity": 255}
    red = {"color": {"red": 204, "green": 24, "blue": 30}, "opacity": 255}
    items = [
        {"partId": parts["E-Stop Bezel"],
         "properties": [{"propertyId": P_APPEAR, "value": black}]},
        {"partId": parts["E-Stop Stem"],
         "properties": [{"propertyId": P_APPEAR, "value": black}]},
        {"partId": parts["E-Stop Button Cap"],
         "properties": [{"propertyId": P_APPEAR, "value": red},
                        {"propertyId": P_DESC, "value":
                         "E-stop mushroom cap O45 — RED per ISO 13850 "
                         "(housing black to match fascia)"}]},
    ]

    # ---- 2. display upsize ------------------------------------------------
    print("=== 2. display 10.1in -> 15.6in ===")
    if "PROD - Display Bezel 15.6" not in fnames:
        dead = [parts[n] for n in DISPLAY_OLD if n in parts]
        if dead:
            fb.delete_bodies(dead, name="PROD - Delete 10.1in Display")
            print("  old display bodies deleted:", len(dead))
            time.sleep(2)
        new_disp = []
        for name, (x0, z0, x1, z1, r, off, dep) in [
                ("PROD - Display Bezel 15.6", BEZEL),
                ("PROD - Display Glass 15.6", GLASS),
                ("PROD - Display UI Layer 15.6", UILAY),
                ("PROD - Display Status Bar 15.6", SBAR)]:
            if r:
                ents = rounded_rect(name[:8], x0 * M, z0 * M, x1 * M, z1 * M,
                                    r * M)
            else:
                ents = rect(name[:8], x0 * M, z0 * M, x1 * M, z1 * M)
            sk = fb.add_sketch(name + " Sketch", PLANE_FRONT, ents)
            fb.add_extrude(name, sk, dep, offset_mm=off)
            print("  built", name)
            time.sleep(2)
    else:
        print("  15.6in display already present")

    # ---- 3. wordmark R counter fix ----------------------------------------
    print("=== 3. wordmark R counter ===")
    if "PROD - R Counter Cut" not in fnames:
        sk = fb.add_sketch("PROD - R Counter Sketch", PLANE_FRONT,
                           rect("rctr", -0.3404, -0.1356, -0.3340, -0.1308))
        fid, st = remove_extrude(fb, "PROD - R Counter Cut", sk, 3, 459,
                                 [parts["Wordmark Glyph 03"]])
        print("  R counter cut:", st)
        time.sleep(2)
    else:
        print("  R counter already cut")

    # ---- metadata for rebuilt display bodies ------------------------------
    parts2 = {}
    for p in fb.c.list_parts(DID, WID, EID):
        if p.get("bodyType") != "composite":
            parts2.setdefault(p["name"], p["partId"])
    boxes2 = fb.all_bboxes()

    def center(b):
        return tuple((b["low" + d] + b["high" + d]) / 2 for d in "XYZ")

    exp = {
        "Touch Display Bezel": (
            ((BEZEL[0] + BEZEL[2]) / 2, -461, (BEZEL[1] + BEZEL[3]) / 2),
            [{"propertyId": P_PARTNO, "value": "EE-FAB-DSPBZL"},
             {"propertyId": P_VENDOR, "value": "FAB - machine"},
             {"propertyId": P_MATERIAL, "value": AL6061},
             {"propertyId": P_APPEAR, "value": black},
             {"propertyId": P_EXCLUDE, "value": False},
             {"propertyId": P_DESC, "value":
              "Touch display bezel 370x220, Cosmetic Class A"}]),
        "Touch Display 15.6in": (
            ((GLASS[0] + GLASS[2]) / 2, -462.5, (GLASS[1] + GLASS[3]) / 2),
            [{"propertyId": P_PARTNO, "value":
              "15.6in HDMI capacitive touch 1920x1080"},
             {"propertyId": P_VENDOR, "value": "Waveshare"},
             {"propertyId": P_MATERIAL, "value": ELEC},
             {"propertyId": P_APPEAR, "value":
              {"color": {"red": 15, "green": 18, "blue": 26}, "opacity": 235}},
             {"propertyId": P_EXCLUDE, "value": False}]),
        "Display UI Layer": (
            ((UILAY[0] + UILAY[2]) / 2, -462.85, (UILAY[1] + UILAY[3]) / 2),
            [{"propertyId": P_PARTNO, "value": "UI MOCK"},
             {"propertyId": P_MATERIAL, "value": ABS},
             {"propertyId": P_APPEAR, "value":
              {"color": {"red": 96, "green": 148, "blue": 216}, "opacity": 255}},
             {"propertyId": P_EXCLUDE, "value": True}]),
        "Display Status Bar": (
            ((SBAR[0] + SBAR[2]) / 2, -462.9, (SBAR[1] + SBAR[3]) / 2),
            [{"propertyId": P_PARTNO, "value": "UI MOCK"},
             {"propertyId": P_MATERIAL, "value": ABS},
             {"propertyId": P_APPEAR, "value":
              {"color": {"red": 190, "green": 215, "blue": 250}, "opacity": 255}},
             {"propertyId": P_EXCLUDE, "value": True}]),
    }
    sizes = {"Touch Display Bezel": (BEZEL[2] - BEZEL[0], BEZEL[3] - BEZEL[1]),
             "Touch Display 15.6in": (GLASS[2] - GLASS[0], GLASS[3] - GLASS[1]),
             "Display UI Layer": (UILAY[2] - UILAY[0], UILAY[3] - UILAY[1]),
             "Display Status Bar": (SBAR[2] - SBAR[0], SBAR[3] - SBAR[1])}
    for n, pid in parts2.items():
        if not n.startswith("Part "):
            continue
        b = boxes2.get(n)
        if not b:
            continue
        c = center(b)
        sz = (b["highX"] - b["lowX"], b["highZ"] - b["lowZ"])
        for tgt, (e, props) in exp.items():
            want = sizes[tgt]
            if all(abs(c[i] - e[i]) < 4.0 for i in range(3)) and \
                    abs(sz[0] - want[0]) < 2.0 and abs(sz[1] - want[1]) < 2.0:
                items.append({"partId": pid, "properties":
                              [{"propertyId": P_NAME, "value": tgt}] + props})
                print("  named:", tgt)
                break
    for i in range(0, len(items), 40):
        batch = items[i:i + 40]
        fb.c._request("POST", "/api/v6/metadata/d/{}/w/{}/e/{}".format(
            DID, WID, EID), json={"items": [
                {"href": "{}/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
                    BASE_URL, DID, WID, EID, quote(it["partId"], safe="")),
                 "properties": it["properties"]} for it in batch]})
        print("  metadata batch applied ({} items)".format(len(batch)))
        time.sleep(1.5)

    # ---- 4. verify + release ----------------------------------------------
    print("=== 4. verify ===")
    boxes3 = fb.all_bboxes()
    with open(SCRATCH + "/phase_f_bboxes.json", "w") as f:
        json.dump(boxes3, f, indent=1)
    for n in ["E-Stop Bezel", "E-Stop Button Cap", "Touch Display Bezel",
              "Touch Display 15.6in", "Wordmark Glyph 03"]:
        b = boxes3.get(n)
        if b:
            print("  {:22s} X {:7.1f}..{:7.1f}  Y {:7.1f}..{:7.1f}  "
                  "Z {:7.1f}..{:7.1f}".format(
                      n, b["lowX"], b["highX"], b["lowY"], b["highY"],
                      b["lowZ"], b["highZ"]))
        else:
            print("  !! missing:", n)

    def overlaps(a, b, tol=0.01):
        return all(a["low" + d] < b["high" + d] - tol and
                   a["high" + d] > b["low" + d] + tol for d in "XYZ")

    clean = True
    for n in (["Touch Display Bezel", "Touch Display 15.6in"] + ESTOP_NAMES):
        for other, ob in boxes3.items():
            if other == n or other.startswith(("Corridor", "ASM", "Analysis")):
                continue
            if other in ("Touch Display 15.6in", "Display UI Layer",
                         "Display Status Bar", "Touch Display Bezel") \
                    and n.startswith("Touch"):
                continue
            if overlaps(boxes3[n], ob):
                print("  OVERLAP: {} <-> {}".format(n, other))
                clean = False
    print("  overlap scan:", "CLEAN" if clean else "SEE ABOVE")

    # front render
    r = fb.c._request("GET",
                      "/api/v6/partstudios/d/{}/w/{}/e/{}/shadedviews".format(
                          DID, WID, EID),
                      params={"viewMatrix": "1,0,0,0,0,0,1,0,0,-1,0,0",
                              "outputHeight": 900, "outputWidth": 1200,
                              "pixelSize": 0})
    with open(SCRATCH + "/front_panel.png", "wb") as f:
        f.write(base64.b64decode(r["images"][0]))
    print("  front render:", SCRATCH + "/front_panel.png")

    ver = fb.c._request("POST", "/api/v6/documents/d/{}/versions".format(DID),
                        json={"name": "PROD-PASS-2", "documentId": DID,
                              "workspaceId": WID,
                              "description": "Front panel rework: E-stop on "
                              "fascia, 15.6in display, R glyph fix"})
    print("  version:", ver.get("name"), ver.get("id"))

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
            resp = requests.get("{}/api/v6/documents/d/{}/externaldata/{}".format(
                BASE_URL, DID, xid), auth=fb.c._auth, timeout=120)
            resp.raise_for_status()
            with open(os.path.abspath(STEP_OUT), "wb") as f:
                f.write(resp.content)
            print("  STEP exported:", os.path.abspath(STEP_OUT),
                  "({:.1f} MB)".format(len(resp.content) / 1e6))
            break
        if st.get("requestState") == "FAILED":
            print("  !! STEP translation FAILED:", st.get("failureReason"))
            break
    print("PHASE F COMPLETE")


if __name__ == "__main__":
    main()
