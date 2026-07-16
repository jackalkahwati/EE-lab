#!/usr/bin/env python3
"""FirstLight shared part registry — the single MPN/LCSC-keyed store both
board engines read and write.

Before this existed there were two disconnected part worlds:
  - Engine A (block composition): KiCad-install symbols/footprints + a
    query-keyed parts_cache.json from the DigiKey->datasheet sourcing path
  - Engine B (chip-scale tscircuit): LCSC footprints fetched over the network
    by easyeda2kicad, cached only in process memory (lost on every restart)

The registry unifies them: one SQLite table keyed by canonical part id
(LCSC id like "C2040" when known, else uppercased MPN), storing pins,
package, footprint (either literal .kicad_mod text or a KiCad lib:name
reference), sourcing data, and PROVENANCE. Provenance is load-bearing: every
entry records where it came from and how far it was verified, so downstream
consumers can honor the pipeline's honesty contract (a datasheet-verified
pinmap is not the same thing as an LLM guess, and the row must say which it
is).

Usage as a CLI (spawned by the Next.js server the same way it spawns
easyeda2kicad — no node sqlite dependency needed):
  registry.py get <id>              -> JSON entry or {"found": false}
  registry.py footprint <lcsc>      -> raw .kicad_mod text (exit 1 if none)
  registry.py save-footprint <lcsc> -> reads .kicad_mod text on stdin
  registry.py upsert                -> reads a JSON entry on stdin
  registry.py search <query> [-n N] -> JSON list
  registry.py stats                 -> JSON counts by source/verification
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time

DB_PATH = os.environ.get(
    "FL_PARTS_DB",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "registry.sqlite"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS parts (
  id TEXT PRIMARY KEY,          -- canonical: LCSC id (Cxxxxx) else MPN upper
  mpn TEXT,
  lcsc TEXT,
  manufacturer TEXT,
  description TEXT,
  category TEXT,
  package TEXT,
  interface TEXT,               -- contract key when known (i2c_sensor, ...)
  pins TEXT,                    -- JSON [{"number": "1", "name": "VCC"}, ...]
  kicad_mod TEXT,               -- literal .kicad_mod footprint text
  footprint_ref TEXT,           -- KiCad "Lib:Name" when kicad_mod is NULL
  symbol_ref TEXT,
  datasheet TEXT,
  price REAL,
  stock INTEGER,
  jlc_basic INTEGER DEFAULT 0,  -- 1 = JLCPCB basic library (cheapest assembly)
  provenance TEXT,              -- JSON {"source","verified","fetchedAt",...}
  updated_at REAL
);
CREATE INDEX IF NOT EXISTS idx_parts_mpn ON parts(mpn);
CREATE INDEX IF NOT EXISTS idx_parts_lcsc ON parts(lcsc);
CREATE INDEX IF NOT EXISTS idx_parts_category ON parts(category);
-- query-key map: replaces parts_cache.json's "interface::query" -> part idea
CREATE TABLE IF NOT EXISTS queries (
  qkey TEXT PRIMARY KEY,        -- "<interface>::<normalized query>"
  part_id TEXT NOT NULL,
  updated_at REAL
);
"""


def _connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    # WAL: the registry is written by multiple concurrent processes (both
    # engines + parallel footprint saves from candidate builds). Journal-mode
    # rollback made simultaneous saves lose races; WAL + busy_timeout makes
    # them queue instead.
    con.execute("PRAGMA busy_timeout = 15000")
    try:
        con.execute("PRAGMA journal_mode = WAL")
    except sqlite3.OperationalError:
        pass  # already WAL / locked mid-switch — fine either way
    for attempt in (0, 1):
        try:
            con.executescript(SCHEMA)
            break
        except sqlite3.OperationalError:
            if attempt:
                raise
            time.sleep(0.2)
    return con


def canonical_id(entry):
    lcsc = (entry.get("lcsc") or "").strip()
    if lcsc:
        return lcsc.upper() if lcsc.upper().startswith("C") else "C" + lcsc
    mpn = (entry.get("mpn") or "").strip()
    return mpn.upper() if mpn else None


def _row_to_dict(row):
    if row is None:
        return None
    d = dict(row)
    for k in ("pins", "provenance"):
        if d.get(k):
            try:
                d[k] = json.loads(d[k])
            except Exception:
                pass
    return d


