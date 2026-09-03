/**
 * Revision approval request (Phase 5). POST {productId, runId} — owner-only:
 * creates a board_review_approval in the EXISTING enterprise approvals system
 * (evidence + blocked-claims snapshots included by requestApproval), scoped
 * to the product's portfolio board, so it appears in the enterprise console's
 * approvals view like any other request.
 */
import { sessionEmail } from '@/lib/auth'
import { getProduct } from '@/lib/design-state'
// @ts-ignore - plain ESM modules shared with node scripts
import * as ent from '@/lib/enterprise/store.mjs'
// @ts-ignore
import * as approvals from '@/lib/enterprise/approvals.mjs'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const email = sessionEmail(req)
  if (!email) return Response.json({ error: 'sign in required' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const productId = typeof body?.productId === 'string' ? body.productId : ''
  const runId = typeof body?.runId === 'string' ? body.runId : ''
  const product = getProduct(productId)
  if (!product) return Response.json({ error: 'unknown product' }, { status: 404 })
  if (!product.owner || product.owner !== email.toLowerCase()) {
    return Response.json({ error: 'only the owner can request approval' }, { status: 403 })
  }
  if (!product.revisions.some((r) => r.runId === runId)) {
    return Response.json({ error: 'run is not a revision of this product' }, { status: 400 })
  }
  if (!product.boardId) {
    return Response.json({ error: 'product has no portfolio board yet (complete a build first)' }, { status: 409 })
  }
  let db: any
  try {
    db = ent.loadDb()
  } catch (e) {
    if (ent.isStoreUnreadable(e)) return ent.storeUnreadableResponse()
    throw e
  }
  const a = approvals.requestApproval(db, {
    approval_type: 'board_review_approval',
    scope: { board_id: product.boardId },
    requested_by: email,
    notes: `Compose revision ${runId} of "${product.name}"`,
    actor: email,
  }) as { error?: string; approval_id?: string; status?: string }
  if (a?.error) return Response.json({ error: a.error }, { status: 400 })
  ent.saveDb(db)
  return Response.json({ ok: true, approvalId: a.approval_id, status: a.status })
}
