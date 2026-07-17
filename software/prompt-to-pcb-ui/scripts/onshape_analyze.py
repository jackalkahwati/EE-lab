#!/usr/bin/env python3
"""
Part-attributed analysis (Stage 2) over a Stage-1 design-state map.

Every finding names a PART (or a part pair), so Stage 3's edit router can act on
exactly the offending piece instead of regenerating the whole machine.

Checks:
  clash      — pairwise interference, broad-phase. Each part's local bounding box
               is transformed into ASSEMBLY space by its occurrence transform,
               then boxes are tested for volumetric overlap deeper than a
               tolerance (designed face-contact is filtered out). Broad-phase
               AABB over-reports wrapping/nested parts, so results are RANKED by
               penetration depth and flagged as "confirm narrow-phase".
  thermal    — material softening-temperature screen: plastic parts are flagged
               with the temperature at which they lose strength. A real thermal
               FEA needs a heat-source/power model (Stage 3 supplies it from a
               prompt); this screen is the honest first pass.
  mass       — heaviest parts + material breakdown (from the state map).

Usage: onshape_analyze.py <state.json> [--clash-tol-mm 2.0] [--top 25] [--out report.json]
"""
from __future__ import annotations

import argparse
import json
import sys

# material name (lowercased substring) -> (softening/service temp C, note)
THERMAL = [
    ("pla", (55, "PLA softens ~55-60 C")),
    ("abs / pc", (95, "ABS/PC blend softens ~95-105 C")),
    ("abs", (90, "ABS softens ~90-100 C")),
    ("pc", (135, "Polycarbonate softens ~135-145 C")),
    ("nylon", (75, "Nylon (unfilled) softens ~75-90 C")),
    ("petg", (70, "PETG softens ~70-80 C")),
    ("delrin", (90, "Acetal/Delrin service ~90 C")),
    ("acetal", (90, "Acetal service ~90 C")),
    ("pom", (90, "POM/acetal service ~90 C")),
    ("tpu", (60, "TPU softens ~60-80 C")),
    ("resin", (60, "SLA resin softens ~60 C")),
]


def world_aabb(part):
    """Transform a part's local AABB into assembly space; return (min[3], max[3]) mm."""
    lo, hi = part.get("bboxMinMm"), part.get("bboxMaxMm")
    t = part.get("transform")
    if not lo or not hi:
        return None
    if not t:
        return list(lo), list(hi)
    # 8 corners of the local box, in meters, through the row-major 4x4, back to mm
    corners = []
    for xi in (lo[0], hi[0]):
        for yi in (lo[1], hi[1]):
            for zi in (lo[2], hi[2]):
                x, y, z = xi / 1000.0, yi / 1000.0, zi / 1000.0
                wx = t[0] * x + t[1] * y + t[2] * z + t[3]
                wy = t[4] * x + t[5] * y + t[6] * z + t[7]
                wz = t[8] * x + t[9] * y + t[10] * z + t[11]
                corners.append((wx * 1000, wy * 1000, wz * 1000))
    xs = [c[0] for c in corners]; ys = [c[1] for c in corners]; zs = [c[2] for c in corners]
    return [min(xs), min(ys), min(zs)], [max(xs), max(ys), max(zs)]


def overlap(a, b):
    """Per-axis overlap extents (mm) of two AABBs; negative means a gap on that axis."""
    (alo, ahi), (blo, bhi) = a, b
    return [min(ahi[i], bhi[i]) - max(alo[i], blo[i]) for i in range(3)]


def clash_check(parts, tol_mm, top):
    boxes = []
    for p in parts:
        ab = world_aabb(p)
        if ab:
            boxes.append((p, ab))
    hits = []
    for i in range(len(boxes)):
        pi, ai = boxes[i]
        for j in range(i + 1, len(boxes)):
            pj, aj = boxes[j]
            ov = overlap(ai, aj)
            if min(ov) <= tol_mm:            # a gap, or only touching within tol, on some axis
                continue
            penetration = min(ov)            # shallowest axis = how far they interpenetrate
            vol = ov[0] * ov[1] * ov[2]
            hits.append({
                "a": pi["name"], "aPartId": pi["partId"],
                "b": pj["name"], "bPartId": pj["partId"],
                "penetrationMm": round(penetration, 2),
                "overlapVolMm3": round(vol, 1),
                "aMaterial": pi.get("material"), "bMaterial": pj.get("material"),
            })
    hits.sort(key=lambda h: h["penetrationMm"], reverse=True)
    return hits[:top], len(hits)


def thermal_check(parts):
    out = []
    for p in parts:
        mat = (p.get("material") or "").lower()
        for key, (temp, note) in THERMAL:
            if key in mat:
                out.append({
                    "part": p["name"], "partId": p["partId"],
                    "material": p.get("material"), "softeningC": temp, "note": note,
                })
                break
    out.sort(key=lambda x: x["softeningC"])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("state")
    ap.add_argument("--clash-tol-mm", type=float, default=2.0)
    ap.add_argument("--top", type=int, default=25)
    ap.add_argument("--out")
    a = ap.parse_args()
    state = json.load(open(a.state))
    parts = state["parts"]

    clashes, total_clashes = clash_check(parts, a.clash_tol_mm, a.top)
    thermal = thermal_check(parts)
    heavy = [{"part": p["name"], "massKg": p["massKg"], "material": p.get("material")}
             for p in parts[:10] if p.get("massKg")]

    report = {
        "source": "stage2-analysis",
        "assembly": state["assembly"]["name"],
        "partCount": state["assembly"]["partCount"],
        "massKg": state["assembly"].get("massKg"),
        "clash": {
            "tolMm": a.clash_tol_mm,
            "candidatePairs": total_clashes,
            "note": "broad-phase AABB in assembly space; ranked by penetration. "
                    "Includes wrapping/nested parts - confirm the top pairs narrow-phase.",
            "top": clashes,
        },
        "thermal": {
            "note": "material softening-temp screen; a real thermal FEA needs a heat-source model.",
            "flagged": thermal,
        },
        "mass": {"heaviest": heavy, "materials": state["assembly"].get("materials")},
    }
    out = json.dumps(report, indent=1)
    if a.out:
        open(a.out, "w").write(out)
        print(f"wrote {a.out}")
        print(f"  clash: {total_clashes} candidate pairs (tol {a.clash_tol_mm}mm); "
              f"top penetration {clashes[0]['penetrationMm']}mm" if clashes else "  clash: none")
        if clashes:
            for c in clashes[:5]:
                print(f"    {c['a']}  ×  {c['b']}   penetration {c['penetrationMm']}mm")
        print(f"  thermal: {len(thermal)} plastic parts flagged"
              + (f" (lowest {thermal[0]['softeningC']}C: {thermal[0]['part']})" if thermal else ""))
    else:
        print(out)


if __name__ == "__main__":
    main()
