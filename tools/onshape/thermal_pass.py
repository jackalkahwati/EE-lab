"""Thermal pass — implements thermal-analysis.md recommendations (2026-06-11).

1. LOW INTAKE VENTS — 200 O6 holes per side (16 mm grid, 25 cols x 8 rows,
   Y -420..-36, Z -276..-164) through BOTH side shells at electronics-bay
   level (the bay is Z -300..0; the existing O5 fields at Z 240..420 are
   chamber relief, not the cooling path). Total intake 113 cm2 keeps
   60 CFM under 2.5 m/s face velocity.
2. FAN CUTOUTS — 2x 120 mm fan openings (O116 + 4x O4.5 mounts on a
   105 mm square) in the Rear Matte Black Panel, centers (+/-220, Z -75),
   high in the electronics bay. Clears the vent baffle (X +/-160), RJ45 /
   USB-C (X -310..-290) and panel screws (X +/-385, X 0).
3. FAN BODIES — placeholder 120x120x25 fan frames (R8 corners) with O112
   face pocket + O36 hub behind the cutouts, named/colored, so the BOM
   intent (ebm-papst/Delta 120 mm filtered exhaust pair) reads in the model.

Coordinate conventions (probed 2026-06-11 with throwaway bodies):
- Sketch entity geometry is in METERS (Onshape internal SI). Depth/offset
  feature parameters are expression strings in mm. Passing mm sketch coords
  puts geometry hundreds of meters away: scoped REMOVE cuts then land in
  benign-looking INFO state and cut NOTHING, THROUGH_ALL cuts ERROR.
- Right plane "JEC": sketch (x,y) -> world (Y, Z), extrude +X.
- Front plane "JCC": sketch (x,y) -> world (X, Z), extrude -Y;
  opposite=True + offset_opposite=True -> span [offset, offset+depth] in +Y.

Residue from the first (mm-unit) run was deleted 2026-06-11 in the
pro-owned document copy (along with the errored 'EVT - Rear Top Cut'
features) once GET /features came back under the new account's quota.
"""
import time
import warnings

warnings.filterwarnings("ignore")

import sys

sys.path.insert(0, "/Users/jackal-kahwati/EE-lab/tools/onshape")

from features import FeatureBuilder, circle, rounded_rect
from onshape_client import Client

M = 0.001  # mm -> sketch meters

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"

PLANE_FRONT = {"btType": "BTMParameterQueryList-148", "parameterId": "sketchPlane",
               "queries": [{"btType": "BTMIndividualQuery-138",
                            "deterministicIds": ["JCC"]}]}
PLANE_RIGHT = {"btType": "BTMParameterQueryList-148", "parameterId": "sketchPlane",
               "queries": [{"btType": "BTMIndividualQuery-138",
                            "deterministicIds": ["JEC"]}]}

APPEARANCE_PROP = "57f3fb8efa3416c06701d60c"

c = Client()
fb = FeatureBuilder(c, DID, WID, EID)

ids_by_name = {name: pid for pid, name in fb.parts().items()}
shells = [ids_by_name["Side Shell Left"], ids_by_name["Side Shell Right"]]
rear_panel = [ids_by_name["Rear Matte Black Panel"]]

# ---- 1. low intake vent fields (both shells, one symmetric feature) --------
ents = []
for col in range(25):
    for row in range(8):
        y = (-420.0 + 16.0 * col) * M    # world Y (front-biased band)
        z = (-276.0 + 16.0 * row) * M    # world Z (electronics bay)
        ents.append(circle("iv{}x{}".format(col, row), y, z, 3.0 * M))  # O6
sk = fb.add_sketch("Thermal - Intake Vent Holes v2", PLANE_RIGHT, ents)
print("intake sketch:", sk, "({} holes)".format(len(ents)), flush=True)
time.sleep(1.5)
fb.add_extrude_remove("Thermal - Intake Vents Cut v2", sk, depth_mm=1020,
                      offset_mm=None, scope_part_ids=shells, symmetric=True)
print("intake vents cut through both shells", flush=True)
time.sleep(1.5)

