import warnings, time, base64, io, os, math; warnings.filterwarnings("ignore")
import sys; sys.path.insert(0, "/Users/jackal-kahwati/EE-lab/tools/onshape")
from onshape_client import Client
from PIL import Image
import numpy as np
c = Client()
did, wid = "cfd5d2c28305575210ed8678", "6bf7390efd64f5e66777f769"
asm = "7ceec0160aa48f4a537b0558"
base = "/api/v6/assemblies/d/{}/w/{}/e/{}".format(did, wid, asm)

yaw, pitch = math.radians(0), math.radians(10)
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

def lerp(a, b, t): return a + (b - a) * t

keys = []
px, py, pz = park[X], park[Y], park[Z]
for t in [0, .33, .66, 1]: keys.append((lerp(px, 0.268, t), py, pz))
for t in [.25, .5, .75, 1]: keys.append((lerp(0.268, -0.228, t), py, pz))
for t in [.33, .66, 1]: keys.append((lerp(-0.228, px, t), py, pz))
for t in [.33, .66, 1]: keys.append((px, lerp(py, 0.198, t), pz))
for t in [.25, .5, .75, 1]: keys.append((px, lerp(0.198, -0.198, t), pz))
for t in [.33, .66, 1]: keys.append((px, lerp(-0.198, py, t), pz))
for t in [.5, 1]: keys.append((px, py, lerp(pz, 0.123, t)))
for t in [.33, .66, 1]: keys.append((px, py, lerp(0.123, 0.027, t)))
for t in [.5, 1]: keys.append((px, py, lerp(0.027, pz, t)))
for t in [.33, .66, 1]:
    keys.append((lerp(px, 0.25, t), lerp(py, 0.18, t), lerp(pz, 0.12, t)))
for t in [.33, .66, 1]:
    keys.append((lerp(0.25, -0.2, t), lerp(0.18, -0.18, t), lerp(0.12, 0.05, t)))
for t in [.33, .66, 1]:
    keys.append((lerp(-0.2, px, t), lerp(-0.18, py, t), lerp(0.05, pz, t)))

frames = []
print("rendering {} frames (front view)".format(len(keys)), flush=True)
for i, (x, y, z) in enumerate(keys):
    set_values({X: x, Y: y, Z: z})
    time.sleep(0.8)
    frames.append(frame())
    print("frame {}/{}".format(i + 1, len(keys)), flush=True)
set_values(park)
outdir = "/tmp/sim_frames2"
os.makedirs(outdir, exist_ok=True)
for i, fimg in enumerate(frames):
    fimg.save("{}/f{:03d}.png".format(outdir, i))
print("SIM2 COMPLETE", flush=True)
