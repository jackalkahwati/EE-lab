"""Motion collision audit: pose-grid sweep of the three moving groups.

Fetches live bboxes once, classifies bodies into X-gantry / Y-carriage /
Z-stage moving groups (motion_check rules + post-freeze additions like
the warp scanner), then sweeps a pose grid over the full commanded
travel (dx +/-250, dy +/-200, dz -50..+50) LOCALLY (zero API cost per
pose) checking moving-vs-static and probe-vs-payload overlaps.

Also derives the correct plunge numbers from the actual pogo tip
geometry, and prints per-collision the offending pose window so travel
limits / hard stops / geometry fixes can be sized.
"""

from __future__ import annotations

import json
import os
import warnings

warnings.filterwarnings("ignore")

from features import FeatureBuilder
from onshape_client import Client

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"
SCRATCH = os.environ.get("SCRATCH", "/tmp")

# travel (mm), per the locked architecture
DX = (-250, 250)
DY = (-200, 200)
DZ = (-26, 50)
STEP = 25


def in_x_group(n):
    if n.startswith(("Y Axis - ", "Z Axis - ")):
        return True
    if n.startswith("X Axis - ") and any(k in n for k in (
            "HGH20 Carriage Block", "Rail Saddle", "SFU1605 Ballnut",
            "Ballnut Flange", "Ballnut Housing")):
        return True
    if n == "Moving X Beam" or n.startswith("Y Drag Chain Link"):
        return True
    return False


def in_y_group(n):
    if n.startswith("Z Axis - "):
        return True
    if n.startswith("Y Axis - ") and any(k in n for k in (
            "HGH15 Carriage Block", "Carriage Adapter", "SFU1204 Ballnut",
            "Ballnut Housing")):
        return True
    if n.startswith("Probe Cable Loop"):
        return True
    return False


def in_z_group(n):
    if n.startswith("Z Axis - ") and any(k in n for k in (
            "MGN12H Block", "Slide Plate", "Probe Interface Pad",
            "Ballnut Housing", "SFU1204 Ballnut", "Ballnut Flange")):
        return True
    if n.startswith(("Probe Head", "Probe Cartridge", "Probe Camera",
                     "Probe Load Cell", "Probe Limit Tab", "Probe Mount Arm",
                     "Probe Guide Pin", "Probe Hard Stop", "Probe Preload",
                     "Pogo ", "Cartridge Dowel")):
        return True
    if n == "Laser Warp Scanner 450nm":
        return True
    return False


def off(b, dx, dy, dz):
    return {"lowX": b["lowX"] + dx, "highX": b["highX"] + dx,
            "lowY": b["lowY"] + dy, "highY": b["highY"] + dy,
            "lowZ": b["lowZ"] + dz, "highZ": b["highZ"] + dz}


