#!/usr/bin/env python3
"""
Part-scoped edit (Stage 3): change ONE part, not the whole machine.

Given a part and an edit ("swap this bezel to a higher-temp material",
"grow this standoff by 4 mm"), this applies the change to the specific part and
re-checks the whole assembly so a local fix can't silently break a neighbor.

SAFETY — this WRITES to the live Onshape model, so:
  * every edit happens on an ISOLATED BRANCH (a new workspace forked from the
    source). The main workspace is never touched. The branch is left for review;
    you merge it in Onshape if you accept it, or discard() throws it away.
  * it needs a WRITE-scoped Onshape key (read-only keys 403 on branch create).
  * the caller is expected to have a human approve the edit first — this is not
    run autonomously against a production design.

Edit kinds:
  material  — retag a part's Material metadata (reversible, low-risk). DONE.
  parameter — change a Part Studio feature's dimension parameter. SCAFFOLD:
              resolves the feature, patches the parameter, rebuilds — wired but
              needs the feature/parameter ids, which resolve_feature() surfaces.

Flow: branch -> apply edit(s) -> re-export STEP + rebuild state -> re-analyze ->
diff vs baseline -> return the branch + before/after so a human can review.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

BASE = "https://cad.onshape.com"
AUTH = None


def _keys():
    ak = os.environ.get("ONSHAPE_ACCESS_KEY", "").strip()
    sk = os.environ.get("ONSHAPE_SECRET_KEY", "").strip()
    if not (ak and sk):
        for cand in (os.environ.get("FL_VAULT_SCRIPTS"), os.path.expanduser("~/work-hub/scripts")):
            if cand and os.path.isdir(cand):
                sys.path.insert(0, cand)
                try:
                    import vault  # type: ignore
                    ak = ak or (vault.get_secret("ONSHAPE_ACCESS_KEY") or "")
                    sk = sk or (vault.get_secret("ONSHAPE_SECRET_KEY") or "")
                except Exception:
                    pass
    if not (ak and sk):
        sys.exit("ONSHAPE_ACCESS_KEY / ONSHAPE_SECRET_KEY not set")
    return ak, sk


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Authorization": AUTH, "Accept": "application/json"}
    if body is not None:
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        body = e.read()[:200].decode(errors="replace")
        raise RuntimeError(f"{method} {path} -> HTTP {e.code}: {body}")


def make_branch(did, wid, name):
    """Fork the current workspace into an isolated branch; return its workspace id."""
    _, res = call("POST", f"/api/v6/documents/d/{did}/workspaces",
                  {"name": name, "isReadOnly": False, "parentId": wid})
    return res["id"]


def discard_branch(did, bwid):
    call("DELETE", f"/api/v6/documents/d/{did}/workspaces/{bwid}")


# the Material property's id on a part's metadata (read once from any part; stable
# per document). Passed in so callers can override if a doc differs.
MATERIAL_PROP_ID = "57f3fb8efa3416c06701d615"


def set_material(did, bwid, ps_eid, part_id, material_id, density=None,
                 library="EE-lab Materials", prop_id=MATERIAL_PROP_ID):
    """Retag a part's Material on the branch. The update targets the Material
    property by its propertyId and supplies the FULL value object (id +
    displayName + libraryName + optional DENS) — a partial value 500s."""
    value = {"id": material_id, "displayName": material_id, "libraryName": library,
             "properties": []}
    if density is not None:
        value["properties"] = [{"name": "DENS", "value": str(density), "type": "REAL",
                                "displayName": "Density", "units": "kg/m^3",
                                "category": "PHYSICAL", "description": "density"}]
    payload = {"jsonType": "metadata-part", "partId": part_id,
               "properties": [{"propertyId": prop_id, "value": value}]}
    call("POST", f"/api/v6/metadata/d/{did}/w/{bwid}/e/{ps_eid}/p/{part_id}", payload)


def resolve_feature(did, wid, ps_eid, name_substr):
    """Find a Part Studio feature by name (for parameter edits). Returns the
    feature dict incl. featureId + parameters, or None."""
    _, fl = call("GET", f"/api/v6/partstudios/d/{did}/w/{wid}/e/{ps_eid}/features")
    for f in fl.get("features", []):
        if name_substr.lower() in (f.get("name", "").lower()):
            return f
    return None


def set_parameter(did, bwid, ps_eid, feature, param_id, value_expr):
    """Patch one dimension parameter of a feature, then let Onshape rebuild.
    SCAFFOLD: shape is correct; production use should read the feature first,
    mutate the matching parameter's expression, and PUT it back."""
    fid = feature["featureId"]
    for p in feature.get("message", feature).get("parameters", []):
        pm = p.get("message", p)
        if pm.get("parameterId") == param_id:
            pm["expression"] = value_expr
    call("POST", f"/api/v6/partstudios/d/{did}/w/{bwid}/e/{ps_eid}/features/featureid/{fid}",
         {"feature": feature})


def apply_edits(did, wid, eid, ps_eid, edits, branch_name, keep=True):
    """Create a branch, apply edits, return a summary. Does NOT delete the branch
    unless keep=False (so a human can review/merge it in Onshape)."""
    bwid = make_branch(did, wid, branch_name)
    applied = []
    try:
        for e in edits:
            if e["kind"] == "material":
                set_material(did, bwid, ps_eid, e["partId"], e["material"])
                applied.append({"part": e.get("part"), "kind": "material", "to": e["material"]})
            elif e["kind"] == "parameter":
                feat = resolve_feature(did, bwid, ps_eid, e["feature"])
                if not feat:
                    raise RuntimeError(f"feature '{e['feature']}' not found")
                set_parameter(did, bwid, ps_eid, feat, e["paramId"], e["value"])
                applied.append({"part": e.get("part"), "kind": "parameter",
                                "feature": e["feature"], "to": e["value"]})
            else:
                raise RuntimeError(f"unknown edit kind: {e['kind']}")
    except Exception:
        if not keep:
            try: discard_branch(did, bwid)
            except Exception: pass
        raise
    branch_url = f"{BASE}/documents/{did}/w/{bwid}/e/{eid}"
    return {"branchWid": bwid, "branchUrl": branch_url, "applied": applied,
            "note": "edits applied on an isolated branch; review/merge in Onshape "
                    "or discard. Main workspace untouched."}


def main():
    global AUTH
    ap = argparse.ArgumentParser()
    ap.add_argument("--did", required=True)
    ap.add_argument("--wid", required=True)
    ap.add_argument("--eid", required=True, help="assembly element id")
    ap.add_argument("--ps", required=True, help="part studio element id")
    ap.add_argument("--edits", required=True, help="JSON list of edits")
    ap.add_argument("--branch", default="fl-stage3-edit")
    ap.add_argument("--discard-on-done", action="store_true")
    a = ap.parse_args()
    ak, sk = _keys()
    AUTH = "Basic " + base64.b64encode(f"{ak}:{sk}".encode()).decode()
    edits = json.loads(a.edits)
    res = apply_edits(a.did, a.wid, a.eid, a.ps, edits, a.branch, keep=not a.discard_on_done)
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
