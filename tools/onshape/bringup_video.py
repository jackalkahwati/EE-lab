"""First-board bring-up video: machine working + camera fly-through.

Act 1 (frames 0..N1, fixed 3/4-front camera, machine centered, slow
push-in): the probe head runs a first-bring-up sequence on the sample
PCB — travel to a test point, plunge, retract, four points, a visit to
the cartridge park rack, return to park.

Act 2 (fly-through): orbit front -> side -> rear (E-stop) -> back to
front, then close-ins: probe head through the amber window, 15.6in
display, rear E-stop. Fixed pixelSize + viewMatrix translation targets
specific world points (camera target P: t = -R @ P). ASSEMBLY world
coordinates carry the mate-group gauge offset (0, +320, -62.5) mm, so
model-space targets are shifted by it.

Motion via matevalues on the three slider mates (X="Slider 2",
Y="Slider 3", Z="Slider 1"); park restored afterward. The window glass
drops to opacity 110 for filming (action visible through the amber, as
in Formlabs promo shots) and is restored to 220.

Resumable: existing frame files are skipped (pose posts still run to
keep pose/frame alignment cheap to reason about — only render calls are
saved). Usage: python3 bringup_video.py [test|full|encode]
"""

from __future__ import annotations

import base64
import math
import os
import sys
import time
import warnings

warnings.filterwarnings("ignore")

from urllib.parse import quote

from onshape_client import Client, BASE_URL

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
PS = "8a871c2acd668dc865dda723"
ASM = "d6767f7eb804454caaa2dc85"
BASE = "/api/v6/assemblies/d/{}/w/{}/e/{}".format(DID, WID, ASM)
P_APPEAR = "57f3fb8efa3416c06701d60c"

SCRATCH = os.environ.get("SCRATCH", "/tmp")
FRAMES = SCRATCH + "/bringup_frames"
OUT = os.path.join(os.path.dirname(__file__), "..", "..",
                   "cad", "electronics-bringup-station",
                   "fl1-first-bringup.mp4")

GAUGE = (0.0, 0.320, -0.0625)          # assembly gauge offset, meters
CENTER = (0.0, 0.0 + GAUGE[1], 0.090 + GAUGE[2])   # machine center, asm space
W, H = 1000, 750


def cam(yaw_deg, pitch_deg, target, pixel_size):
    """viewMatrix row-major [R|t] with t = -R @ target (centers target)."""
    y, p = math.radians(yaw_deg), math.radians(pitch_deg)
    f = (math.sin(y) * math.cos(p), math.cos(y) * math.cos(p), math.sin(p))
    n = math.hypot(f[1], -f[0]) or 1.0
    r = (f[1] / n, -f[0] / n, 0.0)
    u = (r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2],
         r[0] * f[1] - r[1] * f[0])
    rows = [r, u, tuple(-c for c in f)]
    vals = []
    for row in rows:
        t = -(row[0] * target[0] + row[1] * target[1] + row[2] * target[2])
        vals += list(row) + [t]
    return ",".join("{:.6f}".format(v) for v in vals), pixel_size


def ease(a, b, t):
    s = t * t * (3 - 2 * t)
    return a + (b - a) * s


def lerp3(a, b, t):
    return tuple(ease(a[i], b[i], t) for i in range(3))


