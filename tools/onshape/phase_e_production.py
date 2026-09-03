"""Phase E — production-readiness pass (2026-07-03).

Closes the production-level gaps found by the full design re-review
(see docs in cad/electronics-bringup-station/production-readiness-report.md):

1. AXIAL FLOAT — X and Z motor shafts butt hard against their screw
   journals (evDistance 0.000 mm; Y already has 2 mm). Jaw couplings need
   shaft-end float. Fix: shorten each journal (EE-FAB-JNL, custom part)
   2 mm at the coupling end via a REMOVE cut scoped to the journal only.
2. E-STOP — the machine had NO emergency stop body. Adds a panel-mount
   mushroom E-stop (IDEC XW1E class: bezel O60, stem O22, cap O45) on the
   right shell front face at Z=+300 (~600 mm above bench plane, D4.2
   target), with the O22 panel hole cut through the shell wall.
3. DOOR HARDWARE — the front smoked glass had no access hardware. Adds
   two concealed-hinge bodies on the left edge and a guard-lock interlock
   switch (Omron D4NS class, doubles as latch) + striker on the right,
   making the glass an interlocked access door (D3.2/D4.2).
4. GROUNDING — 4x M5 grounding studs (D4.2): two on the base pan floor
   (front corners, clear of the equipment tray), one on the base frame
   top rear-left, one on the rear panel inner face.
5. CALIBRATION ASSETS (D2.5) — fiducial target plate 40x40x3 and probe
   touch-off pad O16x3 (one extrude) + force-calibration post O12x15 on
   the fixture plate, all inside the probe sweep (X +/-280, Y -339..91).
6. METADATA — names/PN/vendor/material for every new body, plus material
   assignments for the 18 straggler display/branding parts phase C
   predates (Touch Display Bezel = 6061 etc.).
7. RELEASE — re-verify (evDistance, bboxes, mass properties), create
   Version PROD-PASS-1, export Part_Studio_1_v6.step.

Idempotent: every build block is skipped if its part name already exists;
the journal cuts are skipped if the journal is already short. Scoped cuts
that land in a non-OK state are deleted immediately.

Front-plane convention (README): plain extrude spans [-offset-depth,
-offset] in Y; both opposite flags -> [offset, offset+depth] in +Y. The
script verifies each front-plane body's Y span afterward and applies a
corrective translate if a body landed mirrored.
"""

from __future__ import annotations

import json
import os
import time
import warnings

warnings.filterwarnings("ignore")

from urllib.parse import quote

import requests

from features import FeatureBuilder, circle, rect
from onshape_client import Client, BASE_URL

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"

SCRATCH = os.environ.get("SCRATCH", "/tmp")
STEP_OUT = os.path.join(os.path.dirname(__file__), "..", "..",
                        "cad", "electronics-bringup-station",
                        "Part_Studio_1_v6.step")

P_NAME = "57f3fb8efa3416c06701d60d"
P_DESC = "57f3fb8efa3416c06701d60e"
P_PARTNO = "57f3fb8efa3416c06701d60f"
P_VENDOR = "57f3fb8efa3416c06701d612"
P_MATERIAL = "57f3fb8efa3416c06701d615"
P_EXCLUDE = "57f3fb8efa3416c06701d61e"

PLANE_TOP = {"btType": "BTMParameterQueryList-148", "parameterId": "sketchPlane",
             "queries": [{"btType": "BTMIndividualQuery-138",
                          "deterministicIds": ["JDC"]}]}
PLANE_FRONT = {"btType": "BTMParameterQueryList-148", "parameterId": "sketchPlane",
               "queries": [{"btType": "BTMIndividualQuery-138",
                            "deterministicIds": ["JCC"]}]}


def mat(display, dens):
    return {"id": display, "displayName": display, "libraryName": "EE-lab Materials",
            "properties": [{"name": "DENS", "value": float(dens), "type": "REAL",
                            "units": "kg/m^3", "category": "PHYSICAL",
                            "description": "density", "displayName": "Density"}]}


AL6061 = mat("Aluminum 6061-T6", 2700)
STEEL = mat("Steel, alloy", 7850)
SS = mat("Stainless 303", 8000)
ABS = mat("ABS / PC", 1060)
ELEC = mat("Electronics assembly (envelope)", 1500)

