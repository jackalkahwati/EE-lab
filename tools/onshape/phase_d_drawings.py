"""Phase D — model-based drawing sheets for the EE-FAB parts (2026-06-12).

Onshape's drawing API cannot auto-dimension, so Phase D ships MBD-style
reference sheets: per-part A4-landscape PDF with FRONT / TOP / RIGHT / ISO
shaded views (per-part shadedviews endpoint) and a title block carrying
part number, material, finish, quantity, envelope dims, and the governing
note: DIMENSIONS PER 3D MODEL (Part_Studio_1_v5.step), ISO 2768-mK.
Critical-feature callouts come from the RFQ cover (rail-face flatness,
H7 press bores). Output: docs/rfq/drawings/<PN>-<slug>.pdf + combined
fl1-evt-drawing-set.pdf.
"""
import base64
import io
import math
import os
import time
import warnings

warnings.filterwarnings("ignore")

import sys

sys.path.insert(0, "/Users/jackal-kahwati/EE-lab/tools/onshape")

from urllib.parse import quote

from features import FeatureBuilder
from onshape_client import Client
from PIL import Image, ImageDraw, ImageFont

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"

#: pn, representative part, qty, finish, critical note
SHEETS = [
    ("EE-FAB-ARM", "Probe Mount Arm", 1, "Clear anodize",
     "Guide-pin bores O5.5 H7; slide-plate interface face flat 0.02"),
    ("EE-FAB-PHD", "Probe Head", 1, "Clear anodize",
     "Cartridge pocket +0.5/-0 clearance; dowel bores O3.2 H7"),
    ("EE-FAB-FIXP", "PCB Fixture Plate", 1, "Clear anodize",
     "Locating pin bores H7; top face flat 0.05 over span"),
    ("EE-FAB-DECK", "Instrument Deck", 1, "Powder coat matte black",
     "Rack/standoff hole pattern true position 0.1"),
    ("EE-FAB-STDF", "Fixture Standoff FL", 4, "Clear anodize", "Length +/-0.05"),
    ("EE-FAB-CLMP", "Adjustable Clamp Front", 4, "Clear anodize",
     "6 mm adjustment slot; deburr slot edges"),
    ("EE-FAB-CRDL", "Cartridge Cradle 1", 3, "Clear anodize",
     "22 mm park slot +0.2/-0"),
    ("EE-FAB-RACK", "Cartridge Park Rack Base", 1, "Clear anodize", ""),
    ("EE-FAB-DUTIF", "DUT Interface Bulkhead", 1, "Powder coat matte black",
     "Connector cutouts per model"),
    ("EE-FAB-CAMBKT", "Overhead Camera Bracket Beam", 1, "Clear anodize",
     "Camera pocket faces flat 0.05"),
    ("EE-FAB-TOP", "Top Slab", 1, "Cosmetic Class A",
     "R30 roundovers mate shell contour; exterior no tool marks"),
    ("EE-FAB-SHL", "Side Shell Left", 2, "Cosmetic Class A",
     "Qty 2 = L + R MIRRORED; 5 mm wall; exterior Class A"),
    ("EE-FAB-BPAN", "Enclosure Base Pan", 1, "Powder coat matte black", ""),
    ("EE-FAB-DSPBZL", "Touch Display Bezel", 1, "Cosmetic Class A",
     "Display aperture per panel datasheet"),
]

#: view name -> 9 rotation floats (rows: right, up, -forward)
def vm(yaw_deg, pitch_deg):
    import numpy as np
    yaw, pitch = math.radians(yaw_deg), math.radians(pitch_deg)
    f = np.array([math.sin(yaw) * math.cos(pitch),
                  math.cos(yaw) * math.cos(pitch), math.sin(pitch)])
    f /= np.linalg.norm(f)
    r = np.cross(f, np.array([0, 0, 1.0])); r /= np.linalg.norm(r)
    u = np.cross(r, f)
    return ",".join("{:.6f}".format(v) for row in [r, u, -f] for v in list(row) + [0.0])

