import warnings, time, base64, io, os; warnings.filterwarnings("ignore")
import sys; sys.path.insert(0, "/Users/jackal-kahwati/EE-lab/tools/onshape")
from onshape_client import Client
from PIL import Image
c = Client()
did, wid = "cfd5d2c28305575210ed8678", "6bf7390efd64f5e66777f769"
asm = "7ceec0160aa48f4a537b0558"
base = "/api/v6/assemblies/d/{}/w/{}/e/{}".format(did, wid, asm)

mv = c._request("GET", base + "/matevalues")
vals = {m["mateName"]: m for m in mv["mateValues"]}
park = {n: vals[n].get("translationZ", 0.0) for n in vals}
print("park values:", {k: round(v, 4) for k, v in park.items()}, flush=True)
# axis mapping from calibration: Slider 2 = X (limits -0.230..0.270, park 0.020)
#                                Slider 3 = Y (limits -0.200..0.200, park 0.0)
#                                Slider 1 = Z (limits 0.025..0.125, park 0.075)
X, Y, Z = "Slider 2", "Slider 3", "Slider 1"

def set_values(d):
    c._request("POST", base + "/matevalues", json={"mateValues": [
        {"jsonType": "Slider", "featureId": vals[n]["featureId"],
         "ownerOccurrencePath": [], "translationZ": d[n]} for n in d]})

ISO = "0.707107,0.707107,0,0,-0.408248,0.408248,0.816497,0,0.57735,-0.57735,0.57735,0"
def frame():
    r = c._request("GET", base + "/shadedviews",
        params={"viewMatrix": ISO, "outputHeight": 600, "outputWidth": 800,
                "pixelSize": 0})
    return Image.open(io.BytesIO(base64.b64decode(r["images"][0]))).convert("RGB")

def lerp(a, b, t): return a + (b - a) * t

# choreography in (x, y, z) mate-value space, fractions of available travel
def seq():
    keys = []
    px, py, pz = park[X], park[Y], park[Z]
    # X full sweep: park -> +max -> -min -> park
    for t in [0, .33, .66, 1]: keys.append((lerp(px, 0.268, t), py, pz))
    for t in [.25, .5, .75, 1]: keys.append((lerp(0.268, -0.228, t), py, pz))
    for t in [.33, .66, 1]: keys.append((lerp(-0.228, px, t), py, pz))
    # Y full sweep
    for t in [.33, .66, 1]: keys.append((px, lerp(py, 0.198, t), pz))
    for t in [.25, .5, .75, 1]: keys.append((px, lerp(0.198, -0.198, t), pz))
    for t in [.33, .66, 1]: keys.append((px, lerp(-0.198, py, t), pz))
    # Z plunge: park (0.075) -> 0.123 (down) -> 0.027 (up) -> park
    for t in [.5, 1]: keys.append((px, py, lerp(pz, 0.123, t)))
    for t in [.33, .66, 1]: keys.append((px, py, lerp(0.123, 0.027, t)))
    for t in [.5, 1]: keys.append((px, py, lerp(0.027, pz, t)))
    # combined corner move: probe travels diagonally + plunges
    for t in [.33, .66, 1]:
        keys.append((lerp(px, 0.25, t), lerp(py, 0.18, t), lerp(pz, 0.12, t)))
    for t in [.33, .66, 1]:
        keys.append((lerp(0.25, -0.2, t), lerp(0.18, -0.18, t), lerp(0.12, 0.05, t)))
    for t in [.33, .66, 1]:
        keys.append((lerp(-0.2, px, t), lerp(-0.18, py, t), lerp(0.05, pz, t)))
    return keys

frames = []
keys = seq()
print("rendering {} frames".format(len(keys)), flush=True)
for i, (x, y, z) in enumerate(keys):
    set_values({X: x, Y: y, Z: z})
    time.sleep(0.8)
    frames.append(frame())
    print("frame {}/{} x={:.0f} y={:.0f} z={:.0f} mm".format(
        i + 1, len(keys), x * 1000, y * 1000, z * 1000), flush=True)

# return to park
set_values(park)
print("returned to park", flush=True)

outdir = "/tmp/sim_frames"
os.makedirs(outdir, exist_ok=True)
for i, f in enumerate(frames):
    f.save("{}/f{:03d}.png".format(outdir, i))
print("frames saved to", outdir, flush=True)
print("SIM RENDER COMPLETE", flush=True)
