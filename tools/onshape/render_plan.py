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
    if kind == "ring":
        # annulus: two concentric circles; the extrude/pocket that consumes this
        # sketch sets filterInnerLoops so only the ring region is used
        do = float(prof.get("dOuter", 2))
        di = float(prof.get("dInner", 1))
        return [circle(prefix + ".o", cx * M, cy * M, (do / 2.0) * M),
                circle(prefix + ".i", cx * M, cy * M, (di / 2.0) * M)]
    w, h = float(prof.get("w", 1)), float(prof.get("h", 1))
    x0, y0, x1, y1 = (cx - w / 2) * M, (cy - h / 2) * M, (cx + w / 2) * M, (cy + h / 2) * M
    if kind == "rect":
        return rect(prefix, x0, y0, x1, y1)
    r = float(prof.get("r", 0) or 0)
    r = max(0.0, min(r, min(w, h) / 2.0 - 1e-3))  # keep radius valid
    if r <= 0:
        return rect(prefix, x0, y0, x1, y1)
    return rounded_rect(prefix, x0, y0, x1, y1, r * M)


def _post_extrude(fb, name, sketch_fid, depth_mm, offset_mm=None, remove=False,
                  scope=None, filter_inner=False, opposite=False,
                  offset_opposite=False, symmetric=False):
    """Extrude (NEW or REMOVE) posted directly — same parameter shapes as
    features.py add_extrude/add_extrude_remove, plus filterInnerLoops on the
    sketch-region query so a 'ring' profile (two concentric circles) is used
    as an ANNULUS only (verified pattern: logo_etch.py). Returns featureId."""
    region = {"btType": "BTMIndividualSketchRegionQuery-140", "featureId": sketch_fid}
    if filter_inner:
        region["filterInnerLoops"] = True
    params = [
        {"btType": "BTMParameterEnum-145", "parameterId": "bodyType",
         "value": "SOLID", "enumName": "ExtendedToolBodyType"},
        {"btType": "BTMParameterEnum-145", "parameterId": "operationType",
         "value": "REMOVE" if remove else "NEW", "enumName": "NewBodyOperationType"},
        {"btType": "BTMParameterQueryList-148", "parameterId": "entities",
         "queries": [region]},
        {"btType": "BTMParameterEnum-145", "parameterId": "endBound",
         "value": "BLIND", "enumName": "BoundingType"},
        {"btType": "BTMParameterQuantity-147", "parameterId": "depth",
         "expression": "{} mm".format(depth_mm)},
        {"btType": "BTMParameterBoolean-144", "parameterId": "oppositeDirection",
         "value": opposite},
    ]
    if symmetric:
        params.append({"btType": "BTMParameterBoolean-144",
                       "parameterId": "symmetric", "value": True})
    if remove:
        params += [
            {"btType": "BTMParameterBoolean-144", "parameterId": "defaultScope",
             "value": False},
            {"btType": "BTMParameterQueryList-148", "parameterId": "booleanScope",
             "queries": [{"btType": "BTMIndividualQuery-138",
                          "deterministicIds": scope or []}]},
        ]
    if offset_mm is not None:
        params += [
            {"btType": "BTMParameterBoolean-144", "parameterId": "startOffset",
             "value": True},
            {"btType": "BTMParameterEnum-145", "parameterId": "startOffsetBound",
             "value": "BLIND", "enumName": "StartOffsetType"},
            {"btType": "BTMParameterQuantity-147",
             "parameterId": "startOffsetDistance",
             "expression": "{} mm".format(abs(float(offset_mm)))},
            {"btType": "BTMParameterBoolean-144",
             "parameterId": "startOffsetOppositeDirection", "value": offset_opposite},
        ]
    feat = fb._post({"btType": "BTMFeature-134", "featureType": "extrude",
                     "name": name, "parameters": params})
    return feat.get("featureId")


def _add_fillet(fb, name, feature_id, pts_mm, radius_mm):
    """One real fillet feature on the edges of `feature_id`'s body that pass
    through pts_mm [(x, y, z), ...] (verified pattern: id_pass_1.py window
    fillets). tangentPropagation carries a single pick around a tangent-
    continuous rim loop (roundedRect edges + corner arcs)."""
    qs = ", ".join(
        'qContainsPoint(qCreatedBy(makeId("%s"), EntityType.EDGE), '
        "vector(%.4f, %.4f, %.4f) * millimeter)" % (feature_id, x, y, z)
        for (x, y, z) in pts_mm)
    fb._post({
        "btType": "BTMFeature-134", "featureType": "fillet", "name": name,
        "parameters": [
            {"btType": "BTMParameterQueryList-148", "parameterId": "entities",
             "queries": [{"btType": "BTMIndividualQuery-138",
                          "queryString": "query = qUnion([%s]);" % qs}]},
            {"btType": "BTMParameterQuantity-147", "parameterId": "radius",
             "expression": "{} mm".format(radius_mm)},
            {"btType": "BTMParameterBoolean-144",
             "parameterId": "tangentPropagation", "value": True},
        ],
    })


