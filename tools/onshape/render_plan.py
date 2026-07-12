#!/usr/bin/env python3
"""Generic mechanical-plan renderer.

Reads a MechPlan (lib/mechanical-plan.ts) as JSON on stdin, builds the geometry
in a fresh Onshape Part Studio via the feature API, and exports STEP (+ GLTF).
It is a THIN executor: it maps each plan op to features.py calls and renders
WHATEVER the product engine directed — no baked-in enclosure recipe. Every op is
attempted independently; failures are reported, not fatal, so a partial plan
still yields a STEP.

Usage:
    python3 render_plan.py <out_dir> [name]   < plan.json
Prints one JSON object to stdout: {ok, stepPath, gltfPath, onshapeUrl, part,
opsRendered, opsFailed:[...], warnings:[...]}.

Auth via tools/onshape/.env (ONSHAPE_ACCESS_KEY / ONSHAPE_SECRET_KEY).
"""
from __future__ import annotations

import json
import os
import sys
import time
import warnings

warnings.filterwarnings("ignore")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# load .env (never committed)
_envp = os.path.join(HERE, ".env")
if os.path.exists(_envp):
    for line in open(_envp):
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k, v)

import requests  # noqa: E402
from onshape_client import Client, BASE_URL  # noqa: E402
from features import FeatureBuilder, rect, rounded_rect, circle  # noqa: E402

M = 1e-3  # mm -> m for sketch entity coordinates (Onshape internal SI)

# Onshape default datum planes have fixed deterministic ids in every Part Studio.
PLANE = {
    "top": {"btType": "BTMParameterQueryList-148", "parameterId": "sketchPlane",
            "queries": [{"btType": "BTMIndividualQuery-138", "deterministicIds": ["JDC"]}]},
    "front": {"btType": "BTMParameterQueryList-148", "parameterId": "sketchPlane",
              "queries": [{"btType": "BTMIndividualQuery-138", "deterministicIds": ["JCC"]}]},
    "right": {"btType": "BTMParameterQueryList-148", "parameterId": "sketchPlane",
              "queries": [{"btType": "BTMIndividualQuery-138", "deterministicIds": ["JFC"]}]},
}


APPEARANCE_PROP = "57f3fb8efa3416c06701d60c"
COMPONENT_COLORS = {
    "pcb": (33, 120, 60), "battery": (185, 185, 195), "antenna": (200, 120, 45),
    "speaker": (60, 60, 65), "generic": (150, 150, 155),
}


def _set_appearance(c, did, wid, eid, part_id, rgb):
    """Color a body so internal components are visually distinct. Non-fatal."""
    from urllib.parse import quote
    try:
        c._request("POST", "/api/v6/metadata/d/%s/w/%s/e/%s/p/%s" % (
            did, wid, eid, quote(part_id, safe="")),
            json={"properties": [{"propertyId": APPEARANCE_PROP, "value": {
                "color": {"red": rgb[0], "green": rgb[1], "blue": rgb[2]}, "opacity": 255}}]})
    except Exception:
        pass


def _profile_entities(prefix, prof):
    """MechProfile -> feature-API sketch entities (coords in metres)."""
    kind = prof.get("kind", "roundedRect")
    cx, cy = float(prof.get("cx", 0)), float(prof.get("cy", 0))
    if kind == "circle":
        d = float(prof.get("d", 1))
        return [circle(prefix + ".c", cx * M, cy * M, (d / 2.0) * M)]
    w, h = float(prof.get("w", 1)), float(prof.get("h", 1))
    x0, y0, x1, y1 = (cx - w / 2) * M, (cy - h / 2) * M, (cx + w / 2) * M, (cy + h / 2) * M
    if kind == "rect":
        return rect(prefix, x0, y0, x1, y1)
    r = float(prof.get("r", 0) or 0)
    r = max(0.0, min(r, min(w, h) / 2.0 - 1e-3))  # keep radius valid
    if r <= 0:
        return rect(prefix, x0, y0, x1, y1)
    return rounded_rect(prefix, x0, y0, x1, y1, r * M)


