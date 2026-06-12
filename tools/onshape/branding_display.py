"""Branding + operator display pass (2026-06-11).

1. WORDMARK — "FIRSTLIGHT FL-1" embossed 1 mm proud of the front fascia,
   lower-left (baseline Z -150, 24 mm caps), built as block segment-style
   letterforms from sketch rectangles (the BTMSketchTextEntity API path
   solves to zero edges without undocumented fields — deleted). Glyph
   strokes overlap by 2 mm at joints so each letter unions into one body.
   Glyph bodies are silver, excluded from BOMs (production = decal/silk).
2. TOUCH DISPLAY — 7 in capacitive panel (1024x600 HDMI/USB to the
   internal PC) on the plinth band front-right, beside the power cluster:
   bezel X 225..400, Z -165..-50 proud 2 mm; glass proud 1 mm of bezel.
   Rationale: standalone operation (run jobs, read the diagnosis verdict,
   calibration wizards) without a computer; full authoring stays on the
   web UI. The BOM's "screenless" rule bans embedded INSTRUMENT screens,
   not the product's own interface.

Front plane extrudes: default direction is -Y with offset measured along
the extrude direction, so offset 460 + depth 2 spans Y -462..-460 (proud).
"""
import time
import warnings

warnings.filterwarnings("ignore")

import sys

sys.path.insert(0, "/Users/jackal-kahwati/EE-lab/tools/onshape")

from urllib.parse import quote

from features import FeatureBuilder, rect, rounded_rect
from onshape_client import Client

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"

PLANE_FRONT = {"btType": "BTMParameterQueryList-148", "parameterId": "sketchPlane",
               "queries": [{"btType": "BTMIndividualQuery-138",
                            "deterministicIds": ["JCC"]}]}

P_NAME = "57f3fb8efa3416c06701d60d"
P_APPEAR = "57f3fb8efa3416c06701d60c"
P_PARTNO = "57f3fb8efa3416c06701d60f"
P_VENDOR = "57f3fb8efa3416c06701d612"
P_EXCLUDE = "57f3fb8efa3416c06701d61e"

#: block glyphs in a 20x30 box, stroke 6, joints overlapped 2 mm
GLYPHS = {
    "F": [(0, 0, 6, 30), (0, 24, 20, 30), (0, 12, 14, 18)],
    "I": [(7, 0, 13, 30)],
    "R": [(0, 0, 6, 30), (0, 24, 20, 30), (14, 12, 20, 28),
          (0, 12, 16, 18), (13, 0, 19, 14)],
    "S": [(0, 24, 20, 30), (0, 14, 6, 28), (0, 12, 20, 18),
          (14, 2, 20, 16), (0, 0, 20, 6)],
    "T": [(0, 24, 20, 30), (7, 0, 13, 26)],
    "L": [(0, 0, 6, 30), (0, 0, 20, 6)],
    "G": [(0, 24, 20, 30), (0, 0, 6, 28), (0, 0, 20, 6),
          (14, 2, 20, 16), (10, 10, 20, 16)],
    "H": [(0, 0, 6, 30), (14, 0, 20, 30), (0, 12, 20, 18)],
    "-": [(3, 12, 17, 18)],
    "1": [(7, 0, 13, 30), (1, 20, 9, 28), (1, 0, 19, 6)],
    " ": [],
}

TEXT = "FIRSTLIGHT FL-1"
SCALE = 0.8            # 24 mm caps
PITCH = 28.0 * SCALE
X0, Z0 = -390.0, -150.0

c = Client()
fb = FeatureBuilder(c, DID, WID, EID)

# remove the dead text-entity sketch from the probe attempt
try:
    fb.delete_feature("FssHxwbAq7x7lGv_359")
    print("deleted empty text sketch")
except Exception:
    pass
time.sleep(1.0)

M = 0.001
ents, n = [], 0
x = X0
for ch in TEXT:
    for (a, b, d, e) in GLYPHS[ch]:
        ents += rect("g{}".format(n),
                     (x + a * SCALE) * M, (Z0 + b * SCALE) * M,
                     (x + d * SCALE) * M, (Z0 + e * SCALE) * M)
        n += 1
    x += PITCH
sk = fb.add_sketch("Brand - Wordmark Glyphs", PLANE_FRONT, ents)
print("wordmark sketch: {} strokes".format(n), flush=True)
time.sleep(1.5)
before = set(fb.parts())
fb.add_extrude("Brand - Wordmark Emboss", sk, depth_mm=1, offset_mm=460)
time.sleep(1.5)
glyph_bodies = [p for p in fb.parts() if p not in before]
print("glyph bodies:", len(glyph_bodies), flush=True)

# ---- touch display -----------------------------------------------------------
sk = fb.add_sketch("Brand - Display Bezel", PLANE_FRONT,
                   rounded_rect("dbz", 225 * M, -165 * M, 400 * M, -50 * M, 8 * M))
time.sleep(1.5)
before = set(fb.parts())
fb.add_extrude("Brand - Display Bezel Extrude", sk, depth_mm=2, offset_mm=460)
time.sleep(1.5)
bezel = [p for p in fb.parts() if p not in before]

sk = fb.add_sketch("Brand - Display Glass", PLANE_FRONT,
                   rounded_rect("dgl", 231 * M, -159 * M, 394 * M, -56 * M, 5 * M))
time.sleep(1.5)
before = set(fb.parts())
fb.add_extrude("Brand - Display Glass Extrude", sk, depth_mm=1, offset_mm=462)
time.sleep(1.5)
glass = [p for p in fb.parts() if p not in before]

# ---- names / colors / BOM metadata in one bulk call ---------------------------
def item(pid, props):
    return {"href": "https://cad.onshape.com/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
        DID, WID, EID, quote(pid, safe="")), "properties": props}

items = []
for i, pid in enumerate(glyph_bodies):
    items.append(item(pid, [
        {"propertyId": P_NAME, "value": "Wordmark Glyph {:02d}".format(i + 1)},
        {"propertyId": P_APPEAR, "value": {"color": {"red": 218, "green": 220,
                                                     "blue": 224}, "opacity": 255}},
        {"propertyId": P_PARTNO, "value": "DECAL (production silkscreen)"},
        {"propertyId": P_EXCLUDE, "value": True}]))
for pid in bezel:
    items.append(item(pid, [
        {"propertyId": P_NAME, "value": "Touch Display Bezel"},
        {"propertyId": P_APPEAR, "value": {"color": {"red": 22, "green": 22,
                                                     "blue": 25}, "opacity": 255}},
        {"propertyId": P_PARTNO, "value": "EE-FAB-DSPBZL"},
        {"propertyId": P_VENDOR, "value": "FAB - machined"}]))
for pid in glass:
    items.append(item(pid, [
        {"propertyId": P_NAME, "value": "Touch Display 7in"},
        {"propertyId": P_APPEAR, "value": {"color": {"red": 15, "green": 18,
                                                     "blue": 26}, "opacity": 235}},
        {"propertyId": P_PARTNO, "value": "7in HDMI capacitive touch 1024x600"},
        {"propertyId": P_VENDOR, "value": "Generic industrial (Waveshare-class)"}]))
c._request("POST", "/api/v6/metadata/d/{}/w/{}/e/{}".format(DID, WID, EID),
           json={"items": items})
print("metadata applied to {} bodies".format(len(items)), flush=True)
print("BRANDING + DISPLAY COMPLETE", flush=True)
