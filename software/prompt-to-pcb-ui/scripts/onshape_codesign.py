#!/usr/bin/env python3
"""
Co-design placement (Stage 4): drop an FL-1 PCBA into the machine.

The mechanical design reserves electronics as "envelope" parts (instruments,
DIN-rail gear). This planner reads the Stage-1 state map, finds the electronics
BAY those envelopes occupy, and fits a real Compose-designed board into free
space there: position, orientation, four standoffs, and a clearance check
against every existing envelope (reusing the Stage-2 world-AABB math).

The PLAN is read-only and testable now. The actual insertion into Onshape
(import the board as a part, mate it, generate the standoffs) is WRITE-gated,
same as Stage 3 — it needs a write-scoped key and human approval.

Usage: onshape_codesign.py <state.json> --board-w 176 --board-h 136 [--board-t 1.6]
                           [--standoff 8] [--clearance 5] [--out plan.json]
"""
from __future__ import annotations

import argparse
import json
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from onshape_analyze import world_aabb  # reuse Stage-2 transform math


def _xy_overlap(a, b, pad):
    """Do two AABBs overlap in XY (with pad) — the footprint test for placement."""
    (alo, ahi), (blo, bhi) = a, b
    return not (ahi[0] + pad < blo[0] or alo[0] - pad > bhi[0]
                or ahi[1] + pad < blo[1] or alo[1] - pad > bhi[1])


def plan(state, bw, bh, bt, standoff, clearance):
    parts = state["parts"]
    # the reserved-electronics tag is "Electronics assembly (envelope)"; match the
    # "(envelope)" marker so we cluster the true bay, not every electronics-ish part
    envelopes = [p for p in parts if "envelope" in (p.get("material") or "").lower()]
    occ = [(p, world_aabb(p)) for p in envelopes]
    occ = [(p, ab) for p, ab in occ if ab]
    if not occ:
        return {"error": "no electronics bay found (no envelope parts)"}

    # bay bounds = union of the envelope AABBs
    xs = [ab[0][0] for _, ab in occ] + [ab[1][0] for _, ab in occ]
    ys = [ab[0][1] for _, ab in occ] + [ab[1][1] for _, ab in occ]
    zs = [ab[0][2] for _, ab in occ] + [ab[1][2] for _, ab in occ]
    bay = {"xMm": [min(xs), max(xs)], "yMm": [min(ys), max(ys)], "zMm": [min(zs), max(zs)]}

    # search a coarse XY grid at the bay's top Z for a board-sized clear rectangle
    place_z = max(zs) + standoff  # mount above the bay floor on standoffs
    step = 10.0
    found = None
    y = bay["yMm"][0]
    while y + bh <= bay["yMm"][1] and not found:
        x = bay["xMm"][0]
        while x + bw <= bay["xMm"][1]:
            cand = ([x, y, place_z], [x + bw, y + bh, place_z + bt])
            if not any(_xy_overlap(cand, ab, clearance) for _, ab in occ):
                found = cand
                break
            x += step
        y += step

    result = {
        "source": "stage4-codesign",
        "assembly": state["assembly"]["name"],
        "board": {"wMm": bw, "hMm": bh, "tMm": bt},
        "electronicsBay": {"envelopeCount": len(occ), **bay},
        "fits": bool(found),
    }
    if found:
        (lo, hi) = found
        cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
        inset = standoff + 3
        result["placement"] = {
            "originMm": [round(lo[0], 1), round(lo[1], 1), round(lo[2], 1)],
            "centerMm": [round(cx, 1), round(cy, 1), round(lo[2], 1)],
            "normal": "+Z",
            "standoffs": [
                {"xMm": round(lo[0] + inset, 1), "yMm": round(lo[1] + inset, 1), "heightMm": standoff},
                {"xMm": round(hi[0] - inset, 1), "yMm": round(lo[1] + inset, 1), "heightMm": standoff},
                {"xMm": round(lo[0] + inset, 1), "yMm": round(hi[1] - inset, 1), "heightMm": standoff},
                {"xMm": round(hi[0] - inset, 1), "yMm": round(hi[1] - inset, 1), "heightMm": standoff},
            ],
        }
        # nearest-neighbour clearance
        near = min(occ, key=lambda pa: abs((pa[1][0][2] + pa[1][1][2]) / 2 - lo[2]))
        result["placement"]["nearestEnvelope"] = near[0]["name"]
        result["note"] = ("placement fits with clearance; standoffs generated. Insertion into "
                          "Onshape (import board as part, mate, cut standoffs) is write-gated.")
    else:
        result["note"] = ("no clear footprint for this board in the current bay — enlarge the bay "
                          "(Stage-3 variable edit) or pick a smaller board / different face.")
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("state")
    ap.add_argument("--board-w", type=float, required=True)
    ap.add_argument("--board-h", type=float, required=True)
    ap.add_argument("--board-t", type=float, default=1.6)
    ap.add_argument("--standoff", type=float, default=8.0)
    ap.add_argument("--clearance", type=float, default=5.0)
    ap.add_argument("--out")
    a = ap.parse_args()
    state = json.load(open(a.state))
    res = plan(state, a.board_w, a.board_h, a.board_t, a.standoff, a.clearance)
    out = json.dumps(res, indent=1)
    if a.out:
        open(a.out, "w").write(out)
        print(f"wrote {a.out}: fits={res.get('fits')}")
        if res.get("placement"):
            p = res["placement"]
            print(f"  place {a.board_w}×{a.board_h}mm board at center {p['centerMm']} (+Z), "
                  f"4 standoffs {a.standoff}mm, near {p['nearestEnvelope']}")
    else:
        print(out)


if __name__ == "__main__":
    main()
