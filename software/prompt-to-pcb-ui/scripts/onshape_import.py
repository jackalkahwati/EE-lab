#!/usr/bin/env python3
"""
Live parametric Onshape importer (Stage 1 of the geometry-in pipeline).

Unlike a dead STEP, this reads the *live* Onshape assembly through the API and
builds a per-part DESIGN-STATE MAP: every instanced part, its Part Studio +
feature handle (so a single part can later be regenerated on its own), its
material + density, mass, volume, centroid, and bounding box, plus the
occurrence transform that places it in the machine.

The map is the foundation the rest of the stages key off:
  Stage 2 (analysis) attributes clashes / FEA findings to these parts.
  Stage 3 (edit router) modifies ONE part's features via its partStudio handle.
  Stage 4 (co-design) places new instances (e.g. the FL-1 PCBA) into this graph.

Auth: ONSHAPE_ACCESS_KEY / ONSHAPE_SECRET_KEY in the environment (HTTP Basic).
CLI:  onshape_import.py --did D --wid W --eid E [--out state.json] [--no-bbox]
      IDs may instead be given as a single --url <onshape assembly url>.
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures as cf
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

BASE = "https://cad.onshape.com"


def _keys() -> tuple[str, str]:
    """Onshape keys from env; fall back to the work-hub sops+age vault so this
    runs both from a shell (env) and from the app (vault) without duplicating
    the secret into a plaintext .env."""
    ak = os.environ.get("ONSHAPE_ACCESS_KEY", "").strip()
    sk = os.environ.get("ONSHAPE_SECRET_KEY", "").strip()
    if ak and sk:
        return ak, sk
    for cand in (os.environ.get("FL_VAULT_SCRIPTS"), os.path.expanduser("~/work-hub/scripts")):
        if cand and os.path.isdir(cand):
            sys.path.insert(0, cand)
            try:
                import vault  # type: ignore
                ak = ak or (vault.get_secret("ONSHAPE_ACCESS_KEY") or "")
                sk = sk or (vault.get_secret("ONSHAPE_SECRET_KEY") or "")
                if ak and sk:
                    return ak, sk
            except Exception:
                pass
    sys.exit("ONSHAPE_ACCESS_KEY / ONSHAPE_SECRET_KEY not set (env or vault)")


def _auth_header() -> str:
    ak, sk = _keys()
    return "Basic " + base64.b64encode(f"{ak}:{sk}".encode()).decode()


def export_step(did, wid, eid, out_path) -> int:
    """Export the assembly as a STEP file; returns bytes written."""
    data = json.dumps({"formatName": "STEP", "storeInDocument": False,
                       "flattenAssemblies": True}).encode()
    req = urllib.request.Request(
        BASE + f"/api/v6/assemblies/d/{did}/w/{wid}/e/{eid}/translations",
        data=data, method="POST",
        headers={"Authorization": AUTH, "Accept": "application/json",
                 "Content-Type": "application/json"})
    tid = json.loads(urllib.request.urlopen(req, timeout=90).read()).get("id")
    for _ in range(80):
        time.sleep(3)
        st = api(f"/api/v6/translations/{tid}")
        state = st.get("requestState")
        if state == "DONE":
            ext = (st.get("resultExternalDataIds") or [None])[0]
            blob_req = urllib.request.Request(
                BASE + f"/api/v6/documents/d/{did}/externaldata/{ext}",
                headers={"Authorization": AUTH})
            blob = urllib.request.urlopen(blob_req, timeout=120).read()
            with open(out_path, "wb") as f:
                f.write(blob)
            return len(blob)
        if state and state != "ACTIVE":
            raise RuntimeError(f"STEP translation {state}: {json.dumps(st)[:200]}")
    raise RuntimeError("STEP translation timed out")


AUTH = None  # set in main


def api(path: str, retries: int = 6):
    """GET a JSON API path, with exponential backoff on 429/5xx. Honors the
    Retry-After header so a rate-limited batch waits out the window instead of
    hammering (and silently dropping data)."""
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(
            BASE + path, headers={"Authorization": AUTH, "Accept": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}: {e.read()[:120].decode(errors='replace')}"
            if e.code in (429, 500, 502, 503):
                ra = e.headers.get("Retry-After") if e.headers else None
                try:
                    wait = float(ra) if ra else min(2 ** attempt, 30)
                except ValueError:
                    wait = min(2 ** attempt, 30)
                time.sleep(wait + 0.25)
                continue
            raise RuntimeError(f"{path} -> {last}")
        except Exception as e:  # noqa: BLE001 - transient network
            last = str(e)
            time.sleep(min(2 ** attempt, 20))
    raise RuntimeError(f"{path} -> {last}")


def parse_url(url: str) -> tuple[str, str, str]:
    """Pull did / wid / eid out of an Onshape document URL."""
    m = re.search(r"/documents/([0-9a-f]+)/w/([0-9a-f]+)/e/([0-9a-f]+)", url)
    if not m:
        sys.exit(f"could not parse Onshape url: {url}")
    return m.group(1), m.group(2), m.group(3)


def _mm(vals, n=3):
    """meters -> mm, rounded; Onshape geometry is in meters."""
    return [round(v * 1000.0, 3) for v in vals[:n]]


def part_mass(did, wid, ps_eid, part_id):
    """(partId, {massKg, volumeMm3, centroidMm}) for one part; None on failure."""
    try:
        mp = api(f"/api/v6/parts/d/{did}/w/{wid}/e/{ps_eid}/partid/{part_id}/massproperties")
        body = next(iter(mp.get("bodies", {}).values()), None)
        if not body:
            return part_id, None
        return part_id, {
            "massKg": round(body.get("mass", [0])[0], 6),
            "volumeMm3": round(body.get("volume", [0])[0] * 1e9, 3),
            "centroidMm": _mm(body.get("centroid", [0, 0, 0])),
        }
    except Exception:
        return part_id, None


def part_bbox(did, wid, ps_eid, part_id):
    """(partId, {bboxMm:[lx,ly,lz], minMm, maxMm}) for one part; None on failure."""
    try:
        bb = api(f"/api/v6/parts/d/{did}/w/{wid}/e/{ps_eid}/partid/{part_id}/boundingboxes")
        lo = [bb["lowX"], bb["lowY"], bb["lowZ"]]
        hi = [bb["highX"], bb["highY"], bb["highZ"]]
        return part_id, {
            "minMm": _mm(lo), "maxMm": _mm(hi),
            "sizeMm": [round((hi[i] - lo[i]) * 1000.0, 3) for i in range(3)],
        }
    except Exception:
        return part_id, None


def build_state(did, wid, eid, with_bbox=True, jobs=6):
    # 1) assembly definition: instances (name, partId, partStudio) + transforms + mates
    asm = api(f"/api/v6/assemblies/d/{did}/w/{wid}/e/{eid}"
              f"?includeMateFeatures=true&includeNonSolids=false")
    root = asm.get("rootAssembly", {})
    instances = [i for i in root.get("instances", []) if i.get("type") == "Part"]
    occ = {tuple(o["path"]): o for o in root.get("occurrences", [])}
    mate_count = len(root.get("features", []))

    # which Part Studios are referenced (usually one multi-body studio)
    ps_eids = sorted({i.get("elementId") for i in instances if i.get("elementId")})

    # 2) parts-list (one call per studio): name, material (+density), appearance
    part_meta: dict[tuple[str, str], dict] = {}
    for ps in ps_eids:
        for p in api(f"/api/v6/parts/d/{did}/w/{wid}/e/{ps}"):
            mat = p.get("material") or {}
            dens = None
            for pr in (mat.get("properties") or []):
                if pr.get("name") == "DENS":
                    try:
                        dens = float(pr.get("value"))
                    except (TypeError, ValueError):
                        dens = None
            part_meta[(ps, p.get("partId"))] = {
                "materialName": mat.get("displayName"),
                "densityKgM3": dens,
                "bodyType": p.get("bodyType"),
            }

    # 3) per-part mass + bbox, in parallel (301 parts -> ~seconds)
    keys = [(i.get("elementId"), i.get("partId")) for i in instances if i.get("partId")]
    uniq = sorted(set(keys))
    mass_by: dict[tuple[str, str], dict] = {}
    bbox_by: dict[tuple[str, str], dict] = {}
    with cf.ThreadPoolExecutor(max_workers=jobs) as ex:
        futs = {ex.submit(part_mass, did, wid, ps, pid): (ps, pid) for ps, pid in uniq}
        if with_bbox:
            futs.update({ex.submit(part_bbox, did, wid, ps, pid): ("bb", ps, pid)
                         for ps, pid in uniq})
        for fut in cf.as_completed(futs):
            tag = futs[fut]
            pid, data = fut.result()
            if data is None:
                continue
            if tag[0] == "bb":
                bbox_by[(tag[1], tag[2])] = data
            else:
                mass_by[(tag[0], pid)] = data

    # 4) stitch per-part records
    parts = []
    mat_hist: dict[str, int] = {}
    total_mass = 0.0
    for inst in instances:
        ps = inst.get("elementId")
        pid = inst.get("partId")
        meta = part_meta.get((ps, pid), {})
        mass = mass_by.get((ps, pid), {})
        bbox = bbox_by.get((ps, pid), {})
        path = tuple(inst.get("path", [inst.get("id")])) if inst.get("path") else (inst.get("id"),)
        o = occ.get((inst.get("id"),)) or occ.get(path) or {}
        m = mass.get("massKg")
        if isinstance(m, (int, float)):
            total_mass += m
        mn = meta.get("materialName") or "unspecified"
        mat_hist[mn] = mat_hist.get(mn, 0) + 1
        parts.append({
            "name": re.sub(r"\s*<\d+>\s*$", "", inst.get("name", "")).strip(),
            "instanceName": inst.get("name"),
            "partId": pid,
            "partStudioEid": ps,          # Stage 3 edit handle: the studio that builds this part
            "material": meta.get("materialName"),
            "densityKgM3": meta.get("densityKgM3"),
            "massKg": mass.get("massKg"),
            "volumeMm3": mass.get("volumeMm3"),
            "centroidMm": mass.get("centroidMm"),
            "bboxMm": bbox.get("sizeMm"),
            "bboxMinMm": bbox.get("minMm"),
            "bboxMaxMm": bbox.get("maxMm"),
            "transform": o.get("transform"),  # 16-float placement in the machine
        })

    # 5) totals + honest data-coverage (a rate-limited run drops mass/bbox; the
    # caller must not read a low-coverage clash pass as "no interference")
    asm_mp = api(f"/api/v6/assemblies/d/{did}/w/{wid}/e/{eid}/massproperties")
    parts.sort(key=lambda p: (p.get("massKg") or 0), reverse=True)
    n = len(instances) or 1
    coverage = {
        "mass": round(sum(1 for p in parts if p.get("massKg") is not None) / n, 3),
        "bbox": round(sum(1 for p in parts if p.get("bboxMm") is not None) / n, 3),
    }
    return {
        "source": "onshape-live",
        "capturedAt": None,  # stamped by the caller (scripts can't call time in some envs)
        "document": {"did": did, "wid": wid, "eid": eid, "partStudios": ps_eids},
        "assembly": {
            "name": root.get("name") or asm.get("name"),
            "partCount": len(instances),
            "mateCount": mate_count,
            "massKg": round(asm_mp.get("mass", [0])[0], 3) if asm_mp.get("hasMass") else None,
            "volumeMm3": round(asm_mp.get("volume", [0])[0] * 1e9, 1),
            "centroidMm": _mm(asm_mp.get("centroid", [0, 0, 0])),
            "materials": dict(sorted(mat_hist.items(), key=lambda kv: -kv[1])),
            "summedPartMassKg": round(total_mass, 3),
            "coverage": coverage,
        },
        "parts": parts,
    }


def main():
    global AUTH
    ap = argparse.ArgumentParser()
    ap.add_argument("--url")
    ap.add_argument("--did"); ap.add_argument("--wid"); ap.add_argument("--eid")
    ap.add_argument("--out")
    ap.add_argument("--step", help="also export the assembly STEP to this path")
    ap.add_argument("--no-bbox", action="store_true")
    ap.add_argument("--jobs", type=int, default=12)
    a = ap.parse_args()
    AUTH = _auth_header()
    if a.url:
        did, wid, eid = parse_url(a.url)
    elif a.did and a.wid and a.eid:
        did, wid, eid = a.did, a.wid, a.eid
    else:
        sys.exit("give --url OR --did/--wid/--eid")
    state = build_state(did, wid, eid, with_bbox=not a.no_bbox, jobs=a.jobs)
    if a.step:
        n = export_step(did, wid, eid, a.step)
        state["stepBytes"] = n
        print(f"exported STEP: {a.step} ({n} bytes)")
    out = json.dumps(state, indent=1)
    if a.out:
        with open(a.out, "w") as f:
            f.write(out)
        p = state["parts"]
        heavy = ", ".join(f"{x['name']}={x['massKg']}kg" for x in p[:3] if x.get("massKg"))
        print(f"wrote {a.out}: {state['assembly']['partCount']} parts, "
              f"{state['assembly']['massKg']}kg, {len(state['assembly']['materials'])} materials")
        print(f"  heaviest: {heavy}")
    else:
        print(out)


if __name__ == "__main__":
    main()
