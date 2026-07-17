#!/usr/bin/env python3
"""
Onshape -> FirstLight pipeline orchestrator (read-only stages).

Runs the geometry-in pipeline end to end from a single Onshape assembly URL:

  Stage 1  import   live parametric state map (parts, materials, mass, bboxes, transforms)
  Stage 1  step     export the assembly STEP (geometry)
  Stage 2  analyze  part-attributed findings (clash candidates, thermal, mass)
  Stage 4  codesign optional PCBA placement plan (--board-w/--board-h)

Stage 3 (part-scoped edits) and the Stage-4 insertion are WRITE operations and
are intentionally NOT run here — they need a write-scoped key + human approval
(see onshape_edit.py / onshape_route_edit.py).

Everything read-only runs with a read-scoped key. Auth via env or the work-hub
vault (see onshape_import._keys).

Usage:
  onshape_pipeline.py --url <onshape assembly url> --outdir DIR
                      [--board-w 112 --board-h 124]
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = __file__.rsplit("/", 1)[0]
sys.path.insert(0, HERE)
import onshape_import as oi  # noqa: E402
import onshape_analyze as oa  # noqa: E402
import onshape_codesign as oc  # noqa: E402


def run(url, did, wid, eid, outdir, board=None, with_bbox=True):
    os.makedirs(outdir, exist_ok=True)
    oi.AUTH = oi._auth_header()
    if url:
        did, wid, eid = oi.parse_url(url)

    # Stage 1: state map + STEP
    state = oi.build_state(did, wid, eid, with_bbox=with_bbox)
    state["stepBytes"] = oi.export_step(did, wid, eid, os.path.join(outdir, "assembly.step"))
    json.dump(state, open(os.path.join(outdir, "onshape-state.json"), "w"), indent=1)

    # Stage 2: analysis. Clash needs bboxes; if a rate-limited run dropped them,
    # say so — a 0-clash result with no bbox coverage is "couldn't check", not "clean".
    bbox_cov = state["assembly"].get("coverage", {}).get("bbox", 0)
    clashes, total = oa.clash_check(state["parts"], tol_mm=2.0, top=25)
    clash_complete = bbox_cov >= 0.9
    analysis = {
        "assembly": state["assembly"]["name"],
        "clash": {"candidatePairs": total, "top": clashes,
                  "complete": clash_complete, "bboxCoverage": bbox_cov,
                  "note": ("broad-phase AABB in assembly space; confirm top pairs narrow-phase"
                           if clash_complete else
                           f"INCOMPLETE — only {round(bbox_cov*100)}% of parts had bounding boxes "
                           "(Onshape rate limit); re-run for a full clash pass")},
        "thermal": {"flagged": oa.thermal_check(state["parts"])},
        "mass": {"heaviest": [{"part": p["name"], "massKg": p["massKg"], "material": p.get("material")}
                              for p in state["parts"][:10] if p.get("massKg")]},
    }
    json.dump(analysis, open(os.path.join(outdir, "onshape-analysis.json"), "w"), indent=1)

    summary = {
        "assembly": state["assembly"]["name"],
        "parts": state["assembly"]["partCount"],
        "massKg": state["assembly"]["massKg"],
        "materials": len(state["assembly"]["materials"]),
        "clashCandidates": total,
        "clashComplete": clash_complete,
        "bboxCoverage": bbox_cov,
        "thermalFlagged": len(analysis["thermal"]["flagged"]),
        "stepBytes": state["stepBytes"],
    }

    # Stage 4 (optional): placement plan
    if board:
        plan = oc.plan(state, board[0], board[1], 1.6, 8.0, 5.0)
        json.dump(plan, open(os.path.join(outdir, "onshape-codesign.json"), "w"), indent=1)
        summary["codesignFits"] = plan.get("fits")

    json.dump(summary, open(os.path.join(outdir, "onshape-summary.json"), "w"), indent=1)
    return summary


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url")
    ap.add_argument("--did"); ap.add_argument("--wid"); ap.add_argument("--eid")
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--board-w", type=float); ap.add_argument("--board-h", type=float)
    ap.add_argument("--no-bbox", action="store_true")
    a = ap.parse_args()
    if not a.url and not (a.did and a.wid and a.eid):
        sys.exit("give --url OR --did/--wid/--eid")
    board = (a.board_w, a.board_h) if a.board_w and a.board_h else None
    s = run(a.url, a.did, a.wid, a.eid, a.outdir, board=board, with_bbox=not a.no_bbox)
    print(json.dumps(s, indent=1))


if __name__ == "__main__":
    main()