def _pcb_seat_z(ops):
    """Resting Z (mm) for a PCB component: the top of the tallest standoff (the
    board seats ON the bosses), else the cavity floor (largest pocket offset),
    else None when the plan gives no reference. POSITION only — component sizes
    are never altered here, so an oversized board still shows honestly."""
    tops = [float(o.get("baseZ", 0) or 0) + float(o.get("height", 0) or 0)
            for o in ops if o.get("op") == "standoff"]
    if tops:
        return max(tops)
    # only pockets in the BASE shell count as floors — in a two-shell plan the
    # lid's grooves/thin-zones start above the base top and must not become the
    # board's "floor"
    base_top = None
    for o in ops:
        if o.get("op") == "extrude":
            base_top = (float(o.get("offset", 0) or 0) +
                        float(o.get("depth", 0) or 0))
            break
    floors = [float(o["offset"]) for o in ops
              if o.get("op") == "pocket" and o.get("offset") is not None
              and (base_top is None or float(o["offset"]) < base_top)]
    if floors:
        return max(floors)
    return None


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
    profs = {}      # sketch op name -> profile dict (ring detection, fillet geometry)
    extrudes = {}   # extrude op name -> {fid, prof, z0, z1} (fillet targets)
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
                profs[nm] = op.get("profile", {}) or {}
                rendered.append(nm)
            elif kind == "extrude":
                sfid = sketches.get(op.get("sketch"))
                if not sfid:
                    raise RuntimeError("extrude references unknown sketch %r" % op.get("sketch"))
                prof = profs.get(op.get("sketch"), {})
                depth = float(op.get("depth", 1))
                off = float(op["offset"]) if op.get("offset") is not None else None
                if prof.get("kind") == "ring":
                    # annulus-only extrude needs filterInnerLoops
                    efid = _post_extrude(fb, nm, sfid, depth, offset_mm=off,
                                         filter_inner=True)
                else:
                    efid = fb.add_extrude(nm, sfid, depth, offset_mm=off)
                extrudes[nm] = {"fid": efid, "prof": prof,
                                "z0": off or 0.0, "z1": (off or 0.0) + depth}
                rendered.append(nm)
            elif kind == "pocket":
                sfid = sketches.get(op.get("sketch"))
                scope = all_part_ids()
                if not sfid or not scope:
                    raise RuntimeError("pocket needs a sketch and an existing body")
                # sketch is on the top plane (Z=0), body extruded +Z; the cavity
                # removes [offset, offset+depth] going +Z into the body.
                off = float(op["offset"]) if op.get("offset") is not None else None
                if profs.get(op.get("sketch"), {}).get("kind") == "ring":
                    # groove/channel/registration step: cut the ANNULUS only
                    _post_extrude(fb, nm, sfid, float(op.get("depth", 1)),
                                  offset_mm=off, remove=True, scope=scope,
                                  filter_inner=True)
                else:
                    fb.add_extrude_remove(nm, sfid, float(op.get("depth", 1)),
                                          off, scope)
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
                if face != "top" and op.get("offsetMm") is not None:
                    # single-wall port cut: verified plane fact (README) — a
                    # front-plane REMOVE with opposite=True + offset_opposite=True
                    # spans [offset, offset+depth] in +Y, so only the +Y wall is
                    # pierced (no phantom hole in the opposite wall).
                    _post_extrude(fb, nm, csk, float(op.get("depth", 1)) + 2.0,
                                  offset_mm=float(op["offsetMm"]), remove=True,
                                  scope=scope, opposite=True, offset_opposite=True)
                else:
                    fb.add_extrude_remove(nm, csk, float(op.get("depth", 1)) + 2.0, None, scope,
                                          symmetric=(face != "top"))
                rendered.append(nm)
            elif kind == "fillet":
                ref = op.get("body")
                info = extrudes.get(ref) if ref else None
                if info is None and extrudes:
                    # default: the first extrude = the main shell body
                    info = next(iter(extrudes.values()))
                if not info:
                    raise RuntimeError("fillet needs a prior successful extrude")
                prof = info["prof"] or {}
                pcx = float(prof.get("cx", 0))
                pcy = float(prof.get("cy", 0))
                pk = prof.get("kind", "roundedRect")
                if pk == "circle":
                    pts2 = [(pcx + float(prof.get("d", 1)) / 2.0, pcy)]
                elif pk == "ring":
                    pts2 = [(pcx + float(prof.get("dOuter", 2)) / 2.0, pcy)]
                else:
                    pw = float(prof.get("w", 1))
                    ph = float(prof.get("h", 1))
                    # one pick per side; tangentPropagation walks the rounded
                    # corners when the profile is a roundedRect
                    pts2 = [(pcx, pcy + ph / 2.0), (pcx, pcy - ph / 2.0),
                            (pcx + pw / 2.0, pcy), (pcx - pw / 2.0, pcy)]
                fscope = op.get("scope", "outer-top")
                zs = {"outer-top": [info["z1"]],
                      "outer-bottom": [info["z0"]]}.get(fscope,
                                                        [info["z0"], info["z1"]])
                r = float(op.get("radiusMm", 1))
                rmax = (info["z1"] - info["z0"]) / 2.0 - 0.05
                if rmax > 0.1 and r > rmax:
                    warnings_out.append(
                        "fillet %s radius clamped %.2f -> %.2f mm (body height)"
                        % (nm, r, rmax))
                    r = rmax
                _add_fillet(fb, nm, info["fid"],
                            [(x, y, z) for z in zs for (x, y) in pts2], r)
                rendered.append(nm)
            elif kind == "component":
                x, y, z = float(op.get("cx", 0)), float(op.get("cy", 0)), float(op.get("cz", 0))
                w, h, t = float(op.get("w", 1)), float(op.get("h", 1)), float(op.get("thickness", 1))
                if op.get("kind") == "pcb":
                    # A plan that leaves the PCB at z=0 embeds it in (or through)
                    # the shell floor. Seat it at the standoff/floor height —
                    # a position correction only; w/h stay the TRUE board size.
                    seat = _pcb_seat_z(plan.get("operations", []))
                    if seat is not None and z < seat:
                        warnings_out.append(
                            "pcb component raised from z=%.2f to z=%.2f (standoff/floor "
                            "seat) so the board sits in the cavity, not through the floor"
                            % (z, seat))
                        z = seat
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
    # GLTF drives the in-app orbitable CAD viewer (three.js). Onshape's GLTF
    # translation returns a single binary glTF; GLTFLoader sniffs the container,
    # so the .glb name is safe either way. Best-effort: STEP stays the gate.
    gltf_path = _export(c, did, wid, eid, "GLTF", os.path.join(out_dir, "enclosure.glb"))
    png_path = _shaded_png(c, did, wid, eid, os.path.join(out_dir, "enclosure.png"))
    # fidelity evidence: the four canonical views the ID concept sheet uses
    # (front / perspective / top / side), rendered from the REAL geometry
    views_dir = os.path.join(out_dir, "views")
    os.makedirs(views_dir, exist_ok=True)
    view_paths = {}
    for vname, vm in _VIEW_MATRICES.items():
        p = _shaded_png(c, did, wid, eid, os.path.join(views_dir, vname + ".png"), vm)
        if p:
            view_paths[vname] = p

    return {
        "ok": bool(rendered) and step_path is not None,
        "part": part_name,
        "stepPath": step_path,
        "gltfPath": gltf_path,
        "previewPath": png_path,
        "viewPaths": view_paths,
        "onshapeUrl": "%s/documents/%s/w/%s/e/%s" % (BASE_URL, did, wid, eid),
        "opsRendered": rendered,
        "opsFailed": failed,
        "warnings": warnings_out,
    }


