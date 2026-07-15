/**
 * Provenance (Phase 7).
 *   GET  ?productId=            — verify-history + trust-status for the
 *                                 product's Checkpoint store (owner/member)
 *   POST {runId}                — seal a revision now (owner; used for
 *                                 backfill and an explicit "seal" action)
 */
import { sessionEmail, runAccess, isValidRunId } from '@/lib/auth'
import { getProduct, productAccess } from '@/lib/design-state'
import { sealRevision, verifyProvenance } from '@/lib/checkpoint-seal'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(req: Request) {
  const email = sessionEmail(req)
  if (!email) return Response.json({ error: 'sign in required' }, { status: 401 })
  const productId = new URL(req.url).searchParams.get('productId') ?? ''
  const product = getProduct(productId)
  if (!product) return Response.json({ error: 'unknown product' }, { status: 404 })
  if (productAccess(email, product) === 'forbidden') {
    return Response.json({ error: 'not your product' }, { status: 403 })
  }
  return Response.json(await verifyProvenance(productId))
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const runId = typeof body?.runId === 'string' ? body.runId : ''
  if (!isValidRunId(runId)) return Response.json({ error: 'invalid run id' }, { status: 400 })
  const a = runAccess(req, runId)
  if (a.access === 'unauthenticated') return Response.json({ error: 'sign in required' }, { status: 401 })
  if (a.access !== 'owner') return Response.json({ error: 'owner only' }, { status: 403 })
  return Response.json(await sealRevision(runId))
}
