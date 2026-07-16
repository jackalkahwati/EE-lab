#!/usr/bin/env python3
"""Bulk-ingest the JLCPCB assembly catalog (via the jlcparts dataset) into the
shared part registry — Phase 2 of the part-library plan.

Source: https://yaqwsx.github.io/jlcparts/data/ (split zip -> cache.sqlite3,
~7.2M rows of JLCPCB's parts feed). We ingest METADATA ONLY for the orderable
subset: present in the current catalog AND (in stock OR a basic-library part).
Footprint geometry stays fetch-on-demand (easyeda2kicad -> registry, Phase 1)
— ingesting 700k footprints would be slow, huge, and mostly unused.

Every row is provenance-labeled {"source": "jlcparts", "verified":
"catalog-metadata"}: catalog metadata locates and prices a part; it does NOT
verify a pinout. The sourcing path still reads the datasheet before a part is
bound to nets — honesty contract unchanged.

Usage:
  ingest_jlcparts.py [--db cache.sqlite3] [--limit N] [--basic-only]
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import registry

DEFAULT_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          ".jlcparts-cache", "cache.sqlite3")


def _min_price(price_json):
    """jlcparts price field is a JSON list of qty tiers; keep the qty-1 tier
    (or the cheapest tier present) as a single indicative unit price."""
    try:
        tiers = json.loads(price_json)
        prices = [float(t["price"]) for t in tiers
                  if t.get("price") not in (None, "", "-")]
        return round(min(prices), 6) if prices else None
    except Exception:
        return None


def rows(db_path, basic_only=False, limit=None):
    con = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    con.row_factory = sqlite3.Row
    where = "present = 1 AND (stock > 0 OR library_type = 'base')"
    if basic_only:
        where = "present = 1 AND library_type = 'base'"
    sql = ("SELECT lcsc, mfr, manufacturer, package, category, subcategory, "
           "description, datasheet, stock, price, library_type, preferred "
           "FROM jlc_components WHERE %s" % where)
    if limit:
        sql += " LIMIT %d" % int(limit)
    n = 0
    for r in con.execute(sql):
        n += 1
        yield {
            "lcsc": "C%d" % r["lcsc"],
            "mpn": r["mfr"] or None,
            "manufacturer": r["manufacturer"] or None,
            "package": r["package"] or None,
            "category": ("%s / %s" % (r["category"], r["subcategory"])).strip(" /"),
            "description": r["description"] or None,
            "datasheet": r["datasheet"] or None,
            "stock": int(r["stock"] or 0),
            "price": _min_price(r["price"]),
            "jlc_basic": 1 if (r["library_type"] == "base" or r["preferred"]) else 0,
            "provenance": {"source": "jlcparts", "verified": "catalog-metadata",
                           "libraryType": r["library_type"],
                           "ingestedAt": time.time()},
        }
    con.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--basic-only", action="store_true")
    args = ap.parse_args()
    if not os.path.exists(args.db):
        print(json.dumps({"error": "catalog db not found: %s" % args.db}))
        return 1
    t0 = time.time()
    n = registry.bulk_upsert(rows(args.db, args.basic_only, args.limit))
    print(json.dumps({"ingested": n, "seconds": round(time.time() - t0, 1),
                      "stats": registry.stats()}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
