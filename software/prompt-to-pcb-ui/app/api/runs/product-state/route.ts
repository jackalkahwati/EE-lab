/**
 * GET /api/runs/product-state?run=<id>            -> assemble + persist + return
 * GET /api/runs/product-state?run=<id>&changed=X  -> also answer the graph walk
 *
 * Stage A of the product-orchestrator roadmap: read-only assembly of the
 * shared product state from the artifacts every stage already persists.
 * Absent sections are {present:false, status:'absent'} — assembly NEVER
 * fakes or backfills. Field extracts here were verified against a real run
 * (verification.converged, drc.violations/unconnected_items, bom[].lineTotal).
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  DEPENDENCY_EDGES,
  SECTION_SOURCES,
  affectedBy,
  type ProductState,
  type SectionStatus,
  type StateSection,
} from '@/lib/product-state'

export const dynamic = 'force-dynamic'

// Same shape as lib/auth.ts isValidRunId: a leading alphanumeric rules out
// '.', '..' and dotfiles, so the id can never walk out of public/runs/.
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function summarize(
  section: string,
  files: Record<string, any>,
): { status: SectionStatus; summary?: Record<string, unknown> } {
  switch (section) {
    case 'electronics': {
      const drc = files['data/drc.json']
      const ver = files['data/verification.json']
      const design = files['data/design.json']
      // chip-scale runs persist their DRC inside chipscale-board.json (with
      // the repair ladder) rather than data/drc.json — read it as fallback
      const cs = files['electronics/chipscale-board.json']
      if (!drc && !ver && cs?.drc?.available) {
        const errs = typeof cs.drc.errors === 'number' ? cs.drc.errors : undefined
        return {
          status: errs === 0 ? 'passed' : errs == null ? 'unverified' : 'failed',
          summary: {
            drcErrors: errs,
            unrouted: cs.drcRepair?.unrouted ?? null,
            repairLadder: cs.drcRepair
              ? `${cs.drcRepair.errorsFirst}->${cs.drcRepair.errorsBest} over ${cs.drcRepair.iterations?.length ?? '?'} strategies`
              : null,
            droppedCapabilities: cs.designConvergence?.droppedCapabilities ?? [],
            boardSource: cs.boardSource ?? null,
          },
        }
      }
      if (!drc && !ver) return { status: 'unverified', summary: { mcu: design?.mcu ?? null } }
      const errs = Array.isArray(drc?.violations)
        ? drc.violations.filter((v: any) => v?.severity === 'error').length
        : undefined
      const unc = Array.isArray(drc?.unconnected_items) ? drc.unconnected_items.length : undefined
      const converged = ver?.converged === true
      const status: SectionStatus =
        errs === 0 && unc === 0 ? 'passed' : errs == null ? 'unverified' : 'failed'
      return { status, summary: { drcErrors: errs, unconnected: unc, converged, mcu: design?.mcu ?? null } }
    }
    case 'mechanical': {
      const fid = files['disciplines/mech-fidelity.json']
      if (!fid) return { status: 'unverified', summary: { fidelity: 'no fidelity report' } }
      const st: SectionStatus =
        fid.state === 'verified' ? 'passed' : fid.state === 'failed-threshold' ? 'failed' : 'unverified'
      return { status: st, summary: { fidelity: fid.state, rounds: fid.rounds?.length ?? 0 } }
    }
    case 'id.render': {
      const con = files['id/consistency.json']
      if (!con) return { status: 'unverified', summary: { consistency: 'no consistency report' } }
      const st: SectionStatus =
        con.state === 'verified' ? 'passed' : con.state === 'failed-threshold' ? 'failed' : 'unverified'
      return { status: st, summary: { consistency: con.state } }
    }
    case 'bom': {
      const bom = files['data/bom.json']
      if (!bom) return { status: 'unverified' }
      const rows: any[] = Array.isArray(bom) ? bom : Array.isArray(bom?.rows) ? bom.rows : []
      const cost = rows.reduce(
        (a, r) => (typeof r?.lineTotal === 'number' && isFinite(r.lineTotal) ? a + r.lineTotal : a),
        0,
      )
      return { status: 'passed', summary: { lineItems: rows.length, costUsd: Math.round(cost * 100) / 100 } }
    }
    case 'simulation': {
      const sim = files['disciplines/simulation.json']
      if (!sim) return { status: 'unverified' }
      const solvers = sim.solvers && typeof sim.solvers === 'object' ? Object.keys(sim.solvers).length : undefined
      return { status: 'passed', summary: { solvers, femAvailable: sim.femAvailable ?? null } }
    }
    default:
      return { status: files && Object.keys(files).length ? 'passed' : 'unverified' }
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const runId = url.searchParams.get('run') ?? ''
  if (!RUN_ID.test(runId)) return Response.json({ error: 'bad run id' }, { status: 400 })
  const runDir = path.join(process.cwd(), 'public', 'runs', runId)
  try {
    await fs.access(runDir)
  } catch {
    return Response.json({ error: 'unknown run' }, { status: 404 })
  }

  const sections: Record<string, StateSection> = {}
  for (const [name, rels] of Object.entries(SECTION_SOURCES)) {
    const files: Record<string, any> = {}
    const found: string[] = []
    const h = createHash('sha1')
    for (const rel of rels) {
      try {
        const raw = await fs.readFile(path.join(runDir, rel), 'utf8')
        h.update(raw)
        found.push(rel)
        try {
          files[rel] = JSON.parse(raw)
        } catch {
          /* non-JSON artifact: hashed for change detection, not summarized */
        }
      } catch {
        /* absent — recorded below, never faked */
      }
    }
    if (!found.length) {
      sections[name] = { present: false, status: 'absent', paths: rels }
      continue
    }
    const { status, summary } = summarize(name, files)
    sections[name] = { present: true, hash: h.digest('hex'), status, summary, paths: found }
  }

  const state: ProductState = {
    runId,
    assembledAt: new Date().toISOString(),
    sections,
    graph: DEPENDENCY_EDGES,
  }
  try {
    await fs.writeFile(path.join(runDir, 'product-state.json'), JSON.stringify(state, null, 1))
  } catch {
    /* persistence is best-effort; the response is authoritative */
  }

  const changed = url.searchParams.get('changed')
  return Response.json(changed ? { ...state, changed, affected: affectedBy(changed) } : state)
}
