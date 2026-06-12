"""Mate-driven motion simulation video for the Motion Check assembly.

Drives the three slider mates (X/Y/Z screw-to-nut) through a real-speed
choreography via the matevalues endpoint and renders a shaded frame per
time sample, so playback at FPS equals true machine speed.

Feed rates: X/Y 150 mm/s, Z 25 mm/s (ballscrew gantry realistic values).
Camera: front view pitched 12 deg forward/down so the mechanism reads
through the smoked glass without the housing obscuring it.
"""
import warnings, time, base64, io, os, math; warnings.filterwarnings("ignore")
import sys; sys.path.insert(0, "/Users/jackal-kahwati/EE-lab/tools/onshape")
from onshape_client import Client
from PIL import Image
import numpy as np

c = Client()
did, wid = "cfd5d2c28305575210ed8678", "6bf7390efd64f5e66777f769"
asm = "7ceec0160aa48f4a537b0558"
base = "/api/v6/assemblies/d/{}/w/{}/e/{}".format(did, wid, asm)

# camera: yaw 0 (front), pitch -12 = camera above, looking down/forward
yaw, pitch = math.radians(0), math.radians(-12)
f = np.array([math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch), math.sin(pitch)])
f /= np.linalg.norm(f)
r = np.cross(f, np.array([0, 0, 1.0])); r /= np.linalg.norm(r)
u = np.cross(r, f)
VM = ",".join("{:.6f}".format(v) for row in [r, u, -f] for v in list(row) + [0.0])

mv = c._request("GET", base + "/matevalues")
vals = {m["mateName"]: m for m in mv["mateValues"]}
park = {n: vals[n].get("translationZ", 0.0) for n in vals}
X, Y, Z = "Slider 2", "Slider 3", "Slider 1"

def set_values(d):
    c._request("POST", base + "/matevalues", json={"mateValues": [
        {"jsonType": "Slider", "featureId": vals[n]["featureId"],
         "ownerOccurrencePath": [], "translationZ": d[n]} for n in d]})

def frame():
    resp = c._request("GET", base + "/shadedviews",
        params={"viewMatrix": VM, "outputHeight": 600, "outputWidth": 800, "pixelSize": 0})
    return Image.open(io.BytesIO(base64.b64decode(resp["images"][0]))).convert("RGB")

# ---- real-speed trajectory -------------------------------------------------
FPS = 8
SPEED = {"x": 0.150, "y": 0.150, "z": 0.025}  # m/s
DWELL = 0.4                                   # settle pause at each waypoint

px, py, pz = park[X], park[Y], park[Z]
waypoints = [
    (px, py, pz),
    (0.268, py, pz),            # X to + end
    (-0.228, py, pz),           # X full sweep to - end
    (px, py, pz),               # X home
    (px, 0.198, pz),            # Y to + end
    (px, -0.198, pz),           # Y full sweep to - end
    (px, py, pz),               # Y home
    (px, py, 0.123),            # Z plunge
    (px, py, 0.027),            # Z full retract
    (px, py, pz),               # Z home
    (0.25, 0.18, 0.12),         # 3-axis corner pass
    (-0.2, -0.18, 0.05),        # opposite corner
    (px, py, pz),               # park
]

def seg_time(a, b):
    return max(abs(b[0] - a[0]) / SPEED["x"],
               abs(b[1] - a[1]) / SPEED["y"],
               abs(b[2] - a[2]) / SPEED["z"])

samples = [waypoints[0]]
for a, b in zip(waypoints, waypoints[1:]):
    T = seg_time(a, b)
    n = max(1, round(T * FPS))
    for i in range(1, n + 1):
        t = i / n
        samples.append(tuple(a[k] + (b[k] - a[k]) * t for k in range(3)))
    samples += [b] * round(DWELL * FPS)  # dwell = repeated frames, no re-render

total = len(samples)
print("real-speed sim: {} video frames = {:.1f}s at {} fps".format(
    total, total / FPS, FPS), flush=True)

outdir = "/tmp/sim_frames_real"
os.makedirs(outdir, exist_ok=True)
last_pos, last_img = None, None
rendered = 0
for i, pos in enumerate(samples):
    if pos != last_pos:
        set_values({X: pos[0], Y: pos[1], Z: pos[2]})
        time.sleep(0.5)
        last_img = frame()
        last_pos = pos
        rendered += 1
    last_img.save("{}/f{:04d}.png".format(outdir, i))
    if (i + 1) % 20 == 0 or i + 1 == total:
        print("frame {}/{} ({} rendered)".format(i + 1, total, rendered), flush=True)

set_values(park)
print("encoding...", flush=True)
dst = "/Users/jackal-kahwati/EE-lab/cad/electronics-bringup-station"
os.system("/opt/homebrew/bin/ffmpeg -y -framerate {fps} -i {d}/f%04d.png "
          "-c:v libx264 -pix_fmt yuv420p -crf 20 {o}/motion-sim.mp4 "
          "> /tmp/ffmpeg_sim.log 2>&1".format(fps=FPS, d=outdir, o=dst))
imgs = [Image.open("{}/f{:04d}.png".format(outdir, i)).resize((600, 450))
        for i in range(0, total, 2)]  # gif at 4 fps real-time
imgs[0].save(dst + "/motion-sim.gif", save_all=True, append_images=imgs[1:],
             duration=int(2000 / FPS), loop=0)
print("REAL-SPEED SIM COMPLETE", flush=True)
