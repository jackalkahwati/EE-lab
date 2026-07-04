"""DFM Rev B — computed screen from live geometry (read-only, 3 calls).

Per fabricated part (process from the RFQ CSV): envelope, mass, volume,
fill ratio (volume / bbox volume), thin-panel index (max dim /
thickness), slenderness (max / mid dim), and rule flags per process:

  CNC billet   fill < 0.30           -> HOG-OUT flag (near-net/cast)
  CNC billet   fill < 0.15           -> SEVERE hog-out
  Sheet        maxdim/thk > 250      -> OIL-CAN flag (beads/flanges)
  Extrusion    fill > 0.75           -> NOT-EXTRUDABLE flag (solid bar)
  Any          slenderness > 18      -> WHIP/straightness flag
  Any          min wall proxy: surface_area*thk/2 vs volume (skipped -
               bbox-level screen; feature-level DFM stays at DVT)

Output: docs/rfq/fl1-dfm-rev-b.md (metrics table + flags), reconciled
against the Rev A judgment screen.
"""

from __future__ import annotations

import csv
import os
import warnings

warnings.filterwarnings("ignore")

from features import FeatureBuilder
from onshape_client import Client

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"
RFQ = os.path.join(os.path.dirname(__file__), "..", "..",
                   "docs", "rfq", "fl1-evt-fab-rfq.csv")
OUT = os.path.join(os.path.dirname(__file__), "..", "..",
                   "docs", "rfq", "fl1-dfm-rev-b.md")


def main() -> None:
    fb = FeatureBuilder(Client(), DID, WID, EID)
    c = fb.c
    name2pid = {}
    for p in c.list_parts(DID, WID, EID):
        if p.get("bodyType") != "composite":
            name2pid.setdefault(p["name"], p["partId"])
    boxes = fb.all_bboxes()
    mp = c._request("GET",
                    "/api/v6/partstudios/d/{}/w/{}/e/{}/massproperties".format(
                        DID, WID, EID), params={"massAsGroup": "false"})
    per = mp.get("bodies", {})

    rows = []
    with open(os.path.abspath(RFQ)) as f:
        for r in csv.reader(f):
            if len(r) < 10 or r[0] == "item":
                continue
            pn, part, qty, proc, ref = r[1], r[2], r[3], r[5], r[9]
            ref_first = ref.split(";")[0].strip()
            pid = name2pid.get(ref_first) or name2pid.get(part)
            b = boxes.get(ref_first) or boxes.get(part)
            if not pid or not b:
                rows.append((pn, part, proc, None, None, None, None, None,
                             ["NOT IN MODEL"]))
                continue
            body = per.get(pid)
            vol = body["volume"][0] * 1e9 if body else 0     # mm^3
            mass = body["mass"][0] if body else 0
            dims = sorted([b["highX"] - b["lowX"], b["highY"] - b["lowY"],
                           b["highZ"] - b["lowZ"]])
            thk, mid, mx = dims
            bboxv = max(thk * mid * mx, 1e-9)
            fill = vol / bboxv
            panel = mx / max(thk, 0.1)
            slender = mx / max(mid, 0.1)
            flags = []
            pl = proc.lower()
            if "cnc" in pl or "machin" in pl:
                if fill < 0.15:
                    flags.append("SEVERE HOG-OUT ({:.0%} fill)".format(fill))
                elif fill < 0.30:
                    flags.append("hog-out ({:.0%} fill) - near-net/cast".format(fill))
            if "sheet" in pl and panel > 250:
                flags.append("oil-can risk (t-index {:.0f}) - beads/flanges".format(panel))
            if "extru" in pl and fill > 0.75 and thk > 15:
                flags.append("NOT EXTRUDABLE as modeled ({:.0%} fill solid)".format(fill))
            if slender > 18:
                flags.append("slender ({:.0f}:1) - straightness/whip".format(slender))
            rows.append((pn, part, proc, dims, mass, fill, panel, slender,
                         flags))

    with open(os.path.abspath(OUT), "w") as f:
        f.write("# FL-1 DFM Screen — Rev B (computed, 2026-07-03)\n\n")
        f.write("Measured from the live model (bbox envelope + per-part mass "
                "properties). Complements Rev A's judgment screen; "
                "feature-level DFM (radii, reliefs, stacks) remains a DVT "
                "vendor activity.\n\n")
        f.write("| PN | Part | Process | Env (mm) | Mass (kg) | Fill | "
                "Panel t-idx | Slender | Flags |\n|---|---|---|---|---|---|"
                "---|---|---|\n")
        nflag = 0
        for pn, part, proc, dims, mass, fill, panel, slender, flags in rows:
            if dims is None:
                f.write("| {} | {} | {} | — | — | — | — | — | {} |\n".format(
                    pn, part, proc, "; ".join(flags)))
                continue
            if flags:
                nflag += 1
            f.write("| {} | {} | {} | {:.0f}×{:.0f}×{:.0f} | {:.2f} | "
                    "{:.0%} | {:.0f} | {:.1f} | {} |\n".format(
                        pn, part, proc, dims[2], dims[1], dims[0], mass,
                        fill, panel, slender,
                        "; ".join(flags) if flags else "—"))
        f.write("\nParts flagged: {} of {}.\n".format(nflag, len(rows)))
    print("wrote", os.path.abspath(OUT))
    for pn, part, proc, dims, mass, fill, panel, slender, flags in rows:
        if flags:
            print("FLAG {} ({}): {}".format(part, pn, "; ".join(flags)))


if __name__ == "__main__":
    main()
