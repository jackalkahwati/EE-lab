"""Phase B — hardware-expansion-spec CAD actions (2026-06-11).

Implements the five open items from hardware-expansion-spec.md:

1. IR CAMERA POCKET — FLIR Lepton 3.5 / PureThermal 3 stand-in hung below
   the overhead bracket center arm beside the vision camera (body X +/-10,
   Y 40..60, Z 292..304, O8 lens below), with a 2 mm locating pocket cut
   into the arm underside. Straight-down sightline, no glass in path (the
   smoked glass is the front face only).
2. CARTRIDGE PARK RACK — 3 stations on the deck, front-right, inside
   gantry reach (probe sweep X -280..280, Y -339..91): base plate
   X 80..240, Y -280..-240 on the deck top, three cradle blocks with
   22 mm park slots. NOTE: the probe head sweep intentionally reaches the
   rack (that is its purpose) — expected new hits in audit section 4.
3. DUT INTERFACE PANEL — bulkhead plate on the rear panel chamber face,
   rear-right corner (X 280..420, Z 20..150), fed from the plinth via the
   Motor Power Trunk corridor below; rear-panel cutout X 290..375,
   Z 30..140 (inset to keep the panel screw at X 385 on material); six
   connector stubs (USB-C, RJ45, 2x DB9 CAN/UART, 2x USB-A) on the face.
4. PLINTH RE-LAYOUT — envelope bodies for the expansion instruments in
   the electronics bay (Z -300..0). The initial placements below CLASHED
   with occupants outside the first survey (DIN-rail wall Y 260..385,
   Equipment Tray shelf Z -290..-287, Siglent SDL1030X e-load on the
   left, Industrial Control PC rear-right). Final packed positions after
   the repack transforms + DMM rebuild (footprint rotated long-in-X):
     DP832          X -155..84,   Y -165..253,  Z -287..-129
     DMM6500        X -410..-40,  Y -360..-273, Z -287..-199  (rebuilt)
     Joulescope     X -37..90,    Y -360..-233, Z -287..-254
     PicoScope      X 145..335,   Y 200..370,   Z -217..-177  (stacked on
                    the Industrial Control PC -- rack practice)
   Final bay packing check: zero non-mount clashes. Pre-existing mount
   contacts (DIN rail/devices, fan hubs, LabJack-USB hub sliver, Mean
   Well 1-SPD1305X 3 mm sliver) are tolerated as before.
5. IR SIGHTLINE CHECK — verifies the vertical column under the IR camera
   down to the fixture plate is clear of geometry.

Also in this session (prerequisite, separate feature): the undersized
Enclosure Base Pan (Y +/-400) was deleted and rebuilt flush to the
enclosure faces (X +/-470, Y +/-460, Z -302..-300), closing the bottom
gaps the same way the contoured top slab closed the top.

Units: sketch coords in METERS (M = 0.001); depth/offset params in mm.
"""
import time
import warnings

warnings.filterwarnings("ignore")

import sys

sys.path.insert(0, "/Users/jackal-kahwati/EE-lab/tools/onshape")

from urllib.parse import quote

from features import FeatureBuilder, circle, rounded_rect
from onshape_client import Client

M = 0.001

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"

PLANE_TOP = {"btType": "BTMParameterQueryList-148", "parameterId": "sketchPlane",
             "queries": [{"btType": "BTMIndividualQuery-138",
                          "deterministicIds": ["JDC"]}]}
PLANE_FRONT = {"btType": "BTMParameterQueryList-148", "parameterId": "sketchPlane",
               "queries": [{"btType": "BTMIndividualQuery-138",
                            "deterministicIds": ["JCC"]}]}

APPEARANCE_PROP = "57f3fb8efa3416c06701d60c"

c = Client()
fb = FeatureBuilder(c, DID, WID, EID)

def ids_by_name():
    return {name: pid for pid, name in fb.parts().items()}

def finish(pid, name, rgb, opacity=255):
    fb.rename_part(pid, name)
    time.sleep(0.4)
    c._request("POST", "/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
        DID, WID, EID, quote(pid, safe="")),
        json={"properties": [{"propertyId": APPEARANCE_PROP,
              "value": {"color": {"red": rgb[0], "green": rgb[1],
                                  "blue": rgb[2]}, "opacity": opacity}}]})
    time.sleep(0.4)

