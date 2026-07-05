"""High-resolution website renders of the FL-1 (WEB-RENDERS-1).

Shoots the marketing set at 1920px for the FirstLight website. The Analysis
ghost bodies (open-door REF, extended struts, ghost rails, open-state drawer
payload) render translucent at opacity 70 and pollute clean product shots, so
this script dims them to opacity 2 for the shoot and restores opacity 70
after (same technique as promo_video.py). Geometry is never touched.

Outputs land in software/firstlight-website/public/media/.
"""
from __future__ import annotations

import base64
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from urllib.parse import quote  # noqa: E402

from onshape_client import Client, BASE_URL  # noqa: E402

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"

P_APPEAR = "57f3fb8efa3416c06701d60c"
GHOST_OPACITY_NORMAL = 70  # documented ghost appearance (production report 3k)
GHOST_OPACITY_SHOOT = 2

OUT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "..", "software", "firstlight-website", "public", "media",
)


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


# name -> (view, out_w, out_h)
# Machine spans X ±455, Y ±461, Z −302..+482 mm; center of visual mass ~Z +90.
VIEWS = {
    # Low 3/4 hero, slightly tighter than id3_hero, higher res
    "web-hero": (cam(-35, -12, (0, 0, 0.09), 0.00120), 1920, 1440),
    # Straight-on front (brand face)
    "web-front": (cam(0, -2, (0, 0, 0.09), 0.00100), 1920, 1440),
    # Opposite 3/4 from the right, shows vent field + seam line
    "web-hero-right": (cam(35, -10, (0, 0, 0.09), 0.00120), 1920, 1440),
    # Interior through the window: fixture + gantry
    "web-interior": (cam(-25, -16, (0.0, -0.05, 0.10), 0.00062), 1920, 1440),
    # Probe head close-up
    "web-probe": (cam(-18, -24, (0.0, -0.12, 0.16), 0.00034), 1920, 1440),
    # Brand corner: logo etch + display cluster
    "web-brand": (cam(-12, -6, (-0.10, -0.461, -0.14), 0.00052), 1920, 1200),
}


def set_ghost_opacity(c: Client, pids: list, opacity: int) -> None:
    """Batch-set appearance opacity on ghost bodies (amber, like the door REF)."""
    items = [
        {
            "href": "{}/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
                BASE_URL, DID, WID, EID, quote(pid, safe="")
            ),
            "properties": [
                {
                    "propertyId": P_APPEAR,
                    "value": {
                        "color": {"red": 245, "green": 115, "blue": 15},
                        "opacity": opacity,
                    },
                }
            ],
        }
        for pid in pids
    ]
    for i in range(0, len(items), 40):
        c._request(
            "POST",
            "/api/v6/metadata/d/{}/w/{}/e/{}".format(DID, WID, EID),
            json={"items": items[i : i + 40]},
        )
        time.sleep(1.0)


def main() -> None:
    c = Client()
    os.makedirs(OUT, exist_ok=True)

    ghosts = [
        p["partId"]
        for p in c.list_parts(DID, WID, EID)
        if p.get("bodyType") != "composite" and p["name"].startswith("Analysis")
    ]
    print("dimming {} ghost bodies to opacity {}".format(
        len(ghosts), GHOST_OPACITY_SHOOT), flush=True)
    set_ghost_opacity(c, ghosts, GHOST_OPACITY_SHOOT)

    try:
        for name, ((vm, px), w, h) in VIEWS.items():
            r = c._request(
                "GET",
                "/api/v6/partstudios/d/{}/w/{}/e/{}/shadedviews".format(
                    DID, WID, EID),
                # Default visibility (NO showAllParts): respects the document
                # view state, so the hidden CFG - OPEN ghost composite stays
                # out of the shot. showAllParts=true resurrects every hidden
                # ghost — even at opacity 2 their outline edges render.
                params={
                    "viewMatrix": vm,
                    "outputHeight": h,
                    "outputWidth": w,
                    "pixelSize": px,
                },
            )
            path = os.path.join(OUT, name + ".png")
            with open(path, "wb") as f:
                f.write(base64.b64decode(r["images"][0]))
            print("render:", name, "->", path, flush=True)
    finally:
        print("restoring ghost opacity to {}".format(GHOST_OPACITY_NORMAL),
              flush=True)
        set_ghost_opacity(c, ghosts, GHOST_OPACITY_NORMAL)

    print("done: {} renders".format(len(VIEWS)))


if __name__ == "__main__":
    main()
