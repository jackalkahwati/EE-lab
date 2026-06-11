"""Cosmetic finish pass: match the CAD to the approved industrial-design
renders (warm-white shells, smoked glass, black plinth + blue accent,
minimal black rear).

Consolidates the 2026-06-11 finish session, idempotent where possible:
  1. Appearance palette over the enclosure bodies (incl. glass opacity)
  2. Probe Head Logo Emblem (blue disc on the probe head face)
  3. Gap-filler trim: rear side slots, front side reveals, sill, header
  4. Flush top panel between the shells at the shell-top plane

API notes that came out of this pass (see README):
  - GET /features has the tightest rate quota; this script avoids it
    entirely by using the known Top-plane deterministic ID ("JDC") and
    naming bodies via the parts list + one-call FeatureScript bboxes.
  - deleteBodies works as a feature type (used for the misfit top bodies).
  - Sketch arcs work (BTCurveGeometryCircle segments, radian params) —
    see rounded_rect() for ready-made rounded profiles.
"""

from __future__ import annotations

import math
import time
import warnings

warnings.filterwarnings("ignore")

from urllib.parse import quote

from features import FeatureBuilder, line, rect
from onshape_client import Client

DID = "cfd5d2c28305575210ed8678"
WID = "6bf7390efd64f5e66777f769"
EID = "3ebb146a22425b80a016f78c"

APPEARANCE_PROP = "57f3fb8efa3416c06701d60c"
TOP_PLANE = {"btType": "BTMParameterQueryList-148", "parameterId": "sketchPlane",
             "queries": [{"btType": "BTMIndividualQuery-138",
                          "deterministicIds": ["JDC"]}]}

#: render palette: name -> (r, g, b, opacity)
PALETTE = {
    "Side Shell Left": (242, 241, 238, 255),
    "Side Shell Right": (242, 241, 238, 255),
    "Top Panel": (245, 245, 243, 255),
    "Rear Matte Black Panel": (38, 38, 40, 255),
    "Rear Vent Baffle": (12, 12, 14, 255),
    "Front Smoked Glass v2": (22, 26, 32, 110),
    "Front Matte Black Surround": (22, 22, 25, 255),
    "Plinth Fascia": (18, 18, 20, 255),
    "Accent Light Strip Full Width": (60, 130, 255, 255),
    "Power Button Illuminated Ring": (70, 140, 255, 255),
    "Chamber Light Bar": (250, 250, 255, 255),
    "Enclosure Base Pan": (30, 30, 32, 255),
    "Probe Head Logo Emblem": (70, 150, 255, 255),
    "Trim - Rear Filler Left": (38, 38, 40, 255),
    "Trim - Rear Filler Right": (38, 38, 40, 255),
    "Trim - Front Filler Left": (22, 22, 25, 255),
    "Trim - Front Filler Right": (22, 22, 25, 255),
    "Trim - Front Sill": (22, 22, 25, 255),
    "Trim - Front Header": (22, 22, 25, 255),
}


def arc(eid_, cx, cy, r, a0, a1):
    return {
        "btType": "BTMSketchCurveSegment-155",
        "entityId": eid_,
        "startPointId": eid_ + ".start",
        "endPointId": eid_ + ".end",
        "startParam": a0, "endParam": a1,
        "geometry": {"btType": "BTCurveGeometryCircle-115", "radius": r,
                     "xCenter": cx, "yCenter": cy, "xDir": 1.0, "yDir": 0.0,
                     "clockwise": False},
    }


def rounded_rect(prefix, x0, y0, x1, y1, r):
    """Rectangle profile with radiused corners (radians on circle params)."""
    p = math.pi
    return [
        line(prefix + ".t", x0 + r, y1, x1 - r, y1),
        line(prefix + ".b", x0 + r, y0, x1 - r, y0),
        line(prefix + ".l", x0, y0 + r, x0, y1 - r),
        line(prefix + ".r", x1, y0 + r, x1, y1 - r),
        arc(prefix + ".tr", x1 - r, y1 - r, r, 0, p / 2),
        arc(prefix + ".tl", x0 + r, y1 - r, r, p / 2, p),
        arc(prefix + ".bl", x0 + r, y0 + r, r, p, 3 * p / 2),
        arc(prefix + ".br", x1 - r, y0 + r, r, 3 * p / 2, 2 * p),
    ]