VIEWS = [
    ("FRONT", "1,0,0,0,0,0,1,0,0,-1,0,0"),
    ("TOP", "1,0,0,0,0,1,0,0,0,0,1,0"),
    ("RIGHT", "0,1,0,0,0,0,1,0,1,0,0,0"),
    ("ISO", vm(30, -30)),
]

OUT = "/Users/jackal-kahwati/EE-lab/docs/rfq/drawings"
os.makedirs(OUT, exist_ok=True)

c = Client()
fb = FeatureBuilder(c, DID, WID, EID)
ids = {name: pid for pid, name in fb.parts().items()}
bb = fb.all_bboxes()

def font(sz, bold=False):
    try:
        return ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", sz,
                                  index=1 if bold else 0)
    except Exception:
        return ImageFont.load_default()

W, H = 1754, 1240  # A4 landscape @150dpi
sheets = []
for idx, (pn, part, qty, finish, note) in enumerate(SHEETS):
    pid = ids[part]
    views = []
    for vname, mat in VIEWS:
        resp = c._request(
            "GET", "/api/v6/parts/d/{}/w/{}/e/{}/partid/{}/shadedviews".format(
                DID, WID, EID, quote(pid, safe="")),
            params={"viewMatrix": mat, "outputHeight": 480, "outputWidth": 660,
                    "pixelSize": 0})
        views.append((vname, Image.open(io.BytesIO(
            base64.b64decode(resp["images"][0]))).convert("RGB")))
        time.sleep(0.4)

    sheet = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(sheet)
    d.rectangle([10, 10, W - 10, H - 10], outline="black", width=3)
    # 2x2 view grid
    cells = [(20, 20), (890, 20), (20, 540), (890, 540)]
    for (vname, img), (cx, cy) in zip(views, cells):
        sheet.paste(img, (cx + 90, cy + 16))
        d.text((cx + 14, cy + 8), vname, font=font(26, True), fill="black")
        d.rectangle([cx + 8, cy + 4, cx + 848, cy + 506], outline="#999", width=1)
    # title block
    tb_y = H - 178
    d.rectangle([W - 760, tb_y, W - 12, H - 12], outline="black", width=2)
    b = bb[part]
    dims = sorted([b["highX"] - b["lowX"], b["highY"] - b["lowY"],
                   b["highZ"] - b["lowZ"]], reverse=True)
    rows = [
        ("TITLE", part), ("PART NO", pn), ("QTY", str(qty)),
        ("ENVELOPE", "{:.0f} x {:.0f} x {:.0f} mm".format(*dims)),
        ("FINISH", finish),
    ]
    y = tb_y + 8
    for k, v in rows:
        d.text((W - 748, y), k, font=font(18), fill="#666")
        d.text((W - 600, y), v[:52], font=font(20, True), fill="black")
        y += 30
    d.text((20, tb_y + 4),
           "DIMENSIONS PER 3D MODEL: Part_Studio_1_v5.step  |  GENERAL TOLERANCE ISO 2768-mK  |  "
           "DEBURR ALL EDGES", font=font(19), fill="black")
    if note:
        d.text((20, tb_y + 34), "CRITICAL: " + note, font=font(19, True), fill="#b00")
    d.text((20, tb_y + 72), "FIRSTLIGHT FL-1  ·  EVT BUILD  ·  EE-lab  ·  2026-06-12  ·  "
           "SCALE NTS  ·  SHEET {} / {}".format(idx + 1, len(SHEETS)),
           font=font(18), fill="#444")
    slug = part.lower().replace(" ", "-")
    path = "{}/{}-{}.pdf".format(OUT, pn, slug)
    sheet.save(path, "PDF", resolution=150)
    sheets.append(sheet)
    print("sheet:", pn, part, flush=True)

sheets[0].save("{}/fl1-evt-drawing-set.pdf".format(OUT), "PDF", resolution=150,
               save_all=True, append_images=sheets[1:])
print("PHASE D COMPLETE: {} sheets + combined set".format(len(sheets)))