def get(key):
    """Look up by canonical id, LCSC id, or MPN (case-insensitive)."""
    k = (key or "").strip()
    if not k:
        return None
    con = _connect()
    try:
        for sql, arg in (
            ("SELECT * FROM parts WHERE id = ?", k.upper()),
            ("SELECT * FROM parts WHERE lcsc = ? COLLATE NOCASE", k),
            ("SELECT * FROM parts WHERE mpn = ? COLLATE NOCASE", k),
        ):
            row = con.execute(sql, (arg,)).fetchone()
            if row:
                return _row_to_dict(row)
        return None
    finally:
        con.close()


def upsert(entry):
    """Insert or merge an entry. Non-null incoming fields win; existing
    non-null fields are kept when the incoming value is null (so a footprint
    fetch never erases sourcing data and vice versa)."""
    pid = canonical_id(entry)
    if not pid:
        raise ValueError("entry needs an lcsc id or mpn")
    con = _connect()
    try:
        existing = _row_to_dict(
            con.execute("SELECT * FROM parts WHERE id = ?", (pid,)).fetchone()) or {}
        merged = dict(existing)
        for k, v in entry.items():
            if v is not None and v != "":
                merged[k] = v
        merged["id"] = pid
        if merged.get("lcsc"):
            merged["lcsc"] = str(merged["lcsc"]).upper()
        if merged.get("mpn"):
            merged["mpn"] = str(merged["mpn"])
        merged["updated_at"] = time.time()
        for k in ("pins", "provenance"):
            if isinstance(merged.get(k), (dict, list)):
                merged[k] = json.dumps(merged[k])
        cols = ("id", "mpn", "lcsc", "manufacturer", "description", "category",
                "package", "interface", "pins", "kicad_mod", "footprint_ref",
                "symbol_ref", "datasheet", "price", "stock", "jlc_basic",
                "provenance", "updated_at")
        con.execute(
            "INSERT OR REPLACE INTO parts (%s) VALUES (%s)"
            % (",".join(cols), ",".join("?" * len(cols))),
            tuple(merged.get(c) for c in cols))
        con.commit()
        return pid
    finally:
        con.close()


_COLS = ("id", "mpn", "lcsc", "manufacturer", "description", "category",
         "package", "interface", "pins", "kicad_mod", "footprint_ref",
         "symbol_ref", "datasheet", "price", "stock", "jlc_basic",
         "provenance", "updated_at")


def bulk_upsert(entries, batch=5000):
    """Fast path for catalog ingestion: one connection, batched INSERTs with
    COALESCE merge — incoming non-null wins, existing non-null survives an
    incoming null (so metadata ingestion can never clobber a stored footprint
    or datasheet-verified pins). Returns rows written."""
    con = _connect()
    # incoming non-null wins — EXCEPT provenance, where the existing record
    # wins: bulk catalog metadata must not relabel an entry whose footprint or
    # pins came from a richer source (easyeda2kicad, digikey+datasheet)
    sets = ", ".join(
        ("%s = COALESCE(%s, excluded.%s)" if c == "provenance"
         else "%s = COALESCE(excluded.%s, %s)") % (c, c, c)
        for c in _COLS if c not in ("id", "updated_at"))
    sql = ("INSERT INTO parts (%s) VALUES (%s) ON CONFLICT(id) DO UPDATE SET %s, "
           "updated_at = excluded.updated_at"
           % (",".join(_COLS), ",".join("?" * len(_COLS)), sets))
    n = 0
    now = time.time()
    try:
        rows = []
        for e in entries:
            pid = canonical_id(e)
            if not pid:
                continue
            e = dict(e, id=pid, updated_at=now)
            if e.get("lcsc"):
                e["lcsc"] = str(e["lcsc"]).upper()
            for k in ("pins", "provenance"):
                if isinstance(e.get(k), (dict, list)):
                    e[k] = json.dumps(e[k])
            rows.append(tuple(e.get(c) for c in _COLS))
            if len(rows) >= batch:
                con.executemany(sql, rows)
                con.commit()
                n += len(rows)
                rows = []
        if rows:
            con.executemany(sql, rows)
            con.commit()
            n += len(rows)
        return n
    finally:
        con.close()


def remember_query(interface, query, part_id):
    con = _connect()
    try:
        qkey = "%s::%s" % (interface, (query or "").lower().strip())
        con.execute(
            "INSERT OR REPLACE INTO queries (qkey, part_id, updated_at) VALUES (?,?,?)",
            (qkey, part_id, time.time()))
        con.commit()
    finally:
        con.close()


