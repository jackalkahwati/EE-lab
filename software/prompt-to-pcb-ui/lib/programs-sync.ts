/**
 * Programs ↔ Compose bridge — when a Compose run completes, upsert it into the
 * enterprise portfolio (program "Compose Builds" → board named from the product
 * spec → attached run with REAL route/DRC evidence via store.attachRun, which
 * reads the run's artifacts and never fabricates states).
 *
 * Idempotent: a run already attached to any board is left alone, so the
 * pipeline, the v1 API, and manual re-runs can all call this safely.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
// @ts-ignore - plain ESM module shared with node scripts
import * as ent from '@/lib/enterprise/store.mjs'

const COMPOSE_PROGRAM = 'Compose Builds'

export async function syncRunToPrograms(runId: string): Promise<
  { synced: true; boardId: string } | { synced: false; reason: string }
> {
  if (!/^run-[A-Za-z0-9._-]{1,128}$/.test(runId)) return { synced: false, reason: 'invalid run id' }
  const runDir = path.join(process.cwd(), 'public', 'runs', runId)
  let spec: any
  try { spec = JSON.parse(await fs.readFile(path.join(runDir, 'product-spec.json'), 'utf8')) }
  catch { return { synced: false, reason: 'no product spec (run not a built product)' } }
  try { await fs.access(path.join(runDir, 'electronics', 'chipscale-board.json')) }
  catch { return { synced: false, reason: 'no built board yet' } }

  const db = ent.loadDb()
  const already = (db.runs ?? []).find((r: any) => r.source_run_dir === runId)
  if (already) return { synced: true, boardId: already.board_id }

  let program = (db.programs ?? []).find((p: any) => p.name === COMPOSE_PROGRAM)
  if (!program) {
    const ws = (db.workspaces ?? [])[0]
    if (!ws) return { synced: false, reason: 'no enterprise workspace' }
    program = ent.createProgram(db, {
      workspace_id: ws.workspace_id,
      name: COMPOSE_PROGRAM,
      owner: 'compose',
      objective: 'Products built end-to-end by the Compose pipeline',
      actor: 'compose-pipeline',
    })
  }
  const board = ent.createBoard(db, {
    program_id: program.program_id,
    name: String(spec.product ?? runId).slice(0, 80),
    board_class: 'compose',
    requested_function: String(spec.description ?? '').slice(0, 240),
    architecture_summary: String(spec.disciplines?.electronics?.boardIntent ?? '').slice(0, 240),
    actor: 'compose-pipeline',
  })
  const run = ent.attachRun(db, {
    board_id: board.board_id,
    run_dir: runId,
    prompt: spec.product ?? null,
    created_by: 'compose-pipeline',
    actor: 'compose-pipeline',
  }) as { error?: string }
  if (run?.error) return { synced: false, reason: String(run.error) }
  ent.saveDb(db)
  return { synced: true, boardId: board.board_id }
}
