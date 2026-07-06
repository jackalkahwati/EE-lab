import fs from 'fs'
import path from 'path'
import { NextResponse } from 'next/server'

/**
 * Approved component library — serves the ingested UCS specs so the Ingest tab
 * can show what has been imported (identity, interfaces, support status,
 * validation). Read-only; ingestion itself is the CLI (ingest_cli.py).
 */
export async function GET() {
  const libDir = path.resolve(process.cwd(), '../../hardware/planner/library')
  let parts: any[] = []
  try {
    for (const fn of fs.readdirSync(libDir)) {
      if (!fn.endsWith('.json')) continue
      try {
        const s = JSON.parse(fs.readFileSync(path.join(libDir, fn), 'utf8'))
        parts.push({
          mpn: s.mpn,
          manufacturer: s.manufacturer,
          category: s.category,
          package: s.package,
          kicad_symbol: s.kicad_symbol,
          kicad_footprint: s.kicad_footprint,
          support_status: s.support_status,
          interfaces: (s.interfaces ?? []).map((i: any) => (typeof i === 'string' ? i : i.type)),
          pins: s.pins ?? [],
          power: s.power,
          confidence: s.confidence ?? {},
          provenance: s.provenance ?? {},
          missing_fields: s.missing_fields ?? [],
          unsupported_fields: s.unsupported_fields ?? [],
          approval: s.approval,
          user_notes: s.user_notes,
        })
      } catch {
        /* skip unreadable spec */
      }
    }
  } catch {
    /* no library yet */
  }
  return NextResponse.json({ parts })
}