_VIEW_MATRICES = {
    # rows of the camera rotation, 12 comma floats (same format as the iso
    # preview). MEASURED convention (probed against a real asymmetric part):
    # the third row is the world-axis normal of the face you SEE. front shows
    # the +Y face (the wall the executor's front-plane cutouts pierce); top
    # shows +Z; right shows +X; iso is the existing preview matrix.
    "front": "-1,0,0,0,0,0,1,0,0,1,0,0",
    "top": "1,0,0,0,0,1,0,0,0,0,1,0",
    "right": "0,1,0,0,0,0,1,0,1,0,0,0",
    "iso": "0.707,0.707,0,0,-0.408,0.408,0.816,0,0.577,-0.577,0.577,0",
}


def _shaded_png(c, did, wid, eid, out_path,
                vm="0.707,0.707,0,0,-0.408,0.408,0.816,0,0.577,-0.577,0.577,0"):
    """Shaded PNG of the part studio from the given view matrix; path or None."""
    try:
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
        body = {"formatName": fmt, "storeInDocument": False, "flattenAssemblies": False,
                "yAxisIsUp": False}
        if fmt == "GLTF":
            # Mesh formats REQUIRE detail parameters — without them the
            # translation fails with "Invalid GLTF detail parameters". Y-up so
            # the part sits upright in glTF/three.js convention viewers.
            body.update({"resolution": "medium", "angularTolerance": 0.1,
                         "distanceTolerance": 0.0001, "maximumChordLength": 0.01,
                         "yAxisIsUp": True})
        tr = c._request(
            "POST", "/api/v6/partstudios/d/%s/w/%s/e/%s/translations" % (did, wid, eid),
            json=body)
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
