import warnings, time, base64, io; warnings.filterwarnings("ignore")
import sys; sys.path.insert(0, "/Users/jackal-kahwati/EE-lab/tools/onshape")
from onshape_client import Client
from PIL import Image
c = Client()
did, wid = "02ed72e43f8d925e0c7aa678", "80299bfade6ea16b1cd86a0e"
PS = "8a871c2acd668dc865dda723"

# 1. fresh assembly with the CURRENT part studio (Main Assembly predates the EVT bodies)
existing = {e["name"]: e["id"] for e in c.list_elements(did, wid)
            if e["elementType"] == "ASSEMBLY"}
if "Motion Check" in existing:
    asm = existing["Motion Check"]
    print("reusing Motion Check assembly", flush=True)
else:
    asm = c.create_assembly(did, wid, "Motion Check")["id"]
    c.insert_instance(did, wid, asm, PS, whole_part_studio=True)
    print("created Motion Check assembly with full part studio", flush=True)
time.sleep(3)

# 2. instance map
adef = c._request("GET", "/api/v6/assemblies/d/{}/w/{}/e/{}".format(did, wid, asm))
instances = adef["rootAssembly"]["instances"]
print("instances:", len(instances), flush=True)

def base_name(inst):
    n = inst["name"]
    return n.rsplit(" <", 1)[0] if " <" in n else n

# 3. moving-group membership by part name
def in_x_group(n):
    if n.startswith("Y Axis - ") or n.startswith("Z Axis - "):
        return True
    if n.startswith("X Axis - ") and any(k in n for k in
            ("HGH20 Carriage Block", "Rail Saddle", "SFU1605 Ballnut",
             "Ballnut Flange", "Ballnut Housing")):
        return True
    if n in ("Moving X Beam", "Y Ballscrew", "Y Servo") or n.startswith("Y Rail "):
        return True
    if n.startswith("Y Drag Chain Link"):
        return True
    return False

def in_y_group(n):
    if n.startswith("Z Axis - "):
        return True
    if n.startswith("Y Axis - ") and any(k in n for k in
            ("HGH15 Carriage Block", "Carriage Adapter", "SFU1204 Ballnut",
             "Ballnut Housing")):
        return True
    if n in ("Y Carriage", "Z Stage Plate", "Z Stage Rail", "Z Stage Ballscrew",
             "Z Stage Slide", "Z Servo", "Probe Cable Loop"):
        return True
    if n.startswith(("Probe Cable Loop Link",)):
        return True
    return False

def in_z_group(n):
    if n.startswith("Z Axis - ") and any(k in n for k in
            ("MGN12H Block", "Slide Plate", "Probe Interface Pad",
             "Ballnut Housing", "SFU1204 Ballnut", "Ballnut Flange")):
        return True
    if n.startswith(("Probe Head", "Probe Cartridge", "Probe Camera",
                     "Probe Load Cell", "Probe Limit Tab", "Pogo ")):
        return True
    return False

x_ids, y_ids, z_ids = [], [], []
for inst in instances:
    n = base_name(inst)
    if in_z_group(n):
        z_ids.append(inst["id"])
    elif in_y_group(n):
        y_ids.append(inst["id"])
    elif in_x_group(n):
        x_ids.append(inst["id"])
print("group sizes: X-only {}, +Y {}, +Z {}".format(
    len(x_ids), len(y_ids), len(z_ids)), flush=True)

def set_group(ids, dx, dy, dz):
    if not ids:
        return
    c._request("POST",
               "/api/v6/assemblies/d/{}/w/{}/e/{}/occurrencetransforms".format(did, wid, asm),
               json={"occurrences": [{"path": [i]} for i in ids],
                     "transform": [1, 0, 0, dx / 1000.0,
                                   0, 1, 0, dy / 1000.0,
                                   0, 0, 1, dz / 1000.0,
                                   0, 0, 0, 1],
                     "isRelative": False})

ISO = "0.707107,0.707107,0,0,-0.408248,0.408248,0.816497,0,0.57735,-0.57735,0.57735,0"
def frame():
    r = c._request("GET",
        "/api/v6/assemblies/d/{}/w/{}/e/{}/shadedviews".format(did, wid, asm),
        params={"viewMatrix": ISO, "outputHeight": 480, "outputWidth": 640,
                "pixelSize": 0})
    return Image.open(io.BytesIO(base64.b64decode(r["images"][0]))).convert("P")

# 4. keyframe path: X sweep, Y sweep, Z plunge, corner combo, park
path = []
for x in (0, 125, 250, 125, 0, -125, -250, -125, 0):
    path.append((x, 0, 0))
for y in (100, 200, 100, 0, -100, -200, -100, 0):
    path.append((0, y, 0))
for z in (-25, -50, -25, 0, 25, 50, 25, 0):
    path.append((0, 0, z))
path += [(125, 100, -25), (250, 200, -50), (125, 100, -25), (0, 0, 0)]

frames = []
for i, (dx, dy, dz) in enumerate(path):
    set_group(x_ids, dx, 0, 0)
    set_group(y_ids, dx, dy, 0)
    set_group(z_ids, dx, dy, dz)
    frames.append(frame())
    print("frame {}/{} at ({}, {}, {})".format(i + 1, len(path), dx, dy, dz), flush=True)
    time.sleep(1)

# 5. reset to park and save GIF
for ids in (x_ids, y_ids, z_ids):
    set_group(ids, 0, 0, 0)
out = "/Users/jackal-kahwati/EE-lab/cad/electronics-bringup-station/motion-check.gif"
frames[0].save(out, save_all=True, append_images=frames[1:], duration=200, loop=0)
print("saved:", out, flush=True)
print("MOTION CHECK COMPLETE", flush=True)
