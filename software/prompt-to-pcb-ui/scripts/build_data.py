"""Build bom.json and ato.json for the frontend from atopile build artifacts.

  python3 build_data.py <hardware-dir> <out-data-dir>
"""
import csv
import glob
import json
import os
import sys

hw_dir, out_dir = sys.argv[1], sys.argv[2]

# --- BOM from atopile's generated CSV ----------------------------------------
bom_csv = os.path.join(hw_dir, "build", "builds", "default", "default.bom.csv")
bom = []
if os.path.exists(bom_csv):
    with open(bom_csv) as f:
        for row in csv.DictReader(f):
            refs = [r.strip() for r in row["Designator"].split(",")]
            ref = (", ".join(refs) if len(refs) <= 4
                   else f"{refs[0]}…{refs[-1]} ({len(refs)})")
            part = " ".join(p for p in
                            [row.get("Manufacturer", ""), row.get("Partnumber", "")]
                            if p).strip()
            if row.get("Value"):
                part = f"{part} — {row['Value']}" if part else row["Value"]
            lcsc = row.get("LCSC Part #", "").strip()
            bom.append({
                "ref": ref,
                "part": part or row.get("Footprint", "?").split(":")[0],
                "lcsc": lcsc or "—",
                "qty": int(row.get("Quantity", 0) or 0),
                "unitPrice": 0,
                "lineType": "ordered" if lcsc else "buyer-furnished",
            })
    with open(os.path.join(out_dir, "bom.json"), "w") as f:
        json.dump(bom, f, indent=1)
    print(f"bom.json: {len(bom)} lines, {sum(l['qty'] for l in bom)} components")
else:
    print(f"WARN no BOM at {bom_csv}")

# --- real .ato sources ---------------------------------------------------------
ato = []
for path in sorted(glob.glob(os.path.join(hw_dir, "elec", "src", "*.ato"))):
    name = os.path.basename(path)
    with open(path) as f:
        ato.append({"name": name, "content": f.read()})
# main.ato first, matching the module map
ato.sort(key=lambda a: (a["name"] != "main.ato", a["name"]))
with open(os.path.join(out_dir, "ato.json"), "w") as f:
    json.dump(ato, f, indent=1)
print(f"ato.json: {len(ato)} files")