#: expected new bodies: name -> (center xyz mm, vendor, pn, material, desc)
NEW_PARTS = {
    "E-Stop Bezel": ((470, -464, 300), "IDEC", "XW1E-BV411MR", ABS,
                     "E-stop panel bezel, O60, right shell front, Z+300"),
    "E-Stop Stem": ((470, -473, 300), "IDEC", "XW1E-BV411MR", ABS,
                    "E-stop switch stem, O22 panel mount"),
    "E-Stop Button Cap": ((470, -484, 300), "IDEC", "XW1E-BV411MR", ABS,
                          "E-stop mushroom cap O45, red"),
    "Door Hinge Lower": ((-385, -444, 155), "Sugatsune", "HES3D-90BL", STEEL,
                         "Concealed hinge, glass access door, lower"),
    "Door Hinge Upper": ((-385, -444, 365), "Sugatsune", "HES3D-90BL", STEEL,
                         "Concealed hinge, glass access door, upper"),
    "Door Interlock Switch": ((382.5, -442.5, 247.5), "Omron", "D4NS-4CF", ELEC,
                              "Guard-lock safety interlock switch (also door latch)"),
    "Door Interlock Striker": ((362, -452.5, 246), "Omron", "D4DS-K3", STEEL,
                               "Interlock operation key on door leaf"),
    "Grounding Stud Plinth Right": ((380, -380, -294), "Hardware",
                                    "M5x12 ground stud DIN 46234", SS,
                                    "PE bonding stud, base pan front-right"),
    "Grounding Stud Plinth Left": ((-380, -380, -294), "Hardware",
                                   "M5x12 ground stud DIN 46234", SS,
                                   "PE bonding stud, base pan front-left"),
    "Grounding Stud Frame": ((-350, 300, 86), "Hardware",
                             "M5x12 ground stud DIN 46234", SS,
                             "PE bonding stud, base frame rear-left"),
    "Grounding Stud Rear Panel": ((-350, 450, -250), "Hardware",
                                  "M5x12 ground stud DIN 46234", SS,
                                  "PE bonding stud, rear panel inner face"),
    "Calibration Fiducial Target": ((-220, -140, 59.5), "FAB - machine",
                                    "EE-CAL-FID", AL6061,
                                    "Camera calibration target plate 40x40x3, fixture front-left"),
    "Probe Touch-Off Pad": ((-220, 60, 59.5), "FAB - machine", "EE-CAL-TOP", STEEL,
                            "Probe Z-reference touch-off pad O16, hardened"),
    "Force Calibration Post": ((200, 60, 65.5), "FAB - machine", "EE-CAL-FCP", SS,
                               "Probe force calibration reference post O12x15"),
}

#: phase-C stragglers -> material
STRAGGLERS = dict(
    [("Touch Display Bezel", AL6061), ("Touch Display 10.1in", ELEC),
     ("Display UI Layer", ABS), ("Display Status Bar", ABS)] +
    [("Wordmark Glyph {:02d}".format(i), ABS) for i in range(1, 15)])


def remove_extrude(fb, name, sketch_fid, depth_mm, offset_mm, scope_pids):
    """Scoped REMOVE returning (featureId, state); deletes the feature if
    it lands in a non-OK state."""
    params = [
        {"btType": "BTMParameterEnum-145", "parameterId": "bodyType",
         "value": "SOLID", "enumName": "ExtendedToolBodyType"},
        {"btType": "BTMParameterEnum-145", "parameterId": "operationType",
         "value": "REMOVE", "enumName": "NewBodyOperationType"},
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
        {"btType": "BTMParameterQuantity-147", "parameterId": "startOffsetDistance",
         "expression": "{} mm".format(abs(offset_mm))},
        {"btType": "BTMParameterBoolean-144",
         "parameterId": "startOffsetOppositeDirection",
         "value": offset_mm < 0},
    ]
    resp = fb.c._request("POST", fb._base + "/features", json={"feature": {
        "btType": "BTMFeature-134", "featureType": "extrude", "name": name,
        "parameters": params}})
    fid = (resp.get("feature") or {}).get("featureId")
    state = (resp.get("featureState") or {}).get("featureStatus", "?")
    if state not in ("OK", "?"):
        print("  !! {} landed {}: deleting feature".format(name, state))
        if fid:
            fb.delete_feature(fid)
        return None, state
    return fid, state


DIST_SCRIPT_TMPL = """
function(context is Context, queries is map)
{
    var names = %s;
    var out = [];
    for (var pair in names)
    {
        var qa = qNothing();
        var qb = qNothing();
        for (var body in evaluateQuery(context, qBodyType(qEverything(EntityType.BODY), BodyType.SOLID)))
        {
            var nm = getProperty(context, {"entity": body, "propertyType": PropertyType.NAME});
            if (nm == pair[0]) { qa = body; }
            if (nm == pair[1]) { qb = body; }
        }
        try
        {
            var d = evDistance(context, {"side0": qa, "side1": qb});
            out = append(out, {"a": pair[0], "b": pair[1], "mm": d.distance / millimeter});
        }
        catch (e)
        {
            out = append(out, {"a": pair[0], "b": pair[1], "mm": -999});
        }
    }
    return out;
}
"""


