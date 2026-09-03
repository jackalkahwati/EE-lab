"""ID Pass 3 — proper window corners + real interior colors (2026-07-03).

1. WINDOW CORNERS, PROPERLY — the R60 glass fillet left bright untinted
   notches at every corner (square aperture, rounded glass: you look
   straight into the white shell interior with no glass in the path).
   Fix the way the Fuse does it: DELETE the glass fillet so the square
   pane fills the aperture completely, and add four near-black corner
   GUSSETS behind the glass (Y -456..-450, quarter-concave R60 profile)
   so the aperture still reads rounded through the amber.
   partId lesson applies: the fillet delete regenerates downstream ids,
   so list_parts runs AFTER the deletion.
2. REAL INTERIOR COLORS — name-pattern appearance pass over the whole
   studio: steel rails/screws, black motors, clear-anodize plates, green
   PCBs, brass pogos, black cameras/chains, vendor-true instrument
   colors (PicoScope blue, LabJack red, safety-relay yellow), etc.
   First-match rules; unmatched parts keep their current appearance.
3. Renders: front (wordmark + LCD in frame), hero, interior close-ups.
   Release: Version ID-PASS-3, STEP v11.
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

from features import FeatureBuilder, arc, line
from onshape_client import Client, BASE_URL
from phase_e_production import PLANE_FRONT

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"
SCRATCH = os.environ.get("SCRATCH", "/tmp")
STEP_OUT = os.path.join(os.path.dirname(__file__), "..", "..",
                        "cad", "electronics-bringup-station",
                        "Part_Studio_1_v11.step")

P_NAME = "57f3fb8efa3416c06701d60d"
P_DESC = "57f3fb8efa3416c06701d60e"
P_PARTNO = "57f3fb8efa3416c06701d60f"
P_APPEAR = "57f3fb8efa3416c06701d60c"
P_EXCLUDE = "57f3fb8efa3416c06701d61e"

M = 0.001
PI = math.pi


def C(r, g, b, o=255):
    return {"color": {"red": r, "green": g, "blue": b}, "opacity": o}


#: first-match name-pattern -> appearance
COLOR_RULES = [
    ("Corridor - ", None), ("Swept", None), ("ASM - ", None),   # analysis: skip
    ("Wordmark", None), ("Display", None), ("Touch Display", None),
    ("E-Stop", None), ("Front Smoked Glass", None), ("Glass Frame", None),
    ("Accent Light", None), ("Power LED", None), ("Power Indicator", None),
    ("Probe Head Logo", None), ("Top Slab", None), ("Side Shell", None),

    ("NEMA23", C(38, 38, 40)),
    ("Motor Shaft", C(196, 198, 202)),
    ("Jaw Coupling", C(172, 174, 178)),
    ("Ballscrew", C(192, 194, 198)),
    ("Ballnut", C(146, 148, 152)),
    ("Screw Journal", C(146, 148, 152)),
    ("HGR20 Rail", C(170, 172, 177)), ("HGR15 Rail", C(170, 172, 177)),
    ("MGN12 Rail", C(170, 172, 177)),
    ("Carriage Block", C(142, 145, 150)), ("MGN12H Block", C(142, 145, 150)),
    ("BK12", C(120, 122, 126)), ("BF12", C(120, 122, 126)),
    ("BK10", C(120, 122, 126)), ("BF10", C(120, 122, 126)),
    ("Limit Switch", C(45, 45, 48)),
    ("Drag Chain", C(33, 33, 35)), ("Cable Loop", C(33, 33, 35)),
    ("Cable Trunk", C(33, 33, 35)), ("Cable Gland", C(60, 60, 62)),

    ("Sample PCB", C(18, 104, 58)), ("Cartridge PCB", C(18, 104, 58)),
    ("Relay Matrix Board", C(18, 104, 58)),
    ("Probe Protection Board", C(18, 104, 58)),
    ("PCB Component", C(34, 34, 38)),
    ("PCB Connector", C(212, 202, 178)),
    ("Relay Matrix Relay", C(70, 90, 160)),
    ("Protection Component", C(34, 34, 38)),
    ("Pogo Probe", C(198, 161, 84)),
    ("Preload Spring", C(150, 152, 156)),
    ("Guide Pin", C(160, 162, 166)), ("Dowel", C(160, 162, 166)),
    ("Locating Pin", C(160, 162, 166)), ("Hard Stop", C(120, 122, 126)),
    ("Load Cell", C(90, 92, 96)),

    ("Overhead Camera", C(30, 30, 32)), ("IR Camera Lens", C(15, 18, 26, 240)),
    ("IR Camera", C(30, 30, 32)), ("Fixed Overhead", C(30, 30, 32)),
    ("Probe Camera", C(30, 30, 32)), ("Camera Bracket", C(186, 189, 193)),
    ("Camera Mount", C(186, 189, 193)),

    ("Base Frame", C(76, 79, 83)),
    ("Instrument Deck", C(48, 50, 53)), ("Equipment Tray", C(48, 50, 53)),
    ("DUT Interface Bulkhead", C(48, 50, 53)), ("Vent Baffle", C(48, 50, 53)),
    ("Moving X Beam", C(186, 189, 193)), ("Rail Saddle", C(186, 189, 193)),
    ("Motor Mount", C(186, 189, 193)), ("Motor Plate", C(186, 189, 193)),
    ("Carriage Adapter", C(186, 189, 193)), ("Slide Plate", C(186, 189, 193)),
    ("Carriage Side Plate", C(186, 189, 193)),
    ("Probe Mount Arm", C(186, 189, 193)), ("Probe Head", C(186, 189, 193)),
    ("Cartridge Plate", C(186, 189, 193)), ("Cartridge Cradle", C(186, 189, 193)),
    ("Cartridge Park Rack", C(186, 189, 193)),
    ("Probe Interface Pad", C(120, 122, 126)),
    ("Probe Limit Tab", C(150, 152, 156)),
    ("PCB Fixture Plate", C(186, 189, 193)),
    ("Fixture Standoff", C(186, 189, 193)),
    ("Measurement Bay Standoff", C(150, 152, 156)),
    ("Adjustable Clamp", C(186, 189, 193)), ("Clamp Knob", C(30, 30, 32)),
    ("Vacuum Port", C(40, 40, 42)), ("Fastener", C(150, 152, 156)),
    ("Y Carriage", C(186, 189, 193)), ("Z Stage", C(186, 189, 193)),

    ("PicoScope", C(24, 82, 148)),
    ("Saleae", C(30, 30, 32)),
    ("Siglent", C(180, 182, 186)),
    ("Rigol", C(180, 182, 186)),
    ("Keithley", C(62, 66, 72)), ("DMM6500", C(62, 66, 72)),
    ("Joulescope", C(40, 42, 46)),
    ("LabJack", C(158, 44, 44)),
    ("MCC USB", C(64, 92, 142)),
    ("Industrial Control PC", C(40, 42, 46)),
    ("Galil", C(50, 52, 56)),
    ("Omron G9SE", C(240, 200, 50)),
    ("Mean Well", C(198, 200, 204)),
    ("DIN Rail", C(170, 172, 177)), ("DIN Ethernet", C(60, 62, 66)),
    ("Powered USB Hub", C(50, 52, 56)),
    ("Exhaust Fan", C(30, 30, 32)),
    ("Leveling Foot", C(25, 25, 27)),
    ("Chamber Light Bar", C(250, 250, 245)),
    ("Door Hinge", C(120, 122, 126)), ("Door Interlock", C(240, 200, 50)),
    ("Grounding Stud", C(160, 162, 166)),
    ("Calibration Fiducial", C(230, 231, 234)),
    ("Touch-Off", C(120, 122, 126)), ("Force Calibration", C(160, 162, 166)),
]

#: gusset profiles: corner (cx of arc center, cz), corner point, arc angles
GUSSETS = {
    "Window Corner Gusset TL": ((-315, 380), [
        line("gtl.l", -375 * M, 380 * M, -375 * M, 440 * M),
        line("gtl.t", -375 * M, 440 * M, -315 * M, 440 * M),
        arc("gtl.a", -315 * M, 380 * M, 60 * M, PI / 2, PI)]),
    "Window Corner Gusset TR": ((315, 380), [
        line("gtr.t", 315 * M, 440 * M, 375 * M, 440 * M),
        line("gtr.r", 375 * M, 440 * M, 375 * M, 380 * M),
        arc("gtr.a", 315 * M, 380 * M, 60 * M, 0, PI / 2)]),
    "Window Corner Gusset BL": ((-315, 140), [
        line("gbl.b", -375 * M, 80 * M, -315 * M, 80 * M),
        line("gbl.l", -375 * M, 140 * M, -375 * M, 80 * M),
        arc("gbl.a", -315 * M, 140 * M, 60 * M, PI, 3 * PI / 2)]),
    "Window Corner Gusset BR": ((315, 140), [
        line("gbr.b", 315 * M, 80 * M, 375 * M, 80 * M),
        line("gbr.r", 375 * M, 80 * M, 375 * M, 140 * M),
        arc("gbr.a", 315 * M, 140 * M, 60 * M, 3 * PI / 2, 2 * PI)]),
}
GUSSET_CENTERS = {"Window Corner Gusset TL": (-355, -453, 420),
                  "Window Corner Gusset TR": (355, -453, 420),
                  "Window Corner Gusset BL": (-355, -453, 100),
                  "Window Corner Gusset BR": (355, -453, 100)}


def cam(yaw_deg, pitch_deg, target, px):
    y, p = math.radians(yaw_deg), math.radians(pitch_deg)
    f = (math.sin(y) * math.cos(p), math.cos(y) * math.cos(p), math.sin(p))
    n = math.hypot(f[1], -f[0]) or 1.0
    r = (f[1] / n, -f[0] / n, 0.0)
    u = (r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2],
         r[0] * f[1] - r[1] * f[0])
    vals = []
    for row in [r, u, tuple(-c for c in f)]:
        t = -(row[0] * target[0] + row[1] * target[1] + row[2] * target[2])
        vals += list(row) + [t]
    return ",".join("{:.6f}".format(v) for v in vals), px


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)
    feats = fb.get_features()
    fnames = {f.get("name"): f.get("featureId") for f in feats["features"]}

    # ---- 1a. delete the glass fillet (square pane fills the aperture) -----
    if "ID - Window Corner Radii R60" in fnames:
        fb.delete_feature(fnames["ID - Window Corner Radii R60"])
        print("glass corner fillet deleted — pane is square again")
        time.sleep(2)
    else:
        print("fillet already gone")

    # fresh ids AFTER the deletion
    parts = {}
    for p in fb.c.list_parts(DID, WID, EID):
        if p.get("bodyType") != "composite":
            parts.setdefault(p["name"], []).append(p["partId"])

    # ---- 1b. corner gussets behind the glass ------------------------------
    if "ID3 - Window Corner Gussets" not in fnames:
        ents = []
        for name, (_c, geo) in GUSSETS.items():
            ents += geo
        sk = fb.add_sketch("ID3 - Window Corner Gussets Sketch", PLANE_FRONT,
                           ents)
        fb.add_extrude("ID3 - Window Corner Gussets", sk, 6, offset_mm=450)
        print("4 corner gussets built (Y -456..-450)")
        time.sleep(2)
    else:
        print("gussets already present")

    # ---- name + style the gussets -----------------------------------------
    parts2 = {}
    for p in fb.c.list_parts(DID, WID, EID):
        if p.get("bodyType") != "composite":
            parts2.setdefault(p["name"], []).append(p["partId"])
    boxes = fb.all_bboxes()
    items = []
    for n, pids in parts2.items():
        if not n.startswith("Part "):
            continue
        b = boxes.get(n)
        if not b:
            continue
        c = tuple((b["low" + d] + b["high" + d]) / 2 for d in "XYZ")
        for tgt, e in GUSSET_CENTERS.items():
            if all(abs(c[i] - e[i]) < 6.0 for i in range(3)):
                items.append({"partId": pids[0], "properties": [
                    {"propertyId": P_NAME, "value": tgt},
                    {"propertyId": P_PARTNO, "value": "EE-FAB-GLZ black PMMA"},
                    {"propertyId": P_APPEAR, "value": C(28, 28, 30)},
                    {"propertyId": P_EXCLUDE, "value": False},
                    {"propertyId": P_DESC, "value":
                     "Window aperture corner gusset R60, behind glass"}]})
                print("  named:", tgt)
                break

    # ---- 2. interior color pass -------------------------------------------
    painted = 0
    for name, pids in parts2.items():
        if name.startswith("Part "):
            continue
        app = 0
        for pat, a in COLOR_RULES:
            if pat in name:
                app = a
                break
        if app:
            for pid in pids:
                items.append({"partId": pid, "properties":
                              [{"propertyId": P_APPEAR, "value": app}]})
                painted += 1
    print("color rules matched {} bodies".format(painted))
    for i in range(0, len(items), 40):
        batch = items[i:i + 40]
        fb.c._request("POST", "/api/v6/metadata/d/{}/w/{}/e/{}".format(
            DID, WID, EID), json={"items": [
                {"href": "{}/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
                    BASE_URL, DID, WID, EID, quote(it["partId"], safe="")),
                 "properties": it["properties"]} for it in batch]})
        print("  metadata batch {}/{}".format(
            i // 40 + 1, (len(items) + 39) // 40), flush=True)
        time.sleep(1.5)

    # ---- 3. renders ---------------------------------------------------------
    disp_t = (0.213, -0.461, -0.115)
    brand_t = (-0.100, -0.461, -0.140)
    fix_t = (0.0, -0.05, 0.10)
    views = [
        ("id3_front", cam(0, 0, (0, 0, 0.09), 0.00105)),
        ("id3_hero", cam(-35, -14, (0, 0, 0.09), 0.00135)),
        ("id3_brand_lcd", cam(0, -3, brand_t, 0.00060)),
        ("id3_interior", cam(-25, -18, fix_t, 0.00075)),
    ]
    for name, (vm, px) in views:
        r = fb.c._request(
            "GET", "/api/v6/partstudios/d/{}/w/{}/e/{}/shadedviews".format(
                DID, WID, EID),
            params={"viewMatrix": vm, "outputHeight": 900, "outputWidth": 1200,
                    "pixelSize": px, "showAllParts": "true"})
        with open(SCRATCH + "/{}.png".format(name), "wb") as f:
            f.write(base64.b64decode(r["images"][0]))
        print("render:", name)

    ver = fb.c._request("POST", "/api/v6/documents/d/{}/versions".format(DID),
                        json={"name": "ID-PASS-3", "documentId": DID,
                              "workspaceId": WID,
                              "description": "Square glass + corner gussets, "
                              "real interior colors"})
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
    print("ID PASS 3 COMPLETE")


if __name__ == "__main__":
    main()