def ov(a, b, tol=0.05):
    return all(a["low" + d] < b["high" + d] - tol and
               a["high" + d] > b["low" + d] + tol for d in "XYZ")


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)
    boxes = fb.all_bboxes()
    with open(SCRATCH + "/motion_audit_bboxes.json", "w") as f:
        json.dump(boxes, f)

    xg, yg, zg, statics = {}, {}, {}, {}
    for n, b in boxes.items():
        if n.startswith(("Corridor", "ASM", "Analysis", "CFG",
                         "Swept", "X Rail ", "X Ballscrew", "X Servo",
                         "X Bearing", "Y Rail ", "Y Ballscrew", "Y Servo",
                         "Y Carriage", "Z Stage", "Z Servo",
                         "X Drag Chain", "Fastener Dowel")):
            continue        # analysis bodies + legacy envelopes
        if in_z_group(n):
            zg[n] = b
        elif in_y_group(n):
            yg[n] = b
        elif in_x_group(n):
            xg[n] = b
        else:
            statics[n] = b
    print("groups: X {} / Y {} / Z {} / statics {}".format(
        len(xg), len(yg), len(zg), len(statics)))

    # bbox-hollow statics whose box wildly overhangs their material:
    HOLLOW = {"Base Frame", "Side Shell Left", "Side Shell Right",
              "Trim - Front Sill", "Enclosure Top Rail Ring",
              "Equipment Tray", "Top Slab", "Enclosure Base Pan",
              "Rear Matte Black Panel", "Front Smoked Glass v2"}
    # legitimate at-contact pairs (probing the payload is the job):
    PAYLOAD = {n for n in statics if n.startswith((
        "Sample PCB", "PCB Component", "PCB Connector", "PCB Fixture Plate",
        "Adjustable Clamp", "Clamp Knob", "Fixture Locating",
        "Vacuum Port", "Calibration", "Probe Touch-Off",
        "Force Calibration", "Cartridge Cradle", "Cartridge Park"))}

    # pogo tip geometry -> correct plunge numbers
    tips = [b for n, b in boxes.items() if n.startswith("Pogo Probe Tip")]
    pad = boxes["Z Axis - Probe Interface Pad"]
    if tips:
        tip_bot = min(t["lowZ"] for t in tips)
        print("\npogo tips bottom at park Z={:.1f}; pad bottom Z={:.1f}; "
              "PCB top 59.6".format(tip_bot, pad["lowZ"]))
        dz_contact = 59.6 - tip_bot
        print("  -> tip contact at dz={:.1f}; +2 mm compliance -> working "
              "plunge dz={:.1f}".format(dz_contact, dz_contact - 2))
        print("  -> pad crashes into plate top (58) at dz={:.1f}  << HARD "
              "STOP must intervene above this".format(58 - pad["lowZ"]))

    # pose sweep
    hits = {}
    poses_x = list(range(DX[0], DX[1] + 1, STEP))
    poses_y = list(range(DY[0], DY[1] + 1, STEP))
    poses_z = list(range(DZ[0], DZ[1] + 1, STEP))
    for dx in poses_x:
        for dy in poses_y:
            for dz in poses_z:
                movers = (
                    [(n, off(b, dx, 0, 0)) for n, b in xg.items()] +
                    [(n, off(b, dx, dy, 0)) for n, b in yg.items()] +
                    [(n, off(b, dx, dy, dz)) for n, b in zg.items()])
                for n, mb in movers:
                    for sn, sb in statics.items():
                        if sn in HOLLOW:
                            continue
                        if sn in PAYLOAD and dz > -30:
                            continue    # payload contact only matters plunged
                        if ov(mb, sb):
                            key = (n, sn)
                            v = hits.setdefault(key, [set(), set(), set()])
                            v[0].add(dx); v[1].add(dy); v[2].add(dz)
    print("\n=== colliding pairs over the pose grid ===")
    if not hits:
        print("  none")
    for (n, sn), (sx, sy, sz) in sorted(hits.items()):
        print("  {} <-> {}".format(n, sn))
        print("      dx {}..{}  dy {}..{}  dz {}..{}".format(
            min(sx), max(sx), min(sy), max(sy), min(sz), max(sz)))

    # focused: overhead camera arm vs Z tower (tall movers, any dz)
    print("\n=== tall-mover check vs overhead assembly ===")
    arm = boxes.get("Overhead Camera Bracket Center")
    for n, b in list(yg.items()) + list(zg.items()):
        if b["highZ"] < 300:
            continue
        rng_x = (arm["lowX"] - b["highX"], arm["highX"] - b["lowX"])
        rng_y = (arm["lowY"] - b["highY"], arm["highY"] - b["lowY"])
        fx = (max(rng_x[0], DX[0]), min(rng_x[1], DX[1]))
        fy = (max(rng_y[0], DY[0]), min(rng_y[1], DY[1]))
        if fx[0] <= fx[1] and fy[0] <= fy[1] and b["highZ"] > arm["lowZ"]:
            print("  {} (top Z {:.0f}) hits arm for dx {}..{}, dy {}..{}".format(
                n, b["highZ"], fx[0], fx[1], fy[0], fy[1]))


if __name__ == "__main__":
    main()
