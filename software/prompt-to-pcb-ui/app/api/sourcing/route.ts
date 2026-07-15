/**
 * Sourcing workspace API (Phase 4).
 *   GET  /api/sourcing?mpn=<mpn>            — live quote (or the honest gate)
 *   POST /api/sourcing {runId, ref, mpn}    — select a part for a BOM line:
 *        writes a part PIN on the run's product (owner-only) so every future
 *        regeneration must keep it; the UI then offers a targeted revision.
 */
import { sessionEmail, runAccess, isValidRunId } from '@/lib/auth'
import { lookupPart, sourcingProvider, gatedReason } from '@/lib/sourcing'
import { productForRun, updateProduct, type Pin } from '@/lib/design-state'
import { randomUUID } from 'node:crypto'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  if (!sessionEmail(req)) return Response.json({ error: 'sign in required' }, { status: 401 })
  const mpn = (new URL(req.url).searchParams.get('mpn') ?? '').trim()
  if (!mpn || mpn.length > 64) return Response.json({ error: 'mpn required' }, { status: 400 })
  return Response.json({ mpn, provider: sourcingProvider()?.name ?? null, quote: await lookupPart(mpn) })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const runId = typeof body?.runId === 'string' ? body.runId : ''
  const ref = typeof body?.ref === 'string' ? body.ref.trim().slice(0, 16) : ''
  const mpn = typeof body?.mpn === 'string' ? body.mpn.trim().slice(0, 64) : ''
  if (!isValidRunId(runId) || !ref || !mpn) {
    return Response.json({ error: 'runId, ref, mpn required' }, { status: 400 })
  }
  const a = runAccess(req, runId)
  if (a.access === 'unauthenticated') return Response.json({ error: 'sign in required' }, { status: 401 })
  if (a.access === 'forbidden') return Response.json({ error: 'not your board' }, { status: 403 })
  const product = productForRun(runId)
  if (!product) return Response.json({ error: 'run has no product (build first)' }, { status: 404 })
  if (product.owner && product.owner !== (a.email ?? '').toLowerCase()) {
    return Response.json({ error: 'not your product' }, { status: 403 })
  }
  const pin: Pin = {
    id: `pin-${randomUUID().slice(0, 8)}`,
    area: 'electronics', kind: 'part',
    value: { mpn, ref },
    label: `${ref} = ${mpn}`,
    createdAt: new Date().toISOString(),
  }
  updateProduct(product.productId, (p) => {
    p.pins = p.pins.filter((x) => !(x.kind === 'part' && (x.value as any)?.ref === ref))
    p.pins.push(pin)
  })
  return Response.json({
    ok: true, pin,
    // the UI seeds this into the chat → edit router → targeted/full rebuild
    revisePrompt: `Use ${mpn} for ${ref} (pinned). Update the design accordingly.`,
    gated: !sourcingProvider() ? gatedReason() : null,
  })
}
