"""Wiring corridor pass — harness routing reservations (2026-06-11).

Semi-transparent ANALYSIS BODIES only (no cuts): drag-chain envelopes for
the moving axes and two vertical harness trunks connecting the chamber to
the electronics bay. These are keep-out reservations for the EVT harness
build, sized for drag-chain-rated cable per the BOM, and they encode the
power/analog separation rule: motor power drops rear-right, instrument
analog drops front-left — maximum diagonal separation, never sharing a
corridor.

Bodies (audit whitelist: "Corridor - " prefix, opacity 70):
- Corridor - X Drag Chain: along the rear X rail, full X travel.
  X -300..300, Y 325..355, Z 85..130.
- Corridor - Y Drag Chain: beside the gantry bridge, moving span.
  X 130..160, Y -200..200, Z 130..160.
- Corridor - Z Service Loop: envelope over the existing probe cable loop
  links. X -90..-15, Y -105..-75, Z 145..230.
- Corridor - Motor Power Trunk: rear-right vertical drop, gantry to bay.
  X 330..370, Y 360..400, Z -280..100.
- Corridor - Analog Instrument Trunk: front-left vertical drop, probe/deck
  to bay (PicoScope/DMM side). X -370..-330, Y -400..-360, Z -280..80.

Units: sketch coords in METERS (M = 0.001); depth/offset in mm.
Top plane JDC: sketch (x,y) -> world (X,Y), extrude +Z, offset = start Z.
"""
import time
import warnings

warnings.filterwarnings("ignore")

import sys

sys.path.insert(0, "/Users/jackal-kahwati/EE-lab/tools/onshape")

from urllib.parse import quote

from features import FeatureBuilder, rounded_rect
from onshape_client import Client

M = 0.001

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"

PLANE_TOP = {"btType": "BTMParameterQueryList-148", "parameterId": "sketchPlane",
             "queries": [{"btType": "BTMIndividualQuery-138",
                          "deterministicIds": ["JDC"]}]}

APPEARANCE_PROP = "57f3fb8efa3416c06701d60c"

#: name, (x0, y0, x1, y1) mm, z_start mm, z_depth mm, (r, g, b)
CORRIDORS = [
    ("Corridor - X Drag Chain",
     (-300, 325, 300, 355), 85, 45, (230, 160, 40)),
    ("Corridor - Y Drag Chain",
     (130, -200, 160, 200), 130, 30, (230, 160, 40)),
    ("Corridor - Z Service Loop",
     (-90, -105, -15, -75), 145, 85, (60, 180, 170)),
    ("Corridor - Motor Power Trunk",
     (330, 360, 370, 400), -280, 380, (210, 70, 40)),
    ("Corridor - Analog Instrument Trunk",
     (-370, -400, -330, -360), -280, 360, (60, 120, 220)),
]

c = Client()
fb = FeatureBuilder(c, DID, WID, EID)

for name, (x0, y0, x1, y1), z0, dz, rgb in CORRIDORS:
    sk = fb.add_sketch("WC - {} Sketch".format(name), PLANE_TOP,
                       rounded_rect("cr", x0 * M, y0 * M, x1 * M, y1 * M, 4 * M))
    time.sleep(1.2)
    before = set(fb.parts())
    fb.add_extrude("WC - {} Extrude".format(name), sk, depth_mm=dz, offset_mm=z0)
    time.sleep(1.2)
    new = [p for p in fb.parts() if p not in before]
    for pid in new:
        fb.rename_part(pid, name)
        time.sleep(0.4)
        c._request("POST", "/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
            DID, WID, EID, quote(pid, safe="")),
            json={"properties": [{"propertyId": APPEARANCE_PROP,
                  "value": {"color": {"red": rgb[0], "green": rgb[1],
                                      "blue": rgb[2]}, "opacity": 70}}]})
        time.sleep(0.4)
    print(name, "done", flush=True)

print("WIRING CORRIDOR PASS COMPLETE", flush=True)
