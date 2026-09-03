"""FL-1 promo video — commercial-style, ~19 s @ 8 fps (~150 frames).

Storyboard:
  S1 000-014  logo push-in (etched firstlight mark)
  S2 015-032  hero reveal pull-back
  S3 033-052  canopy opens (door + rails + sensor target on the hinge axis)
  S4 053-072  drawer glides out under the open canopy
  S5 073-090  drawer retracts + canopy closes (simultaneous)
  S6 091-120  interior probing run (assembly matevalues, glass thinned)
  S7 121-138  rear: fans spinning behind their guards (720 deg = net zero)
  S8 139-152  finale wide pull-back + hold

Technique:
- Studio scenes drive motion with INCREMENTAL delta transform features
  (rotations about the fixed hinge/fan axes compose additively). The
  choreography is net-zero (door reopens+closes, drawer out+back, fans
  spin 720) and all POSE2-* features are deleted afterward.
- Ghost reference bodies are pre-dimmed to opacity 3 (restore file in
  scratchpad); renders use default visibility (no showAllParts).
- S6 uses the Motion Check assembly sliders like the first video.

Resumable: existing frame files skip their render (transform deltas for
studio scenes are only posted when the frame renders, so re-runs stay
consistent only from a clean tree — if resuming after a crash, delete
POSE2-* features first).
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

from features import FeatureBuilder
from onshape_client import Client, BASE_URL

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"
ASM = "d6767f7eb804454caaa2dc85"
ABASE = "/api/v6/assemblies/d/{}/w/{}/e/{}".format(DID, WID, ASM)
P_APPEAR = "57f3fb8efa3416c06701d60c"

SCRATCH = os.environ.get("SCRATCH", "/tmp")
FRAMES = SCRATCH + "/promo_frames"
OUT = os.path.join(os.path.dirname(__file__), "..", "..",
                   "cad", "electronics-bringup-station", "fl1-promo.mp4")
W, H = 1280, 720
GAUGE = (0.0, 0.320, -0.0625)

DOOR_SET = ["Front Smoked Glass v2", "Door Sensor Target",
            "Door Edge Rail Bottom Front", "Door Edge Rail Top Front",
            "Door Edge Rail Bottom Back", "Door Edge Rail Top Back",
            "Strut Door Bracket Left", "Strut Door Bracket Right"]
PAYLOAD = (["PCB Fixture Plate", "Sample PCB", "Calibration Fiducial Target",
            "Probe Touch-Off Pad", "Force Calibration Post"] +
           ["PCB Component {}".format(i) for i in range(1, 7)] +
           ["PCB Connector {}".format(i) for i in range(1, 5)] +
           ["Adjustable Clamp Front", "Adjustable Clamp Rear",
            "Adjustable Clamp Left", "Adjustable Clamp Right",
            "Clamp Knob Front", "Clamp Knob Rear", "Clamp Knob Left",
            "Clamp Knob Right"] +
           ["Fixture Locating Pin {}".format(i) for i in range(1, 5)] +
           ["Vacuum Port {}".format(i) for i in range(1, 5)] +
           ["Vacuum Port Boss FL", "Vacuum Port Boss FR",
            "Vacuum Port Boss RL", "Vacuum Port Boss RR"])


def ease(a, b, t):
    s = t * t * (3 - 2 * t)
    return a + (b - a) * s


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


def lerp3(a, b, t):
    return tuple(ease(a[i], b[i], t) for i in range(3))


class Rig:
    def __init__(self):
        self.fb = FeatureBuilder(Client(), DID, WID, EID)
        self.c = self.fb.c
        self.pids = {}
        for p in self.c.list_parts(DID, WID, EID):
            if p.get("bodyType") != "composite":
                self.pids.setdefault(p["name"], []).append(p["partId"])
        self.n = 0

    def ids(self, names):
        out = []
        for n in names:
            out += self.pids.get(n, [])
        return out

    def translate(self, names, dx, dy, dz):
        self.n += 1
        self.fb.transform_translate(self.ids(names), dx, dy, dz,
                                    name="POSE2-{:04d}".format(self.n))

    def rotate(self, names, px, py, pz, angle):
        self.n += 1
        q = ("query = qContainsPoint(qEverything(EntityType.EDGE), "
             "vector({}, {}, {}) * millimeter);".format(px, py, pz))
        self.fb._post({"btType": "BTMFeature-134", "featureType": "transform",
                       "name": "POSE2-{:04d}".format(self.n), "parameters": [
            {"btType": "BTMParameterQueryList-148", "parameterId": "entities",
             "queries": [{"btType": "BTMIndividualQuery-138",
                          "deterministicIds": self.ids(names)}]},
            {"btType": "BTMParameterEnum-145", "parameterId": "transformType",
             "value": "ROTATION", "enumName": "TransformType"},
            {"btType": "BTMParameterQueryList-148",
             "parameterId": "transformAxis",
             "queries": [{"btType": "BTMIndividualQuery-138",
                          "queryString": q}]},
            {"btType": "BTMParameterQuantity-147", "parameterId": "angle",
             "expression": "{} deg".format(angle)},
            {"btType": "BTMParameterBoolean-144", "parameterId": "makeCopy",
             "value": False}]})

    def render(self, idx, vm, px):
        path = FRAMES + "/f{:04d}.png".format(idx)
        if os.path.exists(path):
            return
        r = self.c._request(
            "GET", "/api/v6/partstudios/d/{}/w/{}/e/{}/shadedviews".format(
                DID, WID, EID),
            params={"viewMatrix": vm, "outputHeight": H, "outputWidth": W,
                    "pixelSize": px})
        with open(path, "wb") as f:
            f.write(base64.b64decode(r["images"][0]))

    def cleanup(self):
        feats = self.fb.get_features()
        n = 0
        for f in feats["features"]:
            if f.get("name", "").startswith("POSE2-"):
                self.fb.delete_feature(f["featureId"])
                n += 1
                time.sleep(0.4)
        print("pose features deleted:", n)


def studio_scenes(rig):
    LOGO = (-0.320, -0.460, -0.212)
    FRONT = (0.0, -0.02, 0.09)
    # S1: logo push-in
    for i in range(15):
        t = i / 14.0
        vm, px = cam(ease(-6, 0, t), ease(-4, -2, t),
                     lerp3((-0.30, -0.46, -0.19), LOGO, t),
                     ease(0.00085, 0.00030, t))
        rig.render(i, vm, px)
    print("S1 done", flush=True)
    # S2: hero reveal
    for i in range(18):
        t = i / 17.0
        vm, px = cam(ease(0, 26, t), ease(-2, -12, t),
                     lerp3(LOGO, FRONT, t), ease(0.00030, 0.00165, t))
        rig.render(15 + i, vm, px)
    print("S2 done", flush=True)
    # S3: canopy opens (eased 0 -> -105 about the hinge edge)
    prev = 0.0
    for i in range(20):
        t = (i + 1) / 20.0
        a = ease(0, -105, t)
        rig.rotate(DOOR_SET, 300.0, -450.0, 445.0, a - prev)
        prev = a
        vm, px = cam(ease(26, 18, t), ease(-12, 2, t),
                     lerp3(FRONT, (0.0, -0.12, 0.20), t), 0.00165)
        rig.render(33 + i, vm, px)
        time.sleep(0.3)
    print("S3 done", flush=True)
    # S4: drawer out (eased 0 -> -420)
    prevy = 0.0
    for i in range(20):
        t = (i + 1) / 20.0
        yy = ease(0, -420, t)
        rig.translate(PAYLOAD, 0, yy - prevy, 0)
        prevy = yy
        vm, px = cam(ease(18, 12, t), ease(2, -10, t),
                     lerp3((0.0, -0.12, 0.20), (0.0, -0.33, 0.10), t),
                     ease(0.00165, 0.00105, t))
        rig.render(53 + i, vm, px)
        time.sleep(0.3)
    print("S4 done", flush=True)
    # S5: retract + close (both eased back over 18 frames)
    prevy2, preva2 = -420.0, -105.0
    for i in range(18):
        t = (i + 1) / 18.0
        yy = ease(-420, 0, t)
        aa = ease(-105, 0, t)
        rig.translate(PAYLOAD, 0, yy - prevy2, 0)
        rig.rotate(DOOR_SET, 300.0, -450.0, 445.0, aa - preva2)
        prevy2, preva2 = yy, aa
        vm, px = cam(ease(12, 28, t), ease(-10, -13, t),
                     lerp3((0.0, -0.33, 0.10), FRONT, t),
                     ease(0.00105, 0.00165, t))
        rig.render(73 + i, vm, px)
        time.sleep(0.3)
    print("S5 done", flush=True)
    # S7: fans spin, rear push-in (40 deg/frame x 18 = 720 = net zero)
    for i in range(18):
        t = i / 17.0
        rig.rotate(["Exhaust Fan Hub Left"], -202.0, 435.0, -75.0, 40)
        rig.rotate(["Exhaust Fan Hub Right"], 238.0, 435.0, -75.0, 40)
        vm, px = cam(ease(196, 178, t), ease(-10, -4, t),
                     lerp3((0.0, 0.35, 0.05), (0.16, 0.44, -0.07), t),
                     ease(0.00135, 0.00062, t))
        rig.render(121 + i, vm, px)
        time.sleep(0.3)
    print("S7 done", flush=True)
    # S8: finale pull-back + hold
    for i in range(11):
        t = i / 10.0
        vm, px = cam(ease(-30, -33, t), -13,
                     lerp3(FRONT, (0.0, 0.0, 0.10), t),
                     ease(0.00165, 0.00190, t))
        rig.render(139 + i, vm, px)
    import shutil
    for k in range(3):
        src = FRAMES + "/f0149.png"
        dst = FRAMES + "/f{:04d}.png".format(150 + k)
        if not os.path.exists(dst):
            shutil.copy(src, dst)
    print("S8 done", flush=True)


def interior_scene(rig):
    c = rig.c
    glass = rig.pids["Front Smoked Glass v2"][0]

    def glass_op(op):
        c._request("POST", "/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
            DID, WID, EID, quote(glass, safe="")),
            json={"properties": [{"propertyId": P_APPEAR, "value": {
                "color": {"red": 245, "green": 115, "blue": 15},
                "opacity": op}}]})

    mv = c._request("GET", ABASE + "/matevalues")
    vals = {m["mateName"]: m for m in mv["mateValues"]}
    XN, YN, ZN = "Slider 2", "Slider 3", "Slider 1"
    park = {n: vals[n].get("translationZ", 0.0) for n in (XN, YN, ZN)}

    def pose(dx, dy, dz):
        c._request("POST", ABASE + "/matevalues", json={"mateValues": [
            {"jsonType": "Slider", "featureId": vals[n]["featureId"],
             "ownerOccurrencePath": [], "translationZ": park[n] + d / 1000.0}
            for n, d in ((XN, dx), (YN, dy), (ZN, dz))]})

    # choreography within the safe limits (plunge -20, X +/-165, Y ok)
    path = [(0, 0, 0)] * 2
    for t in (0.5, 1.0):
        path.append((ease(0, -120, t), ease(0, -60, t), 0))
    path += [(-120, -60, -12), (-120, -60, -20), (-120, -60, -20),
             (-120, -60, -8)]
    for t in (0.4, 0.8, 1.0):
        path.append((ease(-120, 130, t), ease(-60, 80, t), 0))
    path += [(130, 80, -12), (130, 80, -20), (130, 80, -20), (130, 80, -8)]
    for t in (0.5, 1.0):
        path.append((ease(130, 0, t), ease(80, 0, t), 0))
    path += [(0, 0, 0)] * 2
    assert len(path) >= 15

    glass_op(95)
    time.sleep(1.5)
    try:
        last = None
        for i in range(30):
            t = i / 29.0
            p = path[min(int(t * (len(path) - 1) + 0.5), len(path) - 1)]
            if p != last:
                pose(*p)
                last = p
                time.sleep(0.4)
            gt = (0.0 + GAUGE[0], -0.02 + GAUGE[1], 0.10 + GAUGE[2])
            vm, px = cam(ease(-22, 22, t), ease(-10, -16, t), gt, 0.00120)
            fpath = FRAMES + "/f{:04d}.png".format(91 + i)
            if not os.path.exists(fpath):
                r = c._request("GET", ABASE + "/shadedviews",
                               params={"viewMatrix": vm, "outputHeight": H,
                                       "outputWidth": W, "pixelSize": px})
                with open(fpath, "wb") as f:
                    f.write(base64.b64decode(r["images"][0]))
        pose(0, 0, 0)
    finally:
        glass_op(220)
    print("S6 done", flush=True)


def encode():
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    "..", "..", "hardware", "blocks"))
    import toolchain
    rc = os.system(
        "{} -y -framerate 8 -i '{}/f%04d.png' "
        "-c:v libx264 -pix_fmt yuv420p -crf 19 '{}' 2>/dev/null".format(
            toolchain.ffmpeg_bin(), FRAMES, os.path.abspath(OUT)))
    print("ffmpeg rc:", rc, "->", os.path.abspath(OUT))


def main():
    os.makedirs(FRAMES, exist_ok=True)
    mode = sys.argv[1] if len(sys.argv) > 1 else "full"
    rig = Rig()
    if mode == "cleanup":
        rig.cleanup()
        return
    if mode == "encode":
        encode()
        return
    if mode == "interior":
        interior_scene(rig)
        encode()
        return
    studio_scenes(rig)
    rig.cleanup()
    interior_scene(rig)
    encode()
    print("PROMO COMPLETE")


if __name__ == "__main__":
    main()
