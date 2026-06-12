"""CAD Pass EVT-2 — probe head + fixture engineering (2026-06-11).

Resolves v4 review items 3, 4, 9 (evt-roadmap.md):

FIXTURE STACK (kills the 57% plate/deck intersection):
- Deck cutout X/Y +/-266/216 R10 scoped to the Instrument Deck: the plate
  (Z 40..58) no longer pierces the 3 mm deck sheet (Z 55..58).
- 4x O16 standoffs (Z 0..40) at (+/-230, +/-180) carry the plate.
- 4x O12 vacuum port bosses under the plate at (+/-120, +/-80), Z 32..40.
- PicoScope 5444D relocated out of the fixture intrusion zone (it overlapped
  the plate Z 40..53) down to the service bay beside the Siglent/MCC:
  transform (+450, +285, -300) -> X 100..290, Y 200..370, Z -287..-247.

PROBE COMPLIANCE MECHANISM (preload, compliant travel, anti-rotation,
hard stop as real mechanics):
- Probe Mount Arm: 12 mm plate Z 124..136, X -34..75, Y -143..-28 — finally
  connects the Z slide plate (face X=75) to the probe head stack. Clears
  the MGN12 front rail by 2 mm (arm Y max -28 vs rail Y -26), limit
  switches pass beside it.
- 2x O5 guide pins (+/-24, -124) Z 106..140: press-fit in the head top
  (106..110), sliding through O5.5 bores cut in the camera bezel + arm.
  Two pins = anti-rotation.
- 2x O10 preload springs (stand-ins) (+/-12, -124) Z 114..124 between
  bezel top and arm bottom.
- 2x O10x4 hard-stop collars on the pins above the arm (Z 136..140) limit
  downward head extension.

CARTRIDGE INTERFACE (real bores/clearances instead of solid intersection):
- O42x4-deep pocket (rounded rect X +/-21, Y -138.5..-107.5) cut into the
  probe head underside: the cartridge PCB (Z 39..43) now has 0.5-1 mm
  clearance instead of intersecting the head solid.
- 2x O3 dowel pins (+/-25, -124) Z 36..48 press-fit in the cartridge plate,
  entering O3.2 bores cut in the head (kinematic locating).

CLAMPING:
- Adjustable clamp blocks get real adjustment hardware: 6 mm adjustment
  slots cut through each block + O12 knob screws on top (Z 68..78).

Intended press-fit overlaps (whitelist in audits): guide pins in head top,
collars on pins, dowels in cartridge plate, vacuum bosses touching plate.

Units: sketch coords in METERS (M = 0.001); depth/offset params in mm.
Top plane JDC: sketch (x,y) -> world (X,Y), extrude +Z, offset = start Z.

ADDENDUM (executed separately, same session): SHELL HOLLOWING — the side
shells were solid 70 mm slabs (v4 review item 2). Onshape's native shell
feature ERRORed on them under every serialization tried (entities /
isHollow+partsToShell, 5/3/2 mm, even rolled back before the vent cuts via
the rollback-bar insert trick). Final fix: 'EVT2 - Shell Hollow Cut' — a
corner-aware interior REMOVE from the Right plane (profile Y +/-415,
Z -295..460, R20, symmetric X +/-500, scoped to both shells). Limits stay
inside the R60 plan corners (breach limit |Y|<=419 at X=500) and the R30
top roundover (Z<=463 at X=500), leaving 5 mm side skins, solid corner
posts, and removing 80.4 L of phantom material (0.2068 -> 0.1264 m3 total).
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

APPEARANCE_PROP = "57f3fb8efa3416c06701d60c"

c = Client()
fb = FeatureBuilder(c, DID, WID, EID)

def part_ids():
    return {name: pid for pid, name in fb.parts().items()}

def new_parts(before):
    return [p for p in fb.parts() if p not in before]

def finish(pid, name, rgb, opacity=255):
    fb.rename_part(pid, name)
    time.sleep(0.4)
    c._request("POST", "/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
        DID, WID, EID, quote(pid, safe="")),
        json={"properties": [{"propertyId": APPEARANCE_PROP,
              "value": {"color": {"red": rgb[0], "green": rgb[1],
                                  "blue": rgb[2]}, "opacity": opacity}}]})
    time.sleep(0.4)

ids = part_ids()

# ---- 1. fixture stack -------------------------------------------------------
sk = fb.add_sketch("EVT2 - Deck Cutout", PLANE_TOP,
                   rounded_rect("dc", -266 * M, -216 * M, 266 * M, 216 * M, 10 * M))
time.sleep(1.2)
fb.add_extrude_remove("EVT2 - Deck Cutout Cut", sk, depth_mm=10, offset_mm=50,
                      scope_part_ids=[ids["Instrument Deck"]])
print("deck cutout done", flush=True)
time.sleep(1.2)

ents = [circle("so{}".format(i), x * M, y * M, 8 * M)
        for i, (x, y) in enumerate(((-230, -180), (230, -180),
                                    (-230, 180), (230, 180)))]
sk = fb.add_sketch("EVT2 - Fixture Standoffs", PLANE_TOP, ents)
time.sleep(1.2)
before = set(fb.parts())
fb.add_extrude("EVT2 - Standoff Extrude", sk, depth_mm=40, offset_mm=0)
time.sleep(1.2)
standoffs = new_parts(before)
print("standoffs:", len(standoffs), flush=True)

ents = [circle("vp{}".format(i), x * M, y * M, 6 * M)
        for i, (x, y) in enumerate(((-120, -80), (120, -80),
                                    (-120, 80), (120, 80)))]
sk = fb.add_sketch("EVT2 - Vacuum Ports", PLANE_TOP, ents)
time.sleep(1.2)
before = set(fb.parts())
fb.add_extrude("EVT2 - Vacuum Port Extrude", sk, depth_mm=8, offset_mm=32)
time.sleep(1.2)
vacuum = new_parts(before)
print("vacuum bosses:", len(vacuum), flush=True)

fb.transform_translate([ids["PicoScope 5444D"]], 450, 285, -300,
                       name="EVT2 - PicoScope To Service Bay")
print("PicoScope relocated", flush=True)
time.sleep(1.2)

# ---- 2. probe mount arm + compliance ---------------------------------------
sk = fb.add_sketch("EVT2 - Probe Mount Arm", PLANE_TOP,
                   rounded_rect("ma", -34 * M, -143 * M, 75 * M, -28 * M, 6 * M))
time.sleep(1.2)
before = set(fb.parts())
fb.add_extrude("EVT2 - Mount Arm Extrude", sk, depth_mm=12, offset_mm=124)
time.sleep(1.2)
arm = new_parts(before)[0]
print("mount arm created", flush=True)

ents = [circle("gb{}".format(i), x * M, -124 * M, 2.75 * M)
        for i, x in enumerate((-24, 24))]
sk = fb.add_sketch("EVT2 - Guide Pin Bores", PLANE_TOP, ents)
time.sleep(1.2)
fb.add_extrude_remove("EVT2 - Guide Pin Bores Cut", sk, depth_mm=30,
                      offset_mm=106,
                      scope_part_ids=[arm, ids["Probe Camera Bezel"]])
print("guide pin bores cut", flush=True)
time.sleep(1.2)

ents = [circle("gp{}".format(i), x * M, -124 * M, 2.5 * M)
        for i, x in enumerate((-24, 24))]
sk = fb.add_sketch("EVT2 - Guide Pins", PLANE_TOP, ents)
time.sleep(1.2)
before = set(fb.parts())
fb.add_extrude("EVT2 - Guide Pin Extrude", sk, depth_mm=34, offset_mm=106)
time.sleep(1.2)
pins = new_parts(before)
print("guide pins:", len(pins), flush=True)

ents = [circle("hc{}".format(i), x * M, -124 * M, 5 * M)
        for i, x in enumerate((-24, 24))]
sk = fb.add_sketch("EVT2 - Hard Stop Collars", PLANE_TOP, ents)
time.sleep(1.2)
before = set(fb.parts())
fb.add_extrude("EVT2 - Collar Extrude", sk, depth_mm=4, offset_mm=136)
time.sleep(1.2)
collars = new_parts(before)

ents = [circle("ps{}".format(i), x * M, -124 * M, 5 * M)
        for i, x in enumerate((-12, 12))]
sk = fb.add_sketch("EVT2 - Preload Springs", PLANE_TOP, ents)
time.sleep(1.2)
before = set(fb.parts())
fb.add_extrude("EVT2 - Spring Extrude", sk, depth_mm=10, offset_mm=114)
time.sleep(1.2)
springs = new_parts(before)
print("collars + springs done", flush=True)

# ---- 3. cartridge interface --------------------------------------------------
sk = fb.add_sketch("EVT2 - Cartridge Pocket", PLANE_TOP,
                   rounded_rect("cp", -21 * M, -138.5 * M, 21 * M, -107.5 * M, 3 * M))
time.sleep(1.2)
fb.add_extrude_remove("EVT2 - Cartridge Pocket Cut", sk, depth_mm=4,
                      offset_mm=40, scope_part_ids=[ids["Probe Head"]])
print("cartridge pocket cut", flush=True)
time.sleep(1.2)

ents = [circle("db{}".format(i), x * M, -124 * M, 1.6 * M)
        for i, x in enumerate((-25, 25))]
sk = fb.add_sketch("EVT2 - Dowel Bores", PLANE_TOP, ents)
time.sleep(1.2)
fb.add_extrude_remove("EVT2 - Dowel Bores Cut", sk, depth_mm=8,
                      offset_mm=40, scope_part_ids=[ids["Probe Head"]])
time.sleep(1.2)

ents = [circle("dp{}".format(i), x * M, -124 * M, 1.5 * M)
        for i, x in enumerate((-25, 25))]
sk = fb.add_sketch("EVT2 - Cartridge Dowels", PLANE_TOP, ents)
time.sleep(1.2)
before = set(fb.parts())
fb.add_extrude("EVT2 - Dowel Extrude", sk, depth_mm=12, offset_mm=36)
time.sleep(1.2)
dowels = new_parts(before)
print("cartridge dowels done", flush=True)

# ---- 4. clamp hardware --------------------------------------------------------
ents = (rounded_rect("sf", -30 * M, -198 * M, 30 * M, -192 * M, 2.9 * M) +
        rounded_rect("sr", -30 * M, 192 * M, 30 * M, 198 * M, 2.9 * M) +
        rounded_rect("sl", -248 * M, -30 * M, -242 * M, 30 * M, 2.9 * M) +
        rounded_rect("sg", 242 * M, -30 * M, 248 * M, 30 * M, 2.9 * M))
sk = fb.add_sketch("EVT2 - Clamp Slots", PLANE_TOP, ents)
time.sleep(1.2)
clamp_ids = [ids["Adjustable Clamp Front"], ids["Adjustable Clamp Rear"],
             ids["Adjustable Clamp Left"], ids["Adjustable Clamp Right"]]
fb.add_extrude_remove("EVT2 - Clamp Slots Cut", sk, depth_mm=10,
                      offset_mm=58, scope_part_ids=clamp_ids)
print("clamp slots cut", flush=True)
time.sleep(1.2)

ents = [circle("kn{}".format(i), x * M, y * M, 6 * M)
        for i, (x, y) in enumerate(((0, -195), (0, 195),
                                    (-245, 0), (245, 0)))]
sk = fb.add_sketch("EVT2 - Clamp Knobs", PLANE_TOP, ents)
time.sleep(1.2)
before = set(fb.parts())
fb.add_extrude("EVT2 - Knob Extrude", sk, depth_mm=10, offset_mm=68)
time.sleep(1.2)
knobs = new_parts(before)
print("clamp knobs done", flush=True)

# ---- 5. names + colors --------------------------------------------------------
bb = fb.all_bboxes()
names = fb.parts()

def corner(pid):
    b = bb[names[pid]]
    return ("F" if (b["lowY"] + b["highY"]) / 2 < 0 else "R") + \
           ("L" if (b["lowX"] + b["highX"]) / 2 < 0 else "R")

for pid in standoffs:
    finish(pid, "Fixture Standoff {}".format(corner(pid)), (120, 120, 125))
for pid in vacuum:
    finish(pid, "Vacuum Port Boss {}".format(corner(pid)), (40, 40, 44))
finish(arm, "Probe Mount Arm", (105, 105, 110))
for i, pid in enumerate(sorted(pins, key=lambda p: bb[names[p]]["lowX"])):
    finish(pid, "Probe Guide Pin {}".format("LR"[i]), (190, 190, 195))
for i, pid in enumerate(sorted(collars, key=lambda p: bb[names[p]]["lowX"])):
    finish(pid, "Probe Hard Stop Collar {}".format("LR"[i]), (50, 50, 55))
for i, pid in enumerate(sorted(springs, key=lambda p: bb[names[p]]["lowX"])):
    finish(pid, "Probe Preload Spring {}".format("LR"[i]), (70, 110, 180))
for i, pid in enumerate(sorted(dowels, key=lambda p: bb[names[p]]["lowX"])):
    finish(pid, "Cartridge Dowel Pin {}".format("LR"[i]), (190, 190, 195))
KN = {(0, -195): "Front", (0, 195): "Rear", (-245, 0): "Left", (245, 0): "Right"}
for pid in knobs:
    b = bb[names[pid]]
    cx = round((b["lowX"] + b["highX"]) / 2)
    cy = round((b["lowY"] + b["highY"]) / 2)
    finish(pid, "Clamp Knob {}".format(KN.get((cx, cy), "?")), (25, 25, 28))

for pid in standoffs + vacuum + [arm] + pins + collars + springs + dowels + knobs:
    b = bb[names[pid]]
    print("{:32s} X {:6.1f}..{:6.1f} Y {:6.1f}..{:6.1f} Z {:6.1f}..{:6.1f}".format(
        names[pid], b["lowX"], b["highX"], b["lowY"], b["highY"],
        b["lowZ"], b["highZ"]), flush=True)

print("EVT-2 PASS COMPLETE", flush=True)
