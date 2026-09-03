/**
 * Programmatic boards API — authenticated by an API key (NOT the session
 * cookie), minted in the Integrations console.
 *
 *   GET  /api/v1/boards                 — list enterprise boards (read scope)
 *   POST /api/v1/boards {prompt}        — build a product from a prompt
 *                                          (read_write scope). Returns 202 +
 *                                          runId immediately; poll
 *                                          GET /api/v1/runs/<runId>.
 *
 * POST drives the SAME pipeline as the Compose UI (industrial design →
 * architect → electronics → mechanical/sim/docs) with every honest gate
 * intact; runs are serialized (single-node deployment) and owned by the
 * key's creator.
 */
// @ts-ignore - plain ESM modules shared with node test scripts
import * as ent from '@/lib/enterprise/store.mjs'
import { v1Auth } from '@/app/api/v1/_lib'
import { enqueueBuild, queueDepth } from '@/lib/v1-jobs'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const auth = v1Auth(req)
  if (auth instanceof Response) return auth
  let db: any
  try {
    db = ent.loadDb()
  } catch (e) {
    if (ent.isStoreUnreadable(e)) return ent.storeUnreadableResponse()
    throw e
  }
  const boards = (db.boards ?? []).map((b: any) => ({
    board_id: b.board_id, name: b.name, program_id: b.program_id,
    readiness: b.readiness, routed_state: b.routed_state,
    tags: b.tags ?? [],
  }))
  return Response.json({ key: auth.key.name, scope: auth.key.scope, count: boards.length, boards })
}

export async function POST(req: Request) {
  const auth = v1Auth(req, { write: true })
  if (auth instanceof Response) return auth
  let body: any
  try { body = await req.json() } catch { body = {} }
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
  const rebuildRunId = typeof body?.rebuildRunId === 'string' ? body.rebuildRunId : undefined
  if (rebuildRunId && !/^run-[A-Za-z0-9._-]{1,128}$/.test(rebuildRunId)) {
    return Response.json({ error: 'invalid rebuildRunId' }, { status: 400 })
  }
  if (!rebuildRunId && (prompt.length < 8 || prompt.length > 2000)) {
    return Response.json({ error: 'prompt must be 8–2000 characters' }, { status: 400 })
  }
  const pending = queueDepth()
  if (pending >= 5) {
    return Response.json({ error: 'build queue is full (5 pending) — retry later' }, { status: 429 })
  }
  // Internal self-origin for the orchestrator's route calls: explicit env pin
  // first (behind the tunnel the request origin is the public host — looping
  // artifact-sized traffic through Cloudflare would be slow and fragile).
  const baseUrl = process.env.FL_SELF_URL || new URL(req.url).origin
  if (rebuildRunId) {
    // rebuild only your own runs — fail closed like every run surface
    const { runAccessByEmail } = await import('@/lib/auth')
    if (runAccessByEmail(auth.email, rebuildRunId) === 'forbidden') {
      return Response.json({ error: 'not your board' }, { status: 403 })
    }
  }
  const job = enqueueBuild(prompt || `rebuild ${rebuildRunId}`, auth.email, baseUrl, { rebuildRunId })
  return Response.json({
    runId: job.runId,
    status: job.status,
    queuePosition: pending,
    statusUrl: `/api/v1/runs/${job.runId}`,
    artifactsUrl: `/api/v1/runs/${job.runId}/artifacts`,
    note: 'a full build takes ~7 minutes; poll statusUrl',
  }, { status: 202 })
}
