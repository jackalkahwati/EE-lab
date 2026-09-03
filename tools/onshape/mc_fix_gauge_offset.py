"""Fix the gauge-offset mismatch for the Phase E instances in Motion Check.

The assembly's Static Frame group solved with a global gauge offset
(0, +320, -62.5) mm from modeled coordinates (nothing is Fixed, so the
solver chose it long ago). Fresh instances insert at modeled position
(identity), so the 14 Phase E bodies appeared floating 320 mm away from
the machine and were then locked there by the group add.

Sequence (safe, no slider mates touched):
  1. remove the 14 entries from Group - Static Frame
  2. occurrencetransforms the now-unmated instances to Base Frame's exact
     occurrence transform (legal move on unmated instances -> sticks)
  3. re-add them to the group (locks the now-correct relative pose)
  4. verify park values + transforms + render
"""

from __future__ import annotations

import base64
import os
import time
import warnings

warnings.filterwarnings("ignore")

from urllib.parse import quote

from onshape_client import Client
from phase_e_production import NEW_PARTS

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
ASM = "d6767f7eb804454caaa2dc85"
BASE = "/api/v6/assemblies/d/{}/w/{}/e/{}".format(DID, WID, ASM)
SCRATCH = os.environ.get("SCRATCH", "/tmp")


def base_name(inst):
    n = inst["name"]
    return n.rsplit(" <", 1)[0] if " <" in n else n


def group_update(c, feats, group):
    c._request("POST", BASE + "/features/featureid/{}".format(
        quote(group["featureId"], safe="")),
        json={"btType": "BTFeatureDefinitionCall-1406", "feature": group,
              "serializationVersion": feats.get("serializationVersion"),
              "sourceMicroversion": feats.get("sourceMicroversion"),
              "libraryVersion": feats.get("libraryVersion")})


def main() -> None:
    c = Client()
    adef = c._request("GET", BASE)
    insts = adef["rootAssembly"]["instances"]
    new_ids = {}
    ref_id = None
    for i in insts:
        n = base_name(i)
        if n in NEW_PARTS:
            new_ids.setdefault(n, i["id"])
        if n == "Base Frame":
            ref_id = i["id"]
    occ = {tuple(o["path"])[0]: o["transform"]
           for o in adef["rootAssembly"]["occurrences"] if len(o["path"]) == 1}
    ref_t = occ[ref_id]
    print("reference transform (Base Frame): T=({:.1f}, {:.1f}, {:.1f}) mm".format(
        ref_t[3] * 1000, ref_t[7] * 1000, ref_t[11] * 1000))

    ids = list(new_ids.values())
    need_move = [i for i in ids if any(
        abs(occ[i][k] - ref_t[k]) > 1e-6 for k in (3, 7, 11))]
    print("instances needing move: {} / {}".format(len(need_move), len(ids)))
    if not need_move:
        print("nothing to do")
        return

    # park before
    mv = c._request("GET", BASE + "/matevalues")
    park = {m["mateName"]: (m["featureId"], m.get("translationZ", 0.0))
            for m in mv["mateValues"]}

    # 1. remove from group
    feats = c._request("GET", BASE + "/features")
    group = next(f for f in feats["features"]
                 if f.get("name") == "Group - Static Frame")
    qparam = next(p for p in group["parameters"]
                  if p.get("parameterId") == "occurrencesQuery")
    before = len(qparam["queries"])
    drop = set(need_move)
    qparam["queries"] = [q for q in qparam["queries"]
                         if tuple(q.get("path", []))[:1] != () and
                         q["path"][0] not in drop]
    print("group: {} -> {} entries (removed {})".format(
        before, len(qparam["queries"]), before - len(qparam["queries"])))
    group_update(c, feats, group)
    time.sleep(3)

    # 2. move unmated instances to the group frame
    c._request("POST", BASE + "/occurrencetransforms",
               json={"occurrences": [{"path": [i]} for i in need_move],
                     "transform": ref_t, "isRelative": False})
    print("transforms applied")
    time.sleep(3)

    # verify the move stuck
    adef2 = c._request("GET", BASE)
    occ2 = {tuple(o["path"])[0]: o["transform"]
            for o in adef2["rootAssembly"]["occurrences"] if len(o["path"]) == 1}
    bad = [i for i in need_move if any(
        abs(occ2[i][k] - ref_t[k]) > 1e-6 for k in (3, 7, 11))]
    if bad:
        raise SystemExit("transforms did not stick for {} instances — "
                         "NOT re-adding to group".format(len(bad)))
    print("all {} moves verified".format(len(need_move)))

    # 3. re-add to group
    feats = c._request("GET", BASE + "/features")
    group = next(f for f in feats["features"]
                 if f.get("name") == "Group - Static Frame")
    qparam = next(p for p in group["parameters"]
                  if p.get("parameterId") == "occurrencesQuery")
    have = {q["path"][0] for q in qparam["queries"] if q.get("path")}
    for i in ids:
        if i not in have:
            qparam["queries"].append({
                "btType": "BTMIndividualOccurrenceQuery-626", "path": [i]})
    group_update(c, feats, group)
    print("group re-add: {} entries total".format(len(qparam["queries"])))
    time.sleep(3)

    # 4. park drift check + final positions
    mv2 = c._request("GET", BASE + "/matevalues")
    drift = [(m["mateName"], park[m["mateName"]][0], park[m["mateName"]][1],
              m.get("translationZ", 0.0))
             for m in mv2["mateValues"]
             if m["mateName"] in park and
             abs(m.get("translationZ", 0.0) - park[m["mateName"]][1]) > 1e-6]
    if drift:
        print("park drifted, restoring:", [(d[0], round(d[3], 4)) for d in drift])
        c._request("POST", BASE + "/matevalues", json={"mateValues": [
            {"jsonType": "Slider", "featureId": fid,
             "ownerOccurrencePath": [], "translationZ": val}
            for _, fid, val, _ in drift]})
    else:
        print("park unchanged")

    adef3 = c._request("GET", BASE)
    occ3 = {tuple(o["path"])[0]: o["transform"]
            for o in adef3["rootAssembly"]["occurrences"] if len(o["path"]) == 1}
    still_bad = [n for n, i in new_ids.items() if any(
        abs(occ3[i][k] - ref_t[k]) > 1e-6 for k in (3, 7, 11))]
    print("final check — misplaced instances:", still_bad if still_bad else "NONE")

    iso = "0.707107,0.707107,0,0,-0.408248,0.408248,0.816497,0,0.57735,-0.57735,0.57735,0"
    r = c._request("GET", BASE + "/shadedviews",
                   params={"viewMatrix": iso, "outputHeight": 900,
                           "outputWidth": 1200, "pixelSize": 0})
    with open(SCRATCH + "/motion_check_prod_fixed.png", "wb") as f:
        f.write(base64.b64decode(r["images"][0]))
    print("render saved:", SCRATCH + "/motion_check_prod_fixed.png")
    print("GAUGE FIX COMPLETE")


if __name__ == "__main__":
    main()
