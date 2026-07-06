import fs from 'fs'
import path from 'path'
import { NextResponse } from 'next/server'

/**
 * FirstLight Instrument Pattern Library + reference manifest — serves the
 * extracted Design Pattern Specs and the curated reference registry so the
 * Reference Patterns tab can show what has been learned, its source trust, and
 * its LICENSE status. Read-only.
 */
export async function GET() {
  const base = path.resolve(process.cwd(), '../../hardware/planner')
  const readDir = (dir: string) => {
    const out: any[] = []
    try {
      for (const fn of fs.readdirSync(dir)) {
        if (!fn.endsWith('.json')) continue
        try {
          out.push(JSON.parse(fs.readFileSync(path.join(dir, fn), 'utf8')))
        } catch {
          /* skip */
        }
      }
    } catch {
      /* no dir */
    }
    return out
  }

  const patterns = readDir(path.join(base, 'patterns')).map((p) => ({
    name: p.name,
    category: p.category,
    support_status: p.support_status,
    license_status: p.license_status,
    allowed_use: p.allowed_use,
    direct_reuse_allowed: p.direct_reuse_allowed,
    source_type: p.source_type,
    needs_reference: p.needs_reference ?? false,
    purpose: p.purpose,
    components: p.components ?? [],
    required_passives: p.required_passives ?? [],
    interface_pins: p.interface_pins ?? [],
    power: p.power ?? {},
    layout_constraints: p.layout_constraints ?? [],
    test_points: p.test_points ?? [],
    validation_procedure: p.validation_procedure,
    known_limitations: p.known_limitations ?? [],
    provenance: p.provenance ?? {},
    confidence: p.confidence ?? {},
    status_reasons: p.status_reasons ?? [],
  }))

  let references: any[] = []
  try {
    references = JSON.parse(
      fs.readFileSync(path.join(base, 'references', 'manifest.json'), 'utf8'),
    ).references
  } catch {
    /* no manifest */
  }

  return NextResponse.json({ patterns, references })
}
