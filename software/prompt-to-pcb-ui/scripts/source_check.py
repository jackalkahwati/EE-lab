"""Live sourcing check: annotate bom.json lines with DigiKey stock + price.

For each BOM line with an MPN-ish part name, queries the DigiKey Product
Information API (creds from .env.local; sandbox by default) and writes
`stock`, `sourcedPrice`, and `sourcingStatus` back into bom.json. Graceful:
no creds or API failure -> lines marked "unchecked", exit 0 — sourcing is
advisory, never a gate.

  python3 source_check.py <bom.json>

Prints "SOURCED <checked>/<total>" sentinel.
"""
import json
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])

bom_path = sys.argv[1]
lines = json.load(open(bom_path))

checked = 0
total = 0
try:
    import digikey  # local module — handles .env.local + OAuth

    digikey.load_env()
    token = digikey.get_token()
except Exception as e:  # no creds / offline — advisory, not fatal
    token = None
    print("sourcing skipped: %s" % e)

for line in lines:
    name = (line.get("mpn") or line.get("part") or "").strip()
    if not name or name.lower().startswith(("assembly", "pin header", "capacitor", "resistor")):
        line["sourcingStatus"] = "generic"
        continue
    total += 1
    if token is None:
        line["sourcingStatus"] = "unchecked"
        continue
    try:
        hits = digikey.search(name, token=token, limit=1)
        if hits:
            hit = hits[0]
            line["stock"] = hit.get("stock")
            line["sourcedMpn"] = hit.get("mpn")
            line["sourcingStatus"] = "in-stock" if (hit.get("stock") or 0) > 0 else "check-stock"
            checked += 1
        else:
            line["sourcingStatus"] = "no-match"
    except Exception:
        line["sourcingStatus"] = "unchecked"

json.dump(lines, open(bom_path, "w"), indent=1)
print("SOURCED %d/%d" % (checked, total))