def decode(v):
    if isinstance(v, dict):
        if "message" in v:
            return decode(v["message"])
        if "key" in v:
            return (decode(v["key"]), decode(v.get("value")))
        if "value" in v:
            return decode(v["value"])
        return v
    if isinstance(v, list):
        items = [decode(i) for i in v]
        if items and all(isinstance(i, tuple) and len(i) == 2 for i in items):
            return dict(items)
        return items
    return v


def distances(fb, pairs):
    pairs_fs = "[" + ", ".join('["{}", "{}"]'.format(a, b) for a, b in pairs) + "]"
    resp = fb.c._request("POST", fb._base + "/featurescript",
                         json={"script": DIST_SCRIPT_TMPL % pairs_fs,
                               "queries": {}})
    return decode(resp.get("result")) or []


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)
    parts = {p["name"]: p["partId"]
             for p in fb.c.list_parts(DID, WID, EID)
             if p.get("bodyType") != "composite"}
    boxes = fb.all_bboxes()

    # ---- 1. journal axial-float cuts -----------------------------------
    print("=== 1. shaft/journal axial float ===")
    jx = boxes.get("X Axis - Screw Journal", {})
    if jx.get("highX", 0) > 359:
        sk = fb.add_sketch("PROD - X Journal Trim Sketch", PLANE_TOP,
                           rect("xjt", 0.358, -0.263, 0.366, -0.251))
        fid, st = remove_extrude(fb, "PROD - X Journal Trim", sk, 22, 85,
                                 [parts["X Axis - Screw Journal"]])
        print("  X journal trim:", st)
        time.sleep(2)
    else:
        print("  X journal already trimmed (highX {:.1f})".format(jx.get("highX", 0)))
    jz = boxes.get("Z Axis - Screw Journal", {})
    if jz.get("highZ", 0) > 307:
        sk = fb.add_sketch("PROD - Z Journal Trim Sketch", PLANE_TOP,
                           rect("zjt", 0.094, -0.005, 0.104, 0.005))
        fid, st = remove_extrude(fb, "PROD - Z Journal Trim", sk, 8, 306,
                                 [parts["Z Axis - Screw Journal"]])
        print("  Z journal trim:", st)
        time.sleep(2)
    else:
        print("  Z journal already trimmed (highZ {:.1f})".format(jz.get("highZ", 0)))

    # ---- 2. E-stop ------------------------------------------------------
    print("=== 2. E-stop (right shell front, Z+300) ===")
    if "E-Stop Button Cap" not in parts:
        # panel hole O22 through the shell front wall
        sk = fb.add_sketch("PROD - EStop Panel Hole Sketch", PLANE_FRONT,
                           [circle("eshole", 0.470, 0.300, 0.011)])
        fid, st = remove_extrude(fb, "PROD - EStop Panel Hole", sk, 12, 450,
                                 [parts["Side Shell Right"]])
        print("  panel hole O22:", st)
        time.sleep(2)
        for nm, r, off, dep in [("Bezel", 0.030, 460, 8),
                                ("Stem", 0.011, 468, 10),
                                ("Button Cap", 0.0225, 478, 12)]:
            sk = fb.add_sketch("PROD - EStop {} Sketch".format(nm), PLANE_FRONT,
                               [circle("es" + nm[:3].lower(), 0.470, 0.300, r)])
            fb.add_extrude("PROD - EStop {}".format(nm), sk, dep, offset_mm=off)
            print("  E-Stop {} built".format(nm))
            time.sleep(2)
    else:
        print("  E-stop already present")

    # ---- 3. door hardware ------------------------------------------------
    print("=== 3. glass door hardware ===")
    if "Door Hinge Upper" not in parts:
        sk = fb.add_sketch("PROD - Door Hinge Sketch", PLANE_TOP,
                           rect("dhg", -0.393, -0.450, -0.377, -0.438))
        fb.add_extrude("PROD - Door Hinge Lower", sk, 30, offset_mm=140)
        time.sleep(2)
        fb.add_extrude("PROD - Door Hinge Upper", sk, 30, offset_mm=350)
        time.sleep(2)
        sk = fb.add_sketch("PROD - Interlock Switch Sketch", PLANE_TOP,
                           rect("ilk", 0.370, -0.450, 0.395, -0.435))
        fb.add_extrude("PROD - Interlock Switch", sk, 15, offset_mm=240)
        time.sleep(2)
        sk = fb.add_sketch("PROD - Interlock Striker Sketch", PLANE_TOP,
                           rect("ilkstr", 0.355, -0.456, 0.369, -0.449))
        fb.add_extrude("PROD - Interlock Striker", sk, 8, offset_mm=242)
        print("  hinges x2, interlock switch, striker built")
        time.sleep(2)
    else:
        print("  door hardware already present")

    # ---- 4. grounding studs ---------------------------------------------
    print("=== 4. grounding studs ===")
    if "Grounding Stud Frame" not in parts:
        sk = fb.add_sketch("PROD - Pan Ground Studs Sketch", PLANE_TOP,
                           [circle("gnd1", 0.380, -0.380, 0.0025),
                            circle("gnd2", -0.380, -0.380, 0.0025)])
        fb.add_extrude("PROD - Pan Ground Studs", sk, 12, offset_mm=-300,
                       offset_opposite=True)
        time.sleep(2)
        sk = fb.add_sketch("PROD - Frame Ground Stud Sketch", PLANE_TOP,
                           [circle("gnd3", -0.350, 0.300, 0.0025)])
        fb.add_extrude("PROD - Frame Ground Stud", sk, 12, offset_mm=80)
        time.sleep(2)
        sk = fb.add_sketch("PROD - Rear Ground Stud Sketch", PLANE_FRONT,
                           [circle("gnd4", -0.350, -0.250, 0.0025)])
        fb.add_extrude("PROD - Rear Ground Stud", sk, 12, offset_mm=444,
                       opposite=True, offset_opposite=True)
        print("  4 studs built")
        time.sleep(2)
    else:
        print("  grounding studs already present")

    # ---- 5. calibration assets ------------------------------------------
    print("=== 5. calibration assets ===")
    if "Force Calibration Post" not in parts:
        sk = fb.add_sketch("PROD - Cal Targets Sketch", PLANE_TOP,
                           rect("fid", -0.240, -0.160, -0.200, -0.120) +
                           [circle("top", -0.220, 0.060, 0.008)])
        fb.add_extrude("PROD - Cal Targets", sk, 3, offset_mm=58)
        time.sleep(2)
        sk = fb.add_sketch("PROD - Force Cal Post Sketch", PLANE_TOP,
                           [circle("fcp", 0.200, 0.060, 0.006)])
        fb.add_extrude("PROD - Force Cal Post", sk, 15, offset_mm=58)
        print("  fiducial + touch-off + force post built")
        time.sleep(2)
    else:
        print("  calibration assets already present")

    # ---- 6. name + verify positions (mirror auto-correct) ----------------
    print("=== 6. naming + front-plane mirror check ===")
    parts2 = {}
    for p in fb.c.list_parts(DID, WID, EID):
        if p.get("bodyType") != "composite":
            parts2.setdefault(p["name"], p["partId"])
    boxes2 = fb.all_bboxes()

    generic = {n: pid for n, pid in parts2.items() if n.startswith("Part ")}
    print("  unnamed new bodies:", len(generic))

    def center(b):
        return tuple((b["low" + d] + b["high" + d]) / 2 for d in "XYZ")

    # match unnamed bodies to expected placements (allow Y-mirrored)
    assign = {}   # partId -> (target name, needs_mirror_fix dy)
    for n, pid in generic.items():
        if n not in boxes2:
            continue
        c = center(boxes2[n])
        for tgt, (exp, *_rest) in NEW_PARTS.items():
            if tgt in assign.values():
                pass
            for mirror in (False, True):
                e = (exp[0], -exp[1] if mirror else exp[1], exp[2])
                if all(abs(c[i] - e[i]) < 5.0 for i in range(3)):
                    dy = (exp[1] - c[1]) if mirror else 0.0
                    assign[pid] = (tgt, dy, n)
                    break
            if pid in assign:
                break
    matched = {v[0] for v in assign.values()}
    print("  matched {} / {} expected".format(len(matched), len(NEW_PARTS)))
    for tgt in NEW_PARTS:
        if tgt not in matched and tgt not in parts2:
            print("  !! UNMATCHED expected body:", tgt)

    # corrective transforms for mirrored front-plane bodies
    fixes = {}
    for pid, (tgt, dy, n) in assign.items():
        if abs(dy) > 0.5:
            fixes.setdefault(round(dy, 1), []).append(pid)
            print("  mirror fix {}: dy={:.1f}".format(tgt, dy))
    for dy, pids in fixes.items():
        fb.transform_translate(pids, 0, dy, 0, name="PROD - Mirror Fix")
        time.sleep(2)

    # bulk metadata: names/vendor/pn/material/desc for new, materials for stragglers
    items = []
    for pid, (tgt, dy, n) in assign.items():
        exp, vendor, pn, m, desc = NEW_PARTS[tgt]
        items.append({"partId": pid, "properties": [
            {"propertyId": P_NAME, "value": tgt},
            {"propertyId": P_PARTNO, "value": pn},
            {"propertyId": P_VENDOR, "value": vendor},
            {"propertyId": P_MATERIAL, "value": m},
            {"propertyId": P_DESC, "value": desc},
            {"propertyId": P_EXCLUDE, "value": False},
        ]})
    for name, m in STRAGGLERS.items():
        if name in parts2:
            items.append({"partId": parts2[name], "properties": [
                {"propertyId": P_MATERIAL, "value": m}]})
    for i in range(0, len(items), 40):
        batch = items[i:i + 40]
        fb.c._request("POST", "/api/v6/metadata/d/{}/w/{}/e/{}".format(DID, WID, EID),
                      json={"items": [
                          {"href": "{}/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
                              BASE_URL, DID, WID, EID, quote(it["partId"], safe="")),
                           "properties": it["properties"]} for it in batch]})
        print("  metadata batch {}-{} applied".format(i, i + len(batch) - 1))
        time.sleep(1.5)

    # ---- 7. verification --------------------------------------------------
    print("=== 7. verification ===")
    rows = distances(fb, [
        ("X Axis - Motor Shaft", "X Axis - Screw Journal"),
        ("Z Axis - Motor Shaft", "Z Axis - Screw Journal"),
        ("X Axis - Ballnut Flange", "X Axis - Rail Saddle Front"),
    ])
    for row in rows:
        if isinstance(row, dict):
            print("  {:.3f} mm  {} <-> {}".format(row["mm"], row["a"], row["b"]))

    boxes3 = fb.all_bboxes()
    with open(SCRATCH + "/phase_e_bboxes.json", "w") as f:
        json.dump(boxes3, f, indent=1)

    def overlaps(a, b, tol=0.01):
        return all(a["low" + d] < b["high" + d] - tol and
                   a["high" + d] > b["low" + d] + tol for d in "XYZ")

    print("  new-body overlap scan vs whole studio:")
    clean = True
    for tgt in NEW_PARTS:
        if tgt not in boxes3:
            print("   !! missing:", tgt)
            clean = False
            continue
        for other, ob in boxes3.items():
            if other == tgt or other.startswith(("Corridor - ", "ASM - ", "Analysis")):
                continue
            if overlaps(boxes3[tgt], ob):
                print("   OVERLAP: {} <-> {}".format(tgt, other))
                clean = False
    if clean:
        print("   CLEAN — no new interference")

    mp = fb.c._request("GET",
                       "/api/v6/partstudios/d/{}/w/{}/e/{}/massproperties".format(
                           DID, WID, EID), params={"massAsGroup": "true"})
    grp = mp.get("bodies", {}).get("-all-") or next(iter(mp.get("bodies", {}).values()), {})
    mass = grp.get("mass", [None])[0]
    cg = grp.get("centroid", [0, 0, 0])[:3]
    print("  total mass {:.2f} kg, CoG X={:.1f} Y={:.1f} Z={:.1f} mm".format(
        mass, cg[0] * 1000, cg[1] * 1000, cg[2] * 1000))
    with open(SCRATCH + "/phase_e_massprops.json", "w") as f:
        json.dump(mp, f, indent=1)

    # ---- 8. version + STEP export ----------------------------------------
    print("=== 8. release ===")
    ver = fb.c._request("POST", "/api/v6/documents/d/{}/versions".format(DID),
                        json={"name": "PROD-PASS-1", "documentId": DID,
                              "workspaceId": WID,
                              "description": "Phase E production-readiness pass"})
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
            fid = (st.get("resultExternalDataIds") or [None])[0]
            url = "{}/api/v6/documents/d/{}/externaldata/{}".format(
                BASE_URL, DID, fid)
            r = requests.get(url, auth=fb.c._auth, timeout=120)
            r.raise_for_status()
            with open(os.path.abspath(STEP_OUT), "wb") as f:
                f.write(r.content)
            print("  STEP exported:", os.path.abspath(STEP_OUT),
                  "({:.1f} MB)".format(len(r.content) / 1e6))
            break
        if st.get("requestState") == "FAILED":
            print("  !! STEP translation FAILED:", st.get("failureReason"))
            break
    print("PHASE E COMPLETE")


if __name__ == "__main__":
    main()