def render(plan, out_dir, name):
    c = Client()
    part_name = name or plan.get("part") or "Part"
    doc = c._request("POST", "/api/v6/documents",
                     json={"name": "FL Mech - " + part_name, "isPublic": False})
    did, wid = doc["id"], doc["defaultWorkspace"]["id"]
    els = c.list_elements(did, wid)
    eid = next(e["id"] for e in els if e.get("elementType") == "PARTSTUDIO")
    fb = FeatureBuilder(c, did, wid, eid)

    sketches = {}   # op name -> sketch featureId
    rendered, failed, warnings_out = [], [], []

    def all_part_ids():
        try:
            return list(fb.parts().keys())
        except Exception:
            return []

    for i, op in enumerate(plan.get("operations", [])):
        kind = op.get("op")
        nm = op.get("name") or "%s_%d" % (kind, i)
        try:
            if kind == "sketch":
                plane = PLANE.get(op.get("plane", "top"), PLANE["top"])
                ents = _profile_entities("p%d" % i, op.get("profile", {}))
                sketches[nm] = fb.add_sketch(nm, plane, ents)
                rendered.append(nm)
            elif kind == "extrude":
                sfid = sketches.get(op.get("sketch"))
                if not sfid:
                    raise RuntimeError("extrude references unknown sketch %r" % op.get("sketch"))
                fb.add_extrude(nm, sfid, float(op.get("depth", 1)),
                               offset_mm=(float(op["offset"]) if op.get("offset") is not None else None))
                rendered.append(nm)
            elif kind == "pocket":
                sfid = sketches.get(op.get("sketch"))
                scope = all_part_ids()
                if not sfid or not scope:
                    raise RuntimeError("pocket needs a sketch and an existing body")
                # sketch is on the top plane (Z=0), body extruded +Z; the cavity
                # removes [offset, offset+depth] going +Z into the body.
                fb.add_extrude_remove(nm, sfid, float(op.get("depth", 1)),
                                      (float(op["offset"]) if op.get("offset") is not None else None),
                                      scope)
                rendered.append(nm)
            elif kind == "standoff":
                x, y = float(op.get("x", 0)), float(op.get("y", 0))
                od, hgt = float(op.get("od", 4)), float(op.get("height", 3))
                baseZ = float(op.get("baseZ", 0) or 0)
                bs = fb.add_sketch(nm + "_boss_sk", PLANE["top"], [circle("so%d" % i, x * M, y * M, (od / 2) * M)])
                fb.add_extrude(nm + "_boss", bs, hgt, offset_mm=(baseZ if baseZ else None))
                if op.get("holeDia"):
                    hd = float(op["holeDia"])
                    hsk = fb.add_sketch(nm + "_hole_sk", PLANE["top"], [circle("sh%d" % i, x * M, y * M, (hd / 2) * M)])
                    scope = all_part_ids()
                    if scope:
                        fb.add_extrude_remove(nm + "_hole", hsk, hgt + baseZ + 1.0, None, scope)
                rendered.append(nm)
            elif kind == "cutout":
                face = op.get("face", "top")
                plane = PLANE.get(face, PLANE["top"])
                cx, cy = float(op.get("cx", 0)), float(op.get("cy", 0))
                w, h = float(op.get("w", 1)), float(op.get("h", 1))
                x0, y0 = (cx - w / 2) * M, (cy - h / 2) * M
                x1, y1 = (cx + w / 2) * M, (cy + h / 2) * M
                csk = fb.add_sketch(nm + "_sk", plane, rect("co%d" % i, x0, y0, x1, y1))
                scope = all_part_ids()
                if not scope:
                    raise RuntimeError("cutout needs an existing body")
                fb.add_extrude_remove(nm, csk, float(op.get("depth", 1)) + 2.0, None, scope,
                                      symmetric=(face != "top"))
                rendered.append(nm)
            elif kind == "component":
                x, y, z = float(op.get("cx", 0)), float(op.get("cy", 0)), float(op.get("cz", 0))
                w, h, t = float(op.get("w", 1)), float(op.get("h", 1)), float(op.get("thickness", 1))
                before = set(all_part_ids())
                if op.get("shape") == "cyl":
                    sk = fb.add_sketch(nm + "_sk", PLANE["top"], [circle("cp%d" % i, x * M, y * M, (w / 2) * M)])
                else:
                    sk = fb.add_sketch(nm + "_sk", PLANE["top"],
                                       rect("cr%d" % i, (x - w / 2) * M, (y - h / 2) * M, (x + w / 2) * M, (y + h / 2) * M))
                fb.add_extrude(nm, sk, t, offset_mm=(z if z else None))
                for pid in set(all_part_ids()) - before:
                    _set_appearance(c, did, wid, eid, pid, COMPONENT_COLORS.get(op.get("kind", "generic"), (150, 150, 155)))
                rendered.append(nm)
            else:
                warnings_out.append("skipped unknown op %r" % kind)
        except Exception as e:
            failed.append({"op": nm, "error": str(e)[:160]})

    os.makedirs(out_dir, exist_ok=True)
    step_path = _export(c, did, wid, eid, "STEP", os.path.join(out_dir, "enclosure.step"))
    png_path = _shaded_png(c, did, wid, eid, os.path.join(out_dir, "enclosure.png"))

    return {
        "ok": bool(rendered) and step_path is not None,
        "part": part_name,
        "stepPath": step_path,
        "previewPath": png_path,
        "onshapeUrl": "%s/documents/%s/w/%s/e/%s" % (BASE_URL, did, wid, eid),
        "opsRendered": rendered,
        "opsFailed": failed,
        "warnings": warnings_out,
    }