def new_named(before, names, rgb):
    new = [p for p in fb.parts() if p not in before]
    bb = fb.all_bboxes()
    pn = fb.parts()
    # sort new bodies by (x, y) center so names map deterministically
    new.sort(key=lambda p: (round((bb[pn[p]]["lowX"] + bb[pn[p]]["highX"]) / 2),
                            round((bb[pn[p]]["lowY"] + bb[pn[p]]["highY"]) / 2)))
    for pid, n in zip(new, names):
        finish(pid, n, rgb)
    return new

ids = ids_by_name()

# ---- B1: IR camera beside the vision camera --------------------------------
sk = fb.add_sketch("PB - IR Cam Pocket", PLANE_TOP,
                   rounded_rect("ip", -11 * M, 39 * M, 11 * M, 61 * M, 2 * M))
time.sleep(1.2)
fb.add_extrude_remove("PB - IR Cam Pocket Cut", sk, depth_mm=2, offset_mm=304,
                      scope_part_ids=[ids["Overhead Camera Bracket Center"]])
print("IR pocket cut", flush=True)
time.sleep(1.2)
sk = fb.add_sketch("PB - IR Cam Body", PLANE_TOP,
                   rounded_rect("ib", -10 * M, 40 * M, 10 * M, 60 * M, 2 * M))
time.sleep(1.2)
before = set(fb.parts())
fb.add_extrude("PB - IR Cam Body Extrude", sk, depth_mm=14, offset_mm=292)
time.sleep(1.2)
new_named(before, ["IR Camera (FLIR Lepton 3.5)"], (30, 30, 34))
sk = fb.add_sketch("PB - IR Cam Lens", PLANE_TOP, [circle("il", 0.0, 50 * M, 4 * M)])
time.sleep(1.2)
before = set(fb.parts())
fb.add_extrude("PB - IR Cam Lens Extrude", sk, depth_mm=4, offset_mm=288)
time.sleep(1.2)
new_named(before, ["IR Camera Lens"], (15, 15, 18))
print("IR camera done", flush=True)

# ---- B2: cartridge park rack (3 stations) -----------------------------------
sk = fb.add_sketch("PB - Park Rack Base", PLANE_TOP,
                   rounded_rect("rb", 80 * M, -280 * M, 240 * M, -240 * M, 4 * M))
time.sleep(1.2)
before = set(fb.parts())
fb.add_extrude("PB - Park Rack Base Extrude", sk, depth_mm=8, offset_mm=58)
time.sleep(1.2)
new_named(before, ["Cartridge Park Rack Base"], (70, 70, 75))

ents = []
for i, cx in enumerate((100, 160, 220)):
    ents += rounded_rect("cr{}".format(i), (cx - 15) * M, -275 * M,
                         (cx + 15) * M, -245 * M, 3 * M)
sk = fb.add_sketch("PB - Park Cradles", PLANE_TOP, ents)
time.sleep(1.2)
before = set(fb.parts())
fb.add_extrude("PB - Park Cradle Extrude", sk, depth_mm=24, offset_mm=66)
time.sleep(1.2)
cradles = new_named(before, ["Cartridge Cradle 1", "Cartridge Cradle 2",
                             "Cartridge Cradle 3"], (90, 90, 96))
ents = []
for i, cx in enumerate((100, 160, 220)):
    ents += rounded_rect("cs{}".format(i), (cx - 11) * M, -281 * M,
                         (cx + 11) * M, -239 * M, 2 * M)
sk = fb.add_sketch("PB - Park Slots", PLANE_TOP, ents)
time.sleep(1.2)
fb.add_extrude_remove("PB - Park Slots Cut", sk, depth_mm=16, offset_mm=74,
                      scope_part_ids=cradles)
print("park rack done", flush=True)
time.sleep(1.2)

# ---- B3: DUT interface panel -------------------------------------------------
ids = ids_by_name()
sk = fb.add_sketch("PB - DUT IF Cutout", PLANE_FRONT,
                   rounded_rect("dc", 290 * M, 30 * M, 375 * M, 140 * M, 8 * M))
