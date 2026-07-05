"""Assemble the order-ready PCBA package zip.

Combines the fab outputs (gerbers, drill, STEP, renders) with the enriched
assembly artifacts (pick-and-place with MPNs, assembly BOM, sourcing report,
assembly readiness, substitutions) and the FL-1 Validation Package. The plain
kicad-cli pick_and_place.csv / bom.csv from the fab dir are EXCLUDED in favour of
the enriched gen_assembly versions.

  python3 build_pcba_zip.py <fab_dir> <data_dir> <out_zip>

Prints "PCBA_ZIP:<path>".
"""
import os
import sys
import zipfile

fab_dir, data_dir, out_zip = sys.argv[1], sys.argv[2], sys.argv[3]

# fab-dir files superseded by the enriched data-dir versions
EXCLUDE_FAB = {"pick_and_place.csv", "bom.csv", "fab-package.zip", "pcba-package.zip"}

# the enriched assembly + validation artifacts (order-ready package contents)
DATA_FILES = [
    "pick_and_place.csv", "bom.csv", "sourcing-report.json",
    "assembly-readiness.json", "assembly-readiness.md", "substitutions.json",
    "constraints.json", "fl1-testplan.json", "fl1-validation.json",
    "power-budget.json",
]

n = 0
with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _dirs, names in os.walk(fab_dir):
        for name in names:
            if name in EXCLUDE_FAB:
                continue
            p = os.path.join(root, name)
            z.write(p, os.path.relpath(p, fab_dir))
            n += 1
    for name in DATA_FILES:
        p = os.path.join(data_dir, name)
        if os.path.exists(p):
            z.write(p, name)
            n += 1
    # board renders, if present
    board_dir = os.path.join(os.path.dirname(data_dir), "board")
    for r in ("render-top.png", "render-bottom.png"):
        p = os.path.join(board_dir, r)
        if os.path.exists(p):
            z.write(p, "renders/" + r)
            n += 1

print("PCBA_ZIP:%s (%d files)" % (out_zip, n))