class FinishPass:
    def __init__(self) -> None:
        self.c = Client()
        self.fb = FeatureBuilder(self.c, DID, WID, EID)

    def set_appearance(self, pid, r, g, b, opacity=255):
        self.c._request(
            "POST", "/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
                DID, WID, EID, quote(pid, safe="")),
            json={"properties": [{"propertyId": APPEARANCE_PROP,
                  "value": {"color": {"red": r, "green": g, "blue": b},
                            "opacity": opacity}}]})

    def parts(self):
        return {p["name"]: p["partId"]
                for p in self.c.list_parts(DID, WID, EID)}

    def delete_bodies(self, names):
        parts = self.parts()
        victims = [parts[n] for n in names if n in parts]
        if not victims:
            return
        self.fb._post({
            "btType": "BTMFeature-134", "featureType": "deleteBodies",
            "name": "EVT - Delete " + "/".join(names),
            "parameters": [{"btType": "BTMParameterQueryList-148",
                            "parameterId": "entities",
                            "queries": [{"btType": "BTMIndividualQuery-138",
                                         "deterministicIds": victims}]}]})

    def apply_palette(self):
        parts = self.parts()
        for name, (r, g, b, op) in PALETTE.items():
            if name in parts:
                self.set_appearance(parts[name], r, g, b, op)
                time.sleep(0.3)

    def trim_and_top(self):
        """Gap fillers + flush top. Geometry derived from measured extents:
        rear panel X ±405 vs shells ±435; surround X ±395 / Z 60-460;
        fascia top Z=0; shell tops Z=482; everything inboard tops at 480."""
        fb = self.fb

        def one(name, entities, depth, offset, part_name, color,
                offset_opposite=False):
            sk = fb.add_sketch("Sketch EVT - " + name, TOP_PLANE, entities)
            fb.add_extrude("EVT - " + name, sk, depth_mm=depth,
                           offset_mm=offset, offset_opposite=offset_opposite)
            time.sleep(3)
            for nm, pid in self.parts().items():
                if nm.startswith("Part "):
                    fb.rename_part(pid, part_name)
                    self.set_appearance(pid, *color)
            time.sleep(3)

        one("Rear Side Fillers",
            rect("l", -0.435, 0.398, -0.405, 0.402) +
            rect("r", 0.405, 0.398, 0.435, 0.402),
            780.0, 300.0, "Trim - Rear Filler L/R", (38, 38, 40),
            offset_opposite=True)
        one("Front Side Fillers",
            rect("l", -0.435, -0.408, -0.395, -0.400) +
            rect("r", 0.395, -0.408, 0.435, -0.400),
            480.0, 0.0, "Trim - Front Filler L/R", (22, 22, 25))
        one("Front Sill", rect("s", -0.395, -0.408, 0.395, -0.400),
            60.0, 0.0, "Trim - Front Sill", (22, 22, 25))
        one("Front Header", rect("h", -0.395, -0.408, 0.395, -0.400),
            20.0, 460.0, "Trim - Front Header", (22, 22, 25))
        self.delete_bodies(["Enclosure Top Panel", "White Top Cap Overhang"])
        one("Top Panel Flush", rect("tp", -0.435, -0.460, 0.435, 0.460),
            2.0, 480.0, "Top Panel", (245, 245, 243))


if __name__ == "__main__":
    fp = FinishPass()
    fp.apply_palette()
    print("palette applied; trim/top geometry was built in the 2026-06-11 "
          "session — re-running trim_and_top() on a fresh copy only")