def lookup_query(interface, query):
    con = _connect()
    try:
        qkey = "%s::%s" % (interface, (query or "").lower().strip())
        row = con.execute("SELECT part_id FROM queries WHERE qkey = ?", (qkey,)).fetchone()
        return get(row["part_id"]) if row else None
    finally:
        con.close()


def search(query, limit=20):
    """Token-AND substring search: every whitespace token must match somewhere
    in mpn/description/category/package, so "audio amplifier class d" finds a
    Class-D audio amp even though no field contains that exact phrase. Ranked:
    JLC-basic parts first (cheapest to assemble), then in-stock, then recency."""
    tokens = [t for t in (query or "").split() if t]
    if not tokens:
        return []
    clause = ("(mpn LIKE ? OR description LIKE ? OR category LIKE ? "
              "OR package LIKE ?)")
    where = " AND ".join([clause] * len(tokens))
    args = []
    for t in tokens:
        args += ["%" + t + "%"] * 4
    con = _connect()
    try:
        rows = con.execute(
            """SELECT * FROM parts WHERE %s
               ORDER BY jlc_basic DESC, (stock IS NOT NULL AND stock > 0) DESC,
                        updated_at DESC
               LIMIT ?""" % where,
            (*args, int(limit))).fetchall()
        return [_row_to_dict(r) for r in rows]
    finally:
        con.close()


def stats():
    con = _connect()
    try:
        n = con.execute("SELECT COUNT(*) c FROM parts").fetchone()["c"]
        with_fp = con.execute(
            "SELECT COUNT(*) c FROM parts WHERE kicad_mod IS NOT NULL "
            "OR footprint_ref IS NOT NULL").fetchone()["c"]
        with_pins = con.execute(
            "SELECT COUNT(*) c FROM parts WHERE pins IS NOT NULL").fetchone()["c"]
        basic = con.execute(
            "SELECT COUNT(*) c FROM parts WHERE jlc_basic = 1").fetchone()["c"]
        by_src = {}
        for row in con.execute("SELECT provenance FROM parts WHERE provenance IS NOT NULL"):
            try:
                src = json.loads(row["provenance"]).get("source", "?")
            except Exception:
                src = "?"
            by_src[src] = by_src.get(src, 0) + 1
        nq = con.execute("SELECT COUNT(*) c FROM queries").fetchone()["c"]
        return {"parts": n, "withFootprint": with_fp, "withPins": with_pins,
                "jlcBasic": basic, "bySource": by_src, "queries": nq,
                "db": DB_PATH}
    finally:
        con.close()


# ---- CLI (spawned by the Next server and by humans) -------------------------

def _main(argv):
    if len(argv) < 2:
        print(__doc__.strip())
        return 2
    cmd = argv[1]
    if cmd == "get":
        e = get(argv[2]) if len(argv) > 2 else None
        print(json.dumps(e if e else {"found": False}))
        return 0
    if cmd == "footprint":
        e = get(argv[2]) if len(argv) > 2 else None
        if e and e.get("kicad_mod"):
            sys.stdout.write(e["kicad_mod"])
            return 0
        return 1
    if cmd == "save-footprint":
        if len(argv) < 3:
            return 2
        mod = sys.stdin.read()
        if not mod.strip().startswith("(footprint") and not mod.strip().startswith("(module"):
            print(json.dumps({"error": "stdin does not look like a .kicad_mod"}))
            return 1
        pid = upsert({"lcsc": argv[2], "kicad_mod": mod,
                      "provenance": {"source": "easyeda2kicad",
                                     "verified": "lcsc-footprint",
                                     "fetchedAt": time.time()}})
        print(json.dumps({"saved": pid}))
        return 0
    if cmd == "upsert":
        entry = json.loads(sys.stdin.read())
        pid = upsert(entry)
        print(json.dumps({"saved": pid}))
        return 0
    if cmd == "search":
        n = 20
        if "-n" in argv:
            n = int(argv[argv.index("-n") + 1])
        q = next((a for a in argv[2:] if not a.startswith("-") and a != str(n)), "")
        print(json.dumps(search(q, n)))
        return 0
    if cmd == "stats":
        print(json.dumps(stats(), indent=1))
        return 0
    print(json.dumps({"error": "unknown command %s" % cmd}))
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