def _shaded_png(c, did, wid, eid, out_path):
    """Isometric shaded PNG preview of the part studio; path or None."""
    try:
        vm = "0.707,0.707,0,0,-0.408,0.408,0.816,0,0.577,-0.577,0.577,0"
        r = requests.get(
            "%s/api/v6/partstudios/d/%s/w/%s/e/%s/shadedviews" % (BASE_URL, did, wid, eid),
            params={"outputHeight": 600, "outputWidth": 800, "viewMatrix": vm, "pixelSize": 0},
            auth=c._auth, headers={"Accept": "application/json"}, timeout=60)
        if r.status_code >= 400:
            return None
        img = (r.json().get("images") or [None])[0]
        if not img:
            return None
        import base64
        with open(out_path, "wb") as f:
            f.write(base64.b64decode(img))
        return out_path
    except Exception:
        return None


def _export(c, did, wid, eid, fmt, out_path):
    """Export the part studio to fmt; write to out_path; return path or None."""
    try:
        tr = c._request(
            "POST", "/api/v6/partstudios/d/%s/w/%s/e/%s/translations" % (did, wid, eid),
            json={"formatName": fmt, "storeInDocument": False, "flattenAssemblies": False,
                  "yAxisIsUp": False})
        tid = tr.get("id")
        for _ in range(30):
            time.sleep(3)
            st = c._request("GET", "/api/v6/translations/%s" % tid)
            state = st.get("requestState")
            if state == "DONE":
                xid = (st.get("resultExternalDataIds") or [None])[0]
                if not xid:
                    return None
                resp = requests.get("%s/api/v6/documents/d/%s/externaldata/%s" % (BASE_URL, did, xid),
                                    auth=c._auth, timeout=120)
                resp.raise_for_status()
                with open(out_path, "wb") as f:
                    f.write(resp.content)
                return out_path
            if state == "FAILED":
                return None
    except Exception:
        return None
    return None


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    name = sys.argv[2] if len(sys.argv) > 2 else None
    plan = json.load(sys.stdin)
    try:
        print(json.dumps(render(plan, out_dir, name)))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:300]}))
        sys.exit(1)


if __name__ == "__main__":
    main()