# ---- 2. fan cutouts in rear panel (span Y 450..465) ------------------------
ents = []
for i, cx in enumerate((-220.0, 220.0)):
    ents.append(circle("fc{}".format(i), cx * M, -75.0 * M, 58.0 * M))  # O116
    for j, (mx, mz) in enumerate(((-52.5, -52.5), (52.5, -52.5),
                                  (-52.5, 52.5), (52.5, 52.5))):
        ents.append(circle("fm{}x{}".format(i, j),
                           (cx + mx) * M, (-75.0 + mz) * M, 2.25 * M))
sk = fb.add_sketch("Thermal - Fan Cutouts", PLANE_FRONT, ents)
print("fan cutout sketch:", sk, flush=True)
time.sleep(1.5)
fb.add_extrude_remove("Thermal - Fan Cutouts Cut", sk, depth_mm=15,
                      offset_mm=450, scope_part_ids=rear_panel,
                      opposite=True, offset_opposite=True)
print("fan cutouts cut in rear panel", flush=True)
time.sleep(1.5)

# ---- 3. fan body placeholders (span Y 430..455) -----------------------------
ents = []
for i, cx in enumerate((-220.0, 220.0)):
    ents += rounded_rect("fb{}".format(i), (cx - 60) * M, -135.0 * M,
                         (cx + 60) * M, -15.0 * M, 8.0 * M)
sk_body = fb.add_sketch("Thermal - Fan Bodies", PLANE_FRONT, ents)
time.sleep(1.5)
before = set(fb.parts())
fb.add_extrude("Thermal - Fan Body Extrude", sk_body, depth_mm=25,
               offset_mm=430, offset_opposite=True, opposite=True)
print("fan bodies extruded", flush=True)
time.sleep(1.5)
body_ids = [p for p in fb.parts() if p not in before]

# face pocket: remove Y 435..455, leaving a 5 mm back wall at 430..435
ents = [circle("fp{}".format(i), cx * M, -75.0 * M, 56.0 * M)
        for i, cx in enumerate((-220.0, 220.0))]
sk = fb.add_sketch("Thermal - Fan Face Pockets", PLANE_FRONT, ents)
time.sleep(1.5)
fb.add_extrude_remove("Thermal - Fan Face Pocket Cut", sk, depth_mm=20,
                      offset_mm=435, scope_part_ids=body_ids,
                      opposite=True, offset_opposite=True)
print("fan face pockets cut", flush=True)
time.sleep(1.5)

# hub: O36 disc, Y 435..447, floating on the 5 mm back wall
ents = [circle("fh{}".format(i), cx * M, -75.0 * M, 18.0 * M)
        for i, cx in enumerate((-220.0, 220.0))]
sk = fb.add_sketch("Thermal - Fan Hubs", PLANE_FRONT, ents)
time.sleep(1.5)
before = set(fb.parts())
fb.add_extrude("Thermal - Fan Hub Extrude", sk, depth_mm=12,
               offset_mm=435, offset_opposite=True, opposite=True)
print("fan hubs extruded", flush=True)
time.sleep(1.5)
hub_ids = [p for p in fb.parts() if p not in before]

# ---- 4. names + appearance ---------------------------------------------------
from urllib.parse import quote

def finish(pid, name, rgb):
    fb.rename_part(pid, name)
    time.sleep(0.5)
    c._request("POST", "/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
        DID, WID, EID, quote(pid, safe="")),
        json={"properties": [{"propertyId": APPEARANCE_PROP,
              "value": {"color": {"red": rgb[0], "green": rgb[1],
                                  "blue": rgb[2]}, "opacity": 255}}]})
    time.sleep(0.5)

bb = fb.all_bboxes()
names = fb.parts()
for pid in body_ids:
    side = "Left" if bb.get(names[pid], {}).get("lowX", 0) < 0 else "Right"
    finish(pid, "Exhaust Fan 120mm {}".format(side), (25, 25, 28))
for pid in hub_ids:
    side = "Left" if bb.get(names[pid], {}).get("lowX", 0) < 0 else "Right"
    finish(pid, "Exhaust Fan Hub {}".format(side), (55, 55, 60))

for pid in body_ids + hub_ids:
    b = bb[names[pid]]
    print("{}: X {:.0f}..{:.0f} Y {:.0f}..{:.0f} Z {:.0f}..{:.0f}".format(
        names[pid], b["lowX"], b["highX"], b["lowY"], b["highY"],
        b["lowZ"], b["highZ"]), flush=True)

print("THERMAL PASS COMPLETE", flush=True)
