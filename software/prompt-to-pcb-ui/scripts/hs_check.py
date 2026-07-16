#!/usr/bin/env python3
"""High-speed post-route checks: differential-pair skew + matched-length
groups, measured from the ROUTED board's real copper.

v1 is a REPORTING stage, honestly labeled: it measures what the router did
and flags skew, it does not yet constrain the router (constraint-honoring
routing is the follow-on program in docs/density-program.md). Rules:

  - Differential pairs are detected by KiCad's own naming convention:
    FOO_P/FOO_N, FOO+/FOO-, FOOP/FOON (last-char pairing).
  - Matched-length groups may be declared in <board>.hsnets.json:
      {"pairs": [["A_P","A_N"], ...], "groups": [{"nets": [...], "tol_mm": 2.0}]}
  - Intra-pair skew threshold defaults to 0.7 mm (~5 ps in FR4) — the common
    USB 2.0 HS layout rule — overridable per-pair in the sidecar.

Prints HS_REPORT:<json> and writes <board>.highspeed.json.

Usage: <kicad-python3> hs_check.py <board.kicad_pcb>
"""
import json
import math
import os
import re
import sys

import pcbnew

PS_PER_MM = 6.6   # ~FR4 outer-layer propagation, honest approximation
PAIR_SKEW_MM = 0.7

board_path = sys.argv[1]
b = pcbnew.LoadBoard(board_path)


def net_length_mm(name):
    total = 0.0
    vias = 0
    for t in b.GetTracks():
        if str(t.GetNetname()).strip() != name:
            continue
        if t.GetClass() == "PCB_VIA":
            vias += 1
            total += 1.6  # through-board barrel, honest fixed approximation
        else:
            s, e = t.GetStart(), t.GetEnd()
            total += math.hypot(pcbnew.ToMM(e.x - s.x), pcbnew.ToMM(e.y - s.y))
    return total, vias


nets = sorted({str(t.GetNetname()).strip() for t in b.GetTracks()} - {""})

# ---- pair detection: FOO_P/_N, FOO+/-, trailing P/N -------------------------
pairs = []
seen = set()
for n in nets:
    for pat, mate in ((r"(.+)_P$", r"\1_N"), (r"(.+)\+$", r"\1-"),
                      (r"(.+)P$", r"\1N")):
        m = re.match(pat, n)
        if not m:
            continue
        other = re.sub(pat, mate.replace("\\1", m.group(1)), n)
        # regex sub above is awkward; build mate directly
        other = m.group(1) + mate.replace("\\1", "")
        if other in nets and (n, other) not in seen and (other, n) not in seen:
            pairs.append((n, other))
            seen.add((n, other))
            break

# sidecar: declared pairs/groups override + extend detection
side_path = os.path.splitext(board_path)[0] + ".hsnets.json"
groups = []
pair_tol = {}
if os.path.exists(side_path):
    try:
        side = json.load(open(side_path))
        for p in side.get("pairs", []):
            t = (str(p[0]), str(p[1]))
            if t not in seen and (t[1], t[0]) not in seen:
                pairs.append(t)
                seen.add(t)
            if len(p) > 2:
                pair_tol[t] = float(p[2])
        groups = side.get("groups", [])
    except Exception:
        pass

report = {"pairs": [], "groups": [], "netLengthsMm": {}}
for n in nets:
    ln, nv = net_length_mm(n)
    report["netLengthsMm"][n] = round(ln, 2)

# differential in NAME does not mean skew-critical in PHYSICS: a Class-D
# speaker pair or motor phase pair is differential but slow — report it
# informationally, never fail it. Only genuinely high-speed classes gate.
NON_HS = re.compile(r"SPK|SPEAKER|AUDIO|MOTOR|MOT\d|COIL|RELAY|AMP|OUT\d|PHASE",
                    re.IGNORECASE)

for a, bn in pairs:
    la, va = net_length_mm(a)
    lb, vb = net_length_mm(bn)
    skew = abs(la - lb)
    tol = pair_tol.get((a, bn), PAIR_SKEW_MM)
    hs = not NON_HS.search(a)
    report["pairs"].append({
        "nets": [a, bn], "lengthsMm": [round(la, 2), round(lb, 2)],
        "skewMm": round(skew, 3), "skewPs": round(skew * PS_PER_MM, 1),
        "tolMm": tol, "class": "high-speed" if hs else "informational (slow pair)",
        "pass": (skew <= tol) if hs else None,
        "vias": [va, vb], "viaMismatch": va != vb,
    })

for g in groups:
    names = [str(x) for x in g.get("nets", [])]
    tol = float(g.get("tol_mm", 2.0))
    ls = {n: net_length_mm(n)[0] for n in names if n in report["netLengthsMm"]}
    if len(ls) < 2:
        continue
    spread = max(ls.values()) - min(ls.values())
    report["groups"].append({
        "nets": names, "lengthsMm": {k: round(v, 2) for k, v in ls.items()},
        "spreadMm": round(spread, 3), "tolMm": tol, "pass": spread <= tol,
    })

report["note"] = ("measured from routed copper; REPORTING stage only — the "
                  "router does not yet honor length constraints (see "
                  "docs/density-program.md)")
out_path = os.path.splitext(board_path)[0] + ".highspeed.json"
json.dump(report, open(out_path, "w"), indent=1)
print("HS_REPORT:" + json.dumps({
    "pairs": len(report["pairs"]),
    "pairFails": sum(1 for p in report["pairs"] if p["pass"] is False),
    "groups": len(report["groups"]),
    "groupFails": sum(1 for g in report["groups"] if not g["pass"]),
}))
for p in report["pairs"]:
    verdict = ("PASS" if p["pass"] else "SKEW EXCEEDED") if p["pass"] is not None \
        else "informational (slow pair, not gated)"
    print("HS_PAIR: %s/%s skew %.3fmm (%.1fps) tol %.2fmm %s%s" % (
        p["nets"][0], p["nets"][1], p["skewMm"], p["skewPs"], p["tolMm"],
        verdict, " — via-count mismatch" if p["viaMismatch"] else ""))
