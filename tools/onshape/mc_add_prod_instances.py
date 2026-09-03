"""Add the Phase E production bodies to the Motion Check assembly.

Inserts the 14 new part instances (E-stop, door hardware, grounding
studs, calibration assets) and appends them to the "Group - Static
Frame" mate group — the same path the Phase A freeze used for the 25
EVT-2 instances. Mate GROUP round-trip updates are safe (no unit params;
the slider-mate corruption mode does not apply). Slider mates are never
touched; park values are captured before and restored if the re-solve
drifts them.

Idempotent: instances already present are not re-inserted; group entries
already present are not duplicated.
"""

from __future__ import annotations

import base64
import io
import json
import os
import time
import warnings

warnings.filterwarnings("ignore")

from urllib.parse import quote

from onshape_client import Client
from phase_e_production import NEW_PARTS

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
PS = "8a871c2acd668dc865dda723"
ASM = "d6767f7eb804454caaa2dc85"

SCRATCH = os.environ.get("SCRATCH", "/tmp")
BASE = "/api/v6/assemblies/d/{}/w/{}/e/{}".format(DID, WID, ASM)


def base_name(inst):
    n = inst["name"]
    return n.rsplit(" <", 1)[0] if " <" in n else n


def main() -> None:
    c = Client()
    targets = list(NEW_PARTS)

    parts = {p["name"]: p["partId"] for p in c.list_parts(DID, WID, PS)
             if p.get("bodyType") != "composite"}
    missing = [n for n in targets if n not in parts]
    if missing:
        raise SystemExit("parts not in studio: {}".format(missing))

    adef = c._request("GET", BASE)
    have = {base_name(i) for i in adef["rootAssembly"]["instances"]}
    to_insert = [n for n in targets if n not in have]
    print("instances present: {}, inserting: {}".format(
        len(have), len(to_insert)))

    for n in to_insert:
        c.insert_instance(DID, WID, ASM, PS, part_id=parts[n])
        print("  inserted", n, flush=True)
        time.sleep(1.5)

    # park values BEFORE the group edit
    mv = c._request("GET", BASE + "/matevalues")
    park = {m["mateName"]: (m["featureId"], m.get("translationZ", 0.0))
            for m in mv["mateValues"]}
    print("park:", {k: round(v[1], 4) for k, v in park.items()})

    # fresh instance map
    adef = c._request("GET", BASE)
    inst_ids = {}
    for i in adef["rootAssembly"]["instances"]:
        inst_ids.setdefault(base_name(i), i["id"])
    new_ids = {n: inst_ids[n] for n in targets if n in inst_ids}
    if len(new_ids) != len(targets):
        raise SystemExit("missing instances after insert: {}".format(
            set(targets) - set(new_ids)))

    # append to Static Frame mate group
    feats = c._request("GET", BASE + "/features")
    group = next(f for f in feats["features"]
                 if f.get("name") == "Group - Static Frame")
    qparam = next(p for p in group["parameters"]
                  if p.get("parameterId") == "occurrencesQuery")
    in_group = {tuple(q.get("path", [])) for q in qparam.get("queries", [])}
    added = 0
    for n, iid in new_ids.items():
        if (iid,) in in_group:
            continue
        qparam["queries"].append({
            "btType": "BTMIndividualOccurrenceQuery-626", "path": [iid]})
        added += 1
    print("group entries: {} existing, {} appended".format(
        len(in_group), added))
    if added:
        c._request(
            "POST", BASE + "/features/featureid/{}".format(
                quote(group["featureId"], safe="")),
            json={"btType": "BTFeatureDefinitionCall-1406",
                  "feature": group,
                  "serializationVersion": feats.get("serializationVersion"),
                  "sourceMicroversion": feats.get("sourceMicroversion"),
                  "libraryVersion": feats.get("libraryVersion")})
        print("Static Frame group updated")
        time.sleep(3)

    # park drift check + restore
    mv2 = c._request("GET", BASE + "/matevalues")
    drift = []
    for m in mv2["mateValues"]:
        want = park.get(m["mateName"])
        if want and abs(m.get("translationZ", 0.0) - want[1]) > 1e-6:
            drift.append((m["mateName"], want[0], want[1],
                          m.get("translationZ", 0.0)))
    if drift:
        print("park drifted, restoring:", [(d[0], round(d[3], 4)) for d in drift])
        c._request("POST", BASE + "/matevalues", json={"mateValues": [
            {"jsonType": "Slider", "featureId": fid,
             "ownerOccurrencePath": [], "translationZ": val}
            for _, fid, val, _ in drift]})
    else:
        print("park unchanged")

    # verification render
    iso = "0.707107,0.707107,0,0,-0.408248,0.408248,0.816497,0,0.57735,-0.57735,0.57735,0"
    r = c._request("GET", BASE + "/shadedviews",
                   params={"viewMatrix": iso, "outputHeight": 900,
                           "outputWidth": 1200, "pixelSize": 0})
    png = base64.b64decode(r["images"][0])
    out = SCRATCH + "/motion_check_prod.png"
    with open(out, "wb") as f:
        f.write(png)
    print("render saved:", out)
    print("MC ADD PROD INSTANCES COMPLETE")


if __name__ == "__main__":
    main()
