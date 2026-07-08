/**
 * Programmatic read API — authenticated by an API key (NOT the session cookie),
 * proving the keys minted in Integrations are real and enforced.
 *
 *   GET /api/v1/boards
 *   Authorization: Bearer flk_live_...
 *
 * Returns 401 without a valid, non-revoked key. Verification is by SHA-256 hash
 * comparison against the stored key records; the raw key is never logged.
 */
// @ts-ignore - plain ESM modules shared with node test scripts
import * as ent from '@/lib/enterprise/store.mjs'
// @ts-ignore
import * as integrations from '@/lib/enterprise/integrations.mjs'

export const dynamic = 'force-dynamic'

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

export async function GET(req: Request) {
  const raw = bearer(req)
  if (!raw) {
    return Response.json({ error: 'missing API key (Authorization: Bearer flk_live_...)' },
                         { status: 401 })
  }
  const db = ent.loadDb()
  const key = integrations.verifyApiKey(db, raw)
  if (!key) return Response.json({ error: 'invalid or revoked API key' }, { status: 401 })
  ent.saveDb(db) // persist last_used

  const boards = (db.boards ?? []).map((b: any) => ({
    board_id: b.board_id, name: b.name, program_id: b.program_id,
    readiness: b.readiness, routed_state: b.routed_state,
    tags: b.tags ?? [],
  }))
  return Response.json({ key: key.name, scope: key.scope, count: boards.length, boards })
}
