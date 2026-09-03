/**
 * Programs ↔ Compose bridge — one enterprise board PER PRODUCT (Phase 1).
 * A completed run is first tracked into the product store (lineage from the
 * run's own report), then upserted into the "Compose Builds" program: the
 * first revision creates the board, later revisions attach as runs and
 * advance latest_run_id, so the portfolio shows one board per product whose
 * evidence tracks the newest build. attachRun reads REAL artifacts (shipped
 * chip-scale board first) — states are facts, never claims.
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
// @ts-ignore - plain ESM module shared with node scripts
import * as ent from '@/lib/enterprise/store.mjs'
import { trackRun, updateProduct, type Product } from '@/lib/design-state'
import { sealRevision } from '@/lib/checkpoint-seal'

const COMPOSE_PROGRAM = 'Compose Builds'

type SyncResult =
  | { synced: true; productId: string; boardId: string }
  | { synced: false; reason: string }

/** Track a completed run into its product AND mirror it into Programs. */
export async function trackAndSync(runId: string, ownerEmail: string | null): Promise<SyncResult> {
  if (!/^run-[A-Za-z0-9._-]{1,128}$/.test(runId)) return { synced: false, reason: 'invalid run id' }
  const runDir = path.join(process.cwd(), 'public', 'runs', runId)
  try { await fsp.access(path.join(runDir, 'electronics', 'chipscale-board.json')) }
  catch { return { synced: false, reason: 'no built board yet' } }

  const product = trackRun(runId, ownerEmail)
  if (!product) return { synced: false, reason: 'run is not a built product' }

  let db: any
  try {
    db = ent.loadDb()
  } catch (e) {
    // fail closed: never sync into an empty store that would then be saved
    // back over the real one
    if (ent.isStoreUnreadable(e)) return { synced: false, reason: 'store unreadable' }
    throw e
  }

  // Board exists for this product → just attach the new revision (idempotent
  // on run_dir).
  if (product.boardId && (db.boards ?? []).some((b: any) => b.board_id === product.boardId)) {
    const already = (db.runs ?? []).some(
      (r: any) => r.board_id === product.boardId && r.source_run_dir === runId)
    if (!already) {
      const run = ent.attachRun(db, {
        board_id: product.boardId,
        run_dir: runId,
        prompt: (product.prompt ?? product.name) as any,
        created_by: 'compose-pipeline',
        actor: 'compose-pipeline',
      }) as { error?: string }
      if (run?.error) return { synced: false, reason: String(run.error) }
      ent.saveDb(db)
    }
    void sealRevision(runId).catch(() => {}) // Phase 7 provenance — best-effort
    return { synced: true, productId: product.productId, boardId: product.boardId }
  }

  // First sighting of this product in the portfolio → program + board + run.
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
  const spec = await readJson(path.join(runDir, 'product-spec.json'))
  const board = ent.createBoard(db, {
    program_id: program.program_id,
    name: product.name,
    board_class: 'compose',
    requested_function: String(spec?.description ?? '').slice(0, 240),
    architecture_summary: String(spec?.disciplines?.electronics?.boardIntent ?? '').slice(0, 240),
    actor: 'compose-pipeline',
  })
  const run = ent.attachRun(db, {
    board_id: board.board_id,
    run_dir: runId,
    prompt: (product.prompt ?? product.name) as any,
    created_by: 'compose-pipeline',
    actor: 'compose-pipeline',
  }) as { error?: string }
  if (run?.error) return { synced: false, reason: String(run.error) }
  ent.saveDb(db)
  updateProduct(product.productId, (p: Product) => { p.boardId = board.board_id })
  void sealRevision(runId).catch(() => {}) // Phase 7 provenance — best-effort
  return { synced: true, productId: product.productId, boardId: board.board_id }
}

/** Back-compat name used by existing call sites. */
export async function syncRunToPrograms(runId: string): Promise<SyncResult> {
  return trackAndSync(runId, null)
}

async function readJson(p: string): Promise<any | null> {
  try { return JSON.parse(await fsp.readFile(p, 'utf8')) } catch { return null }
}
