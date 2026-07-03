"""Production pass probe (read-only, 3 API calls).

1. all_bboxes -> scratchpad JSON (basis for the fix pass + local analysis)
2. one FeatureScript eval: TRUE minimum distances (evDistance) for the two
   suspect pairs — ballnut flange vs saddle (freeze watch item) and X motor
   body vs right shell (bbox says -1.0 mm)
3. massproperties (group) -> total mass + CoG for the D5 release report
"""
import json
import os
import warnings

warnings.filterwarnings("ignore")

from features import FeatureBuilder
from onshape_client import Client

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"

OUT = os.environ.get("SCRATCH", "/tmp") + "/prod_probe"

PAIRS = [
    ("X Axis - Ballnut Flange", "X Axis - Rail Saddle Front"),
    ("X Axis - NEMA23 Motor Body", "Side Shell Right"),
    ("X Axis - Motor Mount Plate", "Side Shell Right"),
    ("X Axis - Motor Shaft", "X Axis - Screw Journal"),
]

DIST_SCRIPT = """
function(context is Context, queries is map)
{
    var names = %s;
    var out = [];
    for (var pair in names)
    {
        var qa = qNothing();
        var qb = qNothing();
        for (var body in evaluateQuery(context, qBodyType(qEverything(EntityType.BODY), BodyType.SOLID)))
        {
            var nm = getProperty(context, {"entity": body, "propertyType": PropertyType.NAME});
            if (nm == pair[0]) { qa = body; }
            if (nm == pair[1]) { qb = body; }
        }
        try
        {
            var d = evDistance(context, {"side0": qa, "side1": qb});
            out = append(out, {"a": pair[0], "b": pair[1], "mm": d.distance / millimeter});
        }
        catch (e)
        {
            out = append(out, {"a": pair[0], "b": pair[1], "mm": -999});
        }
    }
    return out;
}
"""


def decode(v):
    if isinstance(v, dict):
        if "message" in v:
            return decode(v["message"])
        if "key" in v:
            return (decode(v["key"]), decode(v.get("value")))
        if "value" in v:
            return decode(v["value"])
        return v
    if isinstance(v, list):
        items = [decode(i) for i in v]
        if items and all(isinstance(i, tuple) and len(i) == 2 for i in items):
            return dict(items)
        return items
    return v


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)

    boxes = fb.all_bboxes()
    with open(OUT + "_bboxes.json", "w") as f:
        json.dump(boxes, f, indent=1)
    print("bboxes saved:", len(boxes))

    pairs_fs = "[" + ", ".join(
        '["{}", "{}"]'.format(a, b) for a, b in PAIRS) + "]"
    resp = fb.c._request(
        "POST", fb._base + "/featurescript",
        json={"script": DIST_SCRIPT % pairs_fs, "queries": {}})
    rows = decode(resp.get("result"))
    print("\n=== true minimum distances (evDistance) ===")
    for row in rows or []:
        if isinstance(row, dict):
            print("  {:.3f} mm  {} <-> {}".format(row["mm"], row["a"], row["b"]))

    mp = fb.c._request(
        "GET", "/api/v6/partstudios/d/{}/w/{}/e/{}/massproperties".format(
            DID, WID, EID), params={"massAsGroup": "true"})
    with open(OUT + "_massprops.json", "w") as f:
        json.dump(mp, f, indent=1)
    bodies = mp.get("bodies", {})
    grp = bodies.get("-all-") or next(iter(bodies.values()), {})
    mass = grp.get("mass", [None])[0]
    cg = grp.get("centroid", [None, None, None])[:3]
    if mass is not None:
        print("\n=== mass properties (parts with density) ===")
        print("  total mass: {:.2f} kg".format(mass))
        print("  CoG: X={:.1f} Y={:.1f} Z={:.1f} mm".format(
            cg[0] * 1000, cg[1] * 1000, cg[2] * 1000))
    else:
        print("\nmassproperties keys:", list(mp.keys()), list(bodies.keys())[:5])


if __name__ == "__main__":
    main()