time.sleep(1.2)
fb.add_extrude_remove("PB - DUT IF Cutout Cut", sk, depth_mm=15, offset_mm=450,
                      scope_part_ids=[ids["Rear Matte Black Panel"]],
                      opposite=True, offset_opposite=True)
print("DUT IF cutout cut", flush=True)
time.sleep(1.2)
sk = fb.add_sketch("PB - DUT IF Bulkhead", PLANE_FRONT,
                   rounded_rect("db", 280 * M, 20 * M, 420 * M, 150 * M, 6 * M))
time.sleep(1.2)
before = set(fb.parts())
fb.add_extrude("PB - DUT IF Bulkhead Extrude", sk, depth_mm=6, offset_mm=450,
               opposite=True, offset_opposite=True)
time.sleep(1.2)
new_named(before, ["DUT Interface Bulkhead"], (45, 45, 50))

ents = []
cols, rows = (300, 340, 380), (60, 105)
for j, cz in enumerate(rows):
    for i, cx in enumerate(cols):
        ents += rounded_rect("dcon{}{}".format(i, j), (cx - 9) * M, (cz - 5) * M,
                             (cx + 9) * M, (cz + 5) * M, 1.5 * M)
sk = fb.add_sketch("PB - DUT IF Connectors", PLANE_FRONT, ents)
time.sleep(1.2)
before = set(fb.parts())
fb.add_extrude("PB - DUT IF Connector Extrude", sk, depth_mm=6, offset_mm=444,
               opposite=True, offset_opposite=True)
time.sleep(1.2)
new_named(before, ["DUT IF - USB-C", "DUT IF - USB-A 1", "DUT IF - RJ45",
                   "DUT IF - DB9 CAN", "DUT IF - USB-A 2", "DUT IF - DB9 UART"],
          (20, 20, 24))
print("DUT interface panel done", flush=True)

# ---- B4: plinth instrument envelopes -----------------------------------------
BAY = [
    ("Instrument - Rigol DP832 Envelope", (-160, -60, 79, 358), -290, 158),
    ("Instrument - Keithley DMM6500 Envelope", (-400, -350, -187, 20), -290, 88),
    ("Instrument - Joulescope JS220 Envelope", (-120, -370, 7, -243), -290, 33),
]
for name, (x0, y0, x1, y1), z0, dz in BAY:
    sk = fb.add_sketch("PB - {} Sketch".format(name), PLANE_TOP,
                       rounded_rect("be", x0 * M, y0 * M, x1 * M, y1 * M, 6 * M))
    time.sleep(1.2)
    before = set(fb.parts())
    fb.add_extrude("PB - {} Extrude".format(name), sk, depth_mm=dz,
                   offset_mm=abs(z0), offset_opposite=True)
    time.sleep(1.2)
    new_named(before, [name], (200, 160, 60))
    print(name, "placed", flush=True)

# ---- B4 verification: bay packing check --------------------------------------
bb = fb.all_bboxes()
bay_bodies = {n: b for n, b in bb.items()
              if b["highZ"] <= 5 and b["lowZ"] >= -300 and "Corridor" not in n
              and not n.startswith(("Plinth", "Rear", "Side Shell", "Trim",
                                    "Enclosure", "Leveling"))}
def overlaps(a, b, tol=0.5):
    return all(a["low" + d] < b["high" + d] - tol and
               a["high" + d] > b["low" + d] + tol for d in "XYZ")
names = sorted(bay_bodies)
clashes = []
for i, a in enumerate(names):
    for b2 in names[i + 1:]:
        if overlaps(bay_bodies[a], bay_bodies[b2]):
            clashes.append((a, b2))
print("bay packing clashes:", clashes if clashes else "NONE")

# ---- B5: IR sightline check ---------------------------------------------------
col = {"lowX": -10, "highX": 10, "lowY": 40, "highY": 60, "lowZ": 60, "highZ": 288}
blockers = [n for n, b in bb.items() if overlaps(b, col, tol=0.1)]
print("IR sightline blockers (expect none):", blockers if blockers else "CLEAR")
print("(front glass not in path: IR looks straight down, glass is the front face)")

print("PHASE B COMPLETE", flush=True)
