/**
 * Product sharing (Phase 5). POST {productId, add: email} | {productId,
 * remove: email}. Owner-only. Members get read + comment on the product and
 * READ on all its revisions' artifacts (lib/auth + proxy consult sharedWith);
 * pins, edits, and approvals stay owner-only.
 */
import { sessionEmail } from '@/lib/auth'
import { getProduct, updateProduct } from '@/lib/design-state'

export const dynamic = 'force-dynamic'

const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export async function POST(req: Request) {
  const email = sessionEmail(req)
  if (!email) return Response.json({ error: 'sign in required' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const productId = typeof body?.productId === 'string' ? body.productId : ''
  const product = getProduct(productId)
  if (!product) return Response.json({ error: 'unknown product' }, { status: 404 })
  if (!product.owner || product.owner !== email.toLowerCase()) {
    return Response.json({ error: 'only the owner can share' }, { status: 403 })
  }
  const add = typeof body?.add === 'string' ? body.add.trim().toLowerCase() : ''
  const remove = typeof body?.remove === 'string' ? body.remove.trim().toLowerCase() : ''
  if (add) {
    if (!EMAIL_RX.test(add)) return Response.json({ error: 'enter a valid email' }, { status: 400 })
    if (add === product.owner) return Response.json({ error: 'that is the owner' }, { status: 400 })
    const updated = updateProduct(productId, (p) => {
      p.sharedWith = [...new Set([...(p.sharedWith ?? []), add])].slice(0, 24)
    })
    return Response.json({ ok: true, sharedWith: updated?.sharedWith ?? [] })
  }
  if (remove) {
    const updated = updateProduct(productId, (p) => {
      p.sharedWith = (p.sharedWith ?? []).filter((e) => e !== remove)
    })
    return Response.json({ ok: true, sharedWith: updated?.sharedWith ?? [] })
  }
  return Response.json({ error: 'add or remove required' }, { status: 400 })
}
