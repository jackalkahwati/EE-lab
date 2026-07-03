"""Phase G2 — drawer re-architecture after bay/frame clash discovery.

The v1 drawer (tray under the standoffs at Z 20..28) plowed through the
measurement bay stack (relay matrix + blind-mate pogos + protection
board + Saleae, Z 5..43 under the fixture) and ignored that the Base
Frame front member is SOLID Z 0..80 — nothing can slide forward at
fixture height without a passage.

v2 architecture:
- THE FIXTURE PLATE IS THE DRAWER. Slide envelopes clamp its side faces
  at X +/-(260..275), Z 44..54 — above everything in the bay (tallest
  43) and 1 mm under the deck (55). Support rails X +/-(275..291) on
  four 12x12 posts at (+/-283, +/-120), Z 5..44 (verified clear).
- The trimmed standoffs REVERT to Z 0..40 (trim feature deleted): they
  become closed-position kinematic seats — slides carry the plate in
  travel, the plate settles onto the standoffs + latch when closed, so
  probing loads bypass the slides and Z datum repeats.
- FRAME TUNNEL: X +/-290, Z 36..72 cut through the Base Frame front
  member. Leaves an 8 mm top chord (X limit switch mounts on the frame
  top face survive untouched) and a 36 mm bottom web; reinforce at DVT.
  Payload ride-through headroom: Z 72 - board top 59.6 = ~12 mm max
  component height with the drawer; taller assemblies top-load through
  the door as before.
- Force Calibration Post trimmed to Z 68 (was 73) to clear the tunnel.
- Fascia panel + handle (kept from v1) now connect via two drawer arms
  X +/-(230..250), Y -452..-210, Z 44..54, running through the tunnel.
- Latch block v2 at plate rear (Z 44..56); travel envelope re-drawn at
  the actual payload band (Z 38..74).

Order matters (stale-id lesson): the standoff-trim FEATURE deletion
happens first, parts are refetched, THEN the v1 bodies are removed via
one deleteBodies feature, then v2 builds.
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

from features import FeatureBuilder, rect
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
NONE_ = mat("Analysis body (no fab)", 1)

V1_BODIES = ["Drawer Tray Plate", "Drawer Slide Left", "Drawer Slide Right",
             "Drawer Support Rail Left", "Drawer Support Rail Right",
             "Drawer Latch Block", "Analysis - Drawer Travel"]


def C(r, g, b, o=255):
    return {"color": {"red": r, "green": g, "blue": b}, "opacity": o}


NEW = {
    "Drawer Slide Left": ((-267.5, 0, 49), [
        ("pn", "DZ9301-0450"), ("vn", "Accuride"), ("mt", STEEL),
        ("ap", C(140, 143, 148)),
        ("dc", "Full-extension slide on plate side face; carries travel "
               "loads only — closed seats take probing loads")]),
    "Drawer Slide Right": ((267.5, 0, 49), [
        ("pn", "DZ9301-0450"), ("vn", "Accuride"), ("mt", STEEL),
        ("ap", C(140, 143, 148)), ("dc", "Full-extension slide")]),
    "Drawer Support Rail Left": ((-283, 0, 49), [
        ("pn", "EE-FAB-DRWRAIL"), ("vn", "FAB - machine"), ("mt", AL6061),
        ("ap", C(120, 122, 126)), ("dc", "Slide support rail on posts")]),
    "Drawer Support Rail Right": ((283, 0, 49), [
        ("pn", "EE-FAB-DRWRAIL"), ("vn", "FAB - machine"), ("mt", AL6061),
        ("ap", C(120, 122, 126)), ("dc", "Slide support rail on posts")]),
    "Drawer Post FL": ((-283, -120, 24.5), [
        ("pn", "EE-FAB-DRWPOST"), ("vn", "FAB - machine"), ("mt", AL6061),
        ("ap", C(120, 122, 126)), ("dc", "Rail support post 12x12x39")]),
    "Drawer Post FR": ((283, -120, 24.5), [
        ("pn", "EE-FAB-DRWPOST"), ("vn", "FAB - machine"), ("mt", AL6061),
        ("ap", C(120, 122, 126)), ("dc", "Rail support post 12x12x39")]),
    "Drawer Post RL": ((-283, 120, 24.5), [
        ("pn", "EE-FAB-DRWPOST"), ("vn", "FAB - machine"), ("mt", AL6061),
        ("ap", C(120, 122, 126)), ("dc", "Rail support post 12x12x39")]),
    "Drawer Post RR": ((283, 120, 24.5), [
        ("pn", "EE-FAB-DRWPOST"), ("vn", "FAB - machine"), ("mt", AL6061),
        ("ap", C(120, 122, 126)), ("dc", "Rail support post 12x12x39")]),
    "Drawer Arm Left": ((-240, -331, 49), [
        ("pn", "EE-FAB-DRWARM"), ("vn", "FAB - machine"), ("mt", AL6061),
        ("ap", C(60, 62, 66)),
        ("dc", "Fascia-to-plate arm, runs through the frame tunnel")]),
    "Drawer Arm Right": ((240, -331, 49), [
        ("pn", "EE-FAB-DRWARM"), ("vn", "FAB - machine"), ("mt", AL6061),
        ("ap", C(60, 62, 66)), ("dc", "Fascia-to-plate arm")]),
    "Drawer Latch Block": ((0, 224, 50), [
        ("pn", "E5-10-505-50"), ("vn", "Southco"), ("mt", STEEL),
        ("ap", C(45, 45, 48)),
        ("dc", "Closed-position latch + kinematic stop; drawer-open breaks "
               "the G9SE guard circuit (wired with door interlock)")]),
    "Analysis - Drawer Travel": ((0, -240, 56), [
        ("pn", "ANALYSIS"), ("vn", ""), ("mt", NONE_),
        ("ap", C(255, 140, 0, 40)), ("ex", True),
        ("dc", "Drawer payload travel envelope, 480 mm pull; ride-through "
               "headroom 12 mm above board top")]),
}


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)
    feats = fb.get_features()
    fmap = {f.get("name"): f.get("featureId") for f in feats["features"]}

    # ---- 1. revert the standoff trim (FEATURE delete first!) ---------------
    for fn in ("DRW - Standoff Trim", "DRW - Standoff Trim Sketch"):
        if fn in fmap:
            fb.delete_feature(fmap[fn])
            print("deleted feature:", fn)
            time.sleep(2)

    # ---- 2. fresh ids, then remove the v1 bodies ---------------------------
    pids = {}
    for p in fb.c.list_parts(DID, WID, EID):
        if p.get("bodyType") != "composite":
            pids.setdefault(p["name"], []).append(p["partId"])
    dead = [pid for n in V1_BODIES for pid in pids.get(n, [])]
    if dead:
        fb.delete_bodies(dead, name="DRW2 - Remove v1 Drawer")
        print("v1 drawer bodies removed:", len(dead))
        time.sleep(2)
    pids = {}
    for p in fb.c.list_parts(DID, WID, EID):
        if p.get("bodyType") != "composite":
            pids.setdefault(p["name"], []).append(p["partId"])
    fnames = set(fmap)

    # ---- 3. frame tunnel ----------------------------------------------------
    if "DRW2 - Frame Tunnel" not in fnames:
        sk = fb.add_sketch("DRW2 - Frame Tunnel Sketch", PLANE_FRONT,
                           rect("tun", -0.290, 0.036, 0.290, 0.072))
        fid, st = remove_extrude(fb, "DRW2 - Frame Tunnel", sk, 50, 275,
                                 pids["Base Frame"])
        print("frame tunnel:", st)
        time.sleep(2)

    # ---- 4. force post trim -------------------------------------------------
    if "DRW2 - Force Post Trim" not in fnames:
        sk = fb.add_sketch("DRW2 - Force Post Trim Sketch", PLANE_TOP,
                           rect("fpt", 0.190, 0.050, 0.210, 0.070))
        fid, st = remove_extrude(fb, "DRW2 - Force Post Trim", sk, 10, 68,
                                 pids["Force Calibration Post"])
        print("force post trim:", st)
        time.sleep(2)

    # ---- 5. drawer v2 bodies ------------------------------------------------
    if "DRW2 - Slides" not in fnames:
        sk = fb.add_sketch("DRW2 - Slides Sketch", PLANE_TOP,
                           rect("s2L", -0.275, -0.210, -0.260, 0.210) +
                           rect("s2R", 0.260, -0.210, 0.275, 0.210))
        fb.add_extrude("DRW2 - Slides", sk, 10, offset_mm=44)
        time.sleep(2)
        sk = fb.add_sketch("DRW2 - Rails Sketch", PLANE_TOP,
                           rect("r2L", -0.291, -0.210, -0.275, 0.210) +
                           rect("r2R", 0.275, -0.210, 0.291, 0.210))
        fb.add_extrude("DRW2 - Rails", sk, 10, offset_mm=44)
        time.sleep(2)
        ents = []
        for i, (px, py) in enumerate([(-283, -120), (283, -120),
                                      (-283, 120), (283, 120)]):
            ents += rect("p2{}".format(i), (px - 6) * 0.001, (py - 6) * 0.001,
                         (px + 6) * 0.001, (py + 6) * 0.001)
        sk = fb.add_sketch("DRW2 - Posts Sketch", PLANE_TOP, ents)
        fb.add_extrude("DRW2 - Posts", sk, 39, offset_mm=5)
        time.sleep(2)
        sk = fb.add_sketch("DRW2 - Arms Sketch", PLANE_TOP,
                           rect("a2L", -0.250, -0.452, -0.230, -0.210) +
                           rect("a2R", 0.230, -0.452, 0.250, -0.210))
        fb.add_extrude("DRW2 - Arms", sk, 10, offset_mm=44)
        time.sleep(2)
        sk = fb.add_sketch("DRW2 - Latch Sketch", PLANE_TOP,
                           rect("l2", -0.015, 0.218, 0.015, 0.230))
        fb.add_extrude("DRW2 - Latch", sk, 12, offset_mm=44)
        time.sleep(2)
        sk = fb.add_sketch("DRW2 - Travel Sketch", PLANE_TOP,
                           rect("t2", -0.265, -0.695, 0.265, 0.215))
        fb.add_extrude("DRW2 - Travel Envelope", sk, 36, offset_mm=38)
        print("drawer v2 bodies built")
        time.sleep(2)

    # ---- 6. naming + metadata ----------------------------------------------
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

    # ---- 7. verify ----------------------------------------------------------
    print("=== verify ===")
    boxes2 = fb.all_bboxes()
    so = boxes2["Fixture Standoff FL"]
    print("  standoff FL Z {:.1f}..{:.1f} (want 0..40)".format(
        so["lowZ"], so["highZ"]))
    fp = boxes2["Force Calibration Post"]
    print("  force post Z {:.1f}..{:.1f} (want 58..68)".format(
        fp["lowZ"], fp["highZ"]))

    def overlaps(a, b, tol=0.01):
        return all(a["low" + d] < b["high" + d] - tol and
                   a["high" + d] > b["low" + d] + tol for d in "XYZ")

    clean = True
    for tgt in NEW:
        if tgt.startswith("Analysis"):
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
            if other == "Base Frame":
                continue        # perimeter bbox false positive (center open)
            if overlaps(boxes2[tgt], ob):
                print("  OVERLAP: {} <-> {}".format(tgt, other))
                clean = False
    print("  overlap scan:", "CLEAN (Base Frame bbox excluded — perimeter)"
          if clean else "SEE ABOVE")

    # true distances for the load path claims
    from phase_e_production import DIST_SCRIPT_TMPL, decode
    pairs = [("Drawer Slide Right", "Probe Protection Component Block"),
             ("Drawer Slide Right", "Instrument Deck"),
             ("Drawer Post RR", "Saleae Logic Pro 16"),
             ("Drawer Arm Left", "Base Frame")]
    pf = "[" + ", ".join('["{}", "{}"]'.format(a, b) for a, b in pairs) + "]"
    resp = fb.c._request("POST", fb._base + "/featurescript",
                         json={"script": DIST_SCRIPT_TMPL % pf, "queries": {}})
    for row in decode(resp.get("result")) or []:
        if isinstance(row, dict):
            print("  {:.2f} mm  {} <-> {}".format(row["mm"], row["a"], row["b"]))

    # ---- 8. renders + release -----------------------------------------------
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
            ("drawer2_front", cam(0, -2, (0, 0, 0.09), 0.00105)),
            ("drawer2_detail", cam(-22, -20, (0, -0.20, 0.05), 0.00062)),
            ("grid2_top", cam(0, -62, (0, 0, 0.06), 0.00055))]:
        r = fb.c._request(
            "GET", "/api/v6/partstudios/d/{}/w/{}/e/{}/shadedviews".format(
                DID, WID, EID),
            params={"viewMatrix": vm, "outputHeight": 900, "outputWidth": 1200,
                    "pixelSize": px, "showAllParts": "true"})
        with open(SCRATCH + "/{}.png".format(name), "wb") as f:
            f.write(base64.b64decode(r["images"][0]))
        print("render:", name)

    ver = fb.c._request("POST", "/api/v6/documents/d/{}/versions".format(DID),
                        json={"name": "PROD-PASS-4b", "documentId": DID,
                              "workspaceId": WID,
                              "description": "Drawer v2: plate-as-drawer, "
                              "frame tunnel, kinematic seats"})
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
            print("STEP v12 re-exported ({:.1f} MB)".format(
                len(resp.content) / 1e6))
            break
        if st.get("requestState") == "FAILED":
            print("!! STEP FAILED:", st.get("failureReason"))
            break
    print("PHASE G2 COMPLETE")


if __name__ == "__main__":
    main()