def build_timeline():
    """Returns list of (pose_mm, cam_spec). pose_mm = (dx, dy, dz) deltas."""
    frames = []

    # ---- Act 1: bring-up run, slow push-in from 3/4 front ---------------
    def shot(pose, k):   # k: 0..1 across act 1 for the push-in
        return (pose, cam(-32, -13, CENTER, 0.00145 - 0.00030 * k))

    tps = [(-120, -80), (100, -60), (150, 100), (0, 20)]
    act1 = [(0, 0, 0), (0, 0, 0)]
    cur = (0, 0)
    for tp in tps:
        for t in (0.35, 0.7, 1.0):                     # travel
            act1.append((ease(cur[0], tp[0], t), ease(cur[1], tp[1], t), 0))
        act1 += [(tp[0], tp[1], -30), (tp[0], tp[1], -50),   # plunge/touch
                 (tp[0], tp[1], -50), (tp[0], tp[1], -20)]   # dwell/retract
        cur = tp
    for t in (0.4, 0.8, 1.0):                          # to cartridge rack
        act1.append((ease(cur[0], 160, t), ease(cur[1], -240, t), 0))
    act1 += [(160, -240, -25), (160, -240, 0)]         # tool touch
    for t in (0.4, 0.8, 1.0):                          # home
        act1.append((ease(160, 0, t), ease(-240, 0, t), 0))
    act1.append((0, 0, 0))
    n1 = len(act1)
    for i, pose in enumerate(act1):
        frames.append(shot(pose, i / max(n1 - 1, 1)))

    # ---- Act 2: fly-through (pose held at a probing stance) --------------
    hold = (150, 100, -40)
    orbit = 16
    for i in range(orbit):
        t = i / (orbit - 1)
        yaw = -32 + t * (-328 + 32)                    # -32 -> -328 (full orbit)
        pitch = -13 + 7 * math.sin(t * math.pi)        # gentle rise and fall
        frames.append((hold, cam(yaw, pitch, CENTER, 0.00125)))

    probe_t = (0.15 + GAUGE[0], -0.14 + GAUGE[1], 0.130 + GAUGE[2])
    disp_t = (0.213 + GAUGE[0], -0.461 + GAUGE[1], -0.115 + GAUGE[2])
    estop_t = (-0.300 + GAUGE[0], 0.460 + GAUGE[1], 0.300 + GAUGE[2])

    for i in range(6):                                  # dive to probe head
        t = i / 5.0
        frames.append((hold, cam(ease(-328, -360, t), ease(-6, -10, t),
                                 lerp3(CENTER, probe_t, t),
                                 ease(0.00125, 0.00050, t))))
    frames += [(hold, cam(-360, -10, probe_t, 0.00050))] * 2

    for i in range(5):                                  # slide to display
        t = i / 4.0
        frames.append((hold, cam(-360, ease(-10, -4, t),
                                 lerp3(probe_t, disp_t, t),
                                 ease(0.00050, 0.00055, t))))
    frames += [(hold, cam(-360, -4, disp_t, 0.00050))] * 2

    for i in range(6):                                  # swing to rear E-stop
        t = i / 5.0
        frames.append((hold, cam(ease(-360, -540, t), ease(-4, -8, t),
                                 lerp3(disp_t, estop_t, t),
                                 ease(0.00055, 0.00055, t))))
    frames += [(hold, cam(-540, -8, estop_t, 0.00055))] * 2

    for i in range(6):                                  # pull back to hero
        t = i / 5.0
        frames.append(((ease(150, 0, t), ease(100, 0, t), ease(-40, 0, t)),
                       cam(ease(-540, -392, t), ease(-8, -13, t),
                           lerp3(estop_t, CENTER, t),
                           ease(0.00055, 0.00145, t))))
    frames += [((0, 0, 0), cam(-392, -13, CENTER, 0.00145))] * 3
    return frames


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "test"
    os.makedirs(FRAMES, exist_ok=True)
    c = Client()

    if mode == "encode":
        encode()
        return

    parts = c.list_parts(DID, WID, PS)
    glass_pid = next(p["partId"] for p in parts
                     if p["name"] == "Front Smoked Glass v2")

    def glass_opacity(op):
        c._request("POST", "/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
            DID, WID, PS, quote(glass_pid, safe="")),
            json={"properties": [{"propertyId": P_APPEAR, "value": {
                "color": {"red": 245, "green": 115, "blue": 15},
                "opacity": op}}]})

    mv = c._request("GET", BASE + "/matevalues")
    vals = {m["mateName"]: m for m in mv["mateValues"]}
    XN, YN, ZN = "Slider 2", "Slider 3", "Slider 1"
    park = {n: vals[n].get("translationZ", 0.0) for n in (XN, YN, ZN)}
    print("park:", {k: round(v, 4) for k, v in park.items()})

    def set_pose(dx, dy, dz):
        c._request("POST", BASE + "/matevalues", json={"mateValues": [
            {"jsonType": "Slider", "featureId": vals[n]["featureId"],
             "ownerOccurrencePath": [],
             "translationZ": park[n] + d / 1000.0}
            for n, d in ((XN, dx), (YN, dy), (ZN, dz))]})

    def render(vm, px, path):
        r = c._request("GET", BASE + "/shadedviews",
                       params={"viewMatrix": vm, "outputHeight": H,
                               "outputWidth": W, "pixelSize": px})
        with open(path, "wb") as f:
            f.write(base64.b64decode(r["images"][0]))

    glass_opacity(110)
    time.sleep(1.5)
    try:
        if mode == "test":
            tests = [("t_wide", cam(-32, -13, CENTER, 0.00135), (0, 0, 0)),
                     ("t_probe", cam(0, -10,
                                     (0.15, -0.14 + GAUGE[1], 0.130 + GAUGE[2]),
                                     0.00042), (150, 100, -40)),
                     ("t_estop", cam(-540, -8,
                                     (-0.300, 0.460 + GAUGE[1], 0.300 + GAUGE[2]),
                                     0.00055), (0, 0, 0))]
            for name, (vm, px), pose in tests:
                set_pose(*pose)
                time.sleep(1.0)
                render(vm, px, SCRATCH + "/{}.png".format(name))
                print("test frame:", name)
            return
        # full run
        timeline = build_timeline()
        print("frames:", len(timeline))
        last_pose = None
        for i, (pose, (vm, px)) in enumerate(timeline):
            path = FRAMES + "/f{:04d}.png".format(i)
            if pose != last_pose:
                set_pose(*pose)
                last_pose = pose
                time.sleep(0.6)
            if not os.path.exists(path):
                render(vm, px, path)
            if i % 10 == 0:
                print("frame {}/{}".format(i, len(timeline)), flush=True)
        encode()
    finally:
        set_pose(0, 0, 0)
        glass_opacity(220)
        print("park + glass opacity restored")


def encode() -> None:
    out = os.path.abspath(OUT)
    rc = os.system(
        "/opt/homebrew/bin/ffmpeg -y -framerate 7 -i '{}/f%04d.png' "
        "-c:v libx264 -pix_fmt yuv420p -crf 20 '{}' 2>/dev/null".format(
            FRAMES, out))
    print("ffmpeg rc:", rc, "->", out)


if __name__ == "__main__":
    main()
