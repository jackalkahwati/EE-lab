"""Ingestion entry point — run the datasheet-to-UCS pipeline for one part.

  python3 ingest_cli.py <mpn> [--symbol S] [--footprint F] [--datasheet PDF]
       [--pin-table CSV] [--category C] [--manufacturer M] [--notes "..."]
       [--out DIR] [--approve supported|partial]

Writes <out>/<mpn>.ucs.json, <out>/<mpn>.ingest-report.json + .md. With
--approve it saves the (human-approved) spec into the component library.
Prints INGEST:<json> summary.
"""
import argparse
import csv
import json
import os
import sys

import ingest
import ingest_library


def _pin_table(path):
    if not path or not os.path.exists(path):
        return None
    rows = []
    with open(path) as f:
        if path.endswith(".json"):
            return json.load(f)
        for r in csv.DictReader(f):
            rows.append({"number": r.get("number") or r.get("pin"),
                         "name": r.get("name") or r.get("signal")})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mpn")
    ap.add_argument("--symbol")
    ap.add_argument("--footprint")
    ap.add_argument("--datasheet")
    ap.add_argument("--pin-table", dest="pin_table")
    ap.add_argument("--distributor")           # JSON string of sourcing metadata
    ap.add_argument("--category", default="")
    ap.add_argument("--manufacturer", default="")
    ap.add_argument("--notes", default="")
    ap.add_argument("--out", default=".")
    ap.add_argument("--approve")               # supported | partial
    args = ap.parse_args()

    dist = json.loads(args.distributor) if args.distributor else None
    spec, report = ingest.ingest_part(
        args.mpn, kicad_symbol=args.symbol, kicad_footprint=args.footprint,
        pin_table=_pin_table(args.pin_table), datasheet=args.datasheet,
        distributor=dist, category=args.category, manufacturer=args.manufacturer,
        notes=args.notes)

    os.makedirs(args.out, exist_ok=True)
    base = os.path.join(args.out, "".join(c if c.isalnum() or c in "-_." else "_"
                                          for c in args.mpn))
    json.dump(spec, open(base + ".ucs.json", "w"), indent=1)
    json.dump(report, open(base + ".ingest-report.json", "w"), indent=1)
    open(base + ".ingest-report.md", "w").write(ingest.report_markdown(report, spec))

    saved = None
    if args.approve:
        if not report["validation_errors"]:
            approved = ingest_library.approve(spec, args.approve)
            saved = ingest_library.save(approved)
            spec = approved
        else:
            report["approval_refused"] = ("cannot approve: validation errors — %s"
                                          % report["validation_errors"])

    print("INGEST:" + json.dumps({
        "mpn": args.mpn, "status": spec["support_status"],
        "pins": len(spec.get("pins", [])),
        "interfaces": report["interfaces"],
        "errors": report["validation_errors"],
        "warnings": len(report["warnings"]),
        "saved": saved,
    }))


if __name__ == "__main__":
    main()
