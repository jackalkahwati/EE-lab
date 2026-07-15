/**
 * Pin CRUD (Phase 2). POST {productId, add: {area, kind, value, label}} or
 * {productId, removeId}. Owner-only — pins are engineering decisions, and a
 * shared viewer must not be able to lock someone else's design.
 */
import { randomUUID } from 'node:crypto'
import { sessionEmail } from '@/lib/auth'
import { getProduct, updateProduct, type Pin } from '@/lib/design-state'

export const dynamic = 'force-dynamic'

const AREAS = ['electronics', 'mechanical', 'budget'] as const
const KINDS = ['part', 'board-outline', 'connector-position', 'enclosure-dim', 'budget'] as const

export async function POST(req: Request) {
  const email = sessionEmail(req)
  if (!email) return Response.json({ error: 'sign in required' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const productId = typeof body?.productId === 'string' ? body.productId : ''
  const product = getProduct(productId)
  if (!product) return Response.json({ error: 'unknown product' }, { status: 404 })
  if (product.owner && product.owner !== email.toLowerCase()) {
    return Response.json({ error: 'not your product' }, { status: 403 })
  }

  if (typeof body?.removeId === 'string') {
    const updated = updateProduct(productId, (p) => {
      p.pins = p.pins.filter((x) => x.id !== body.removeId)
    })
    return Response.json({ ok: true, pins: updated?.pins ?? [] })
  }

  const add = body?.add
  if (!add || !AREAS.includes(add.area) || !KINDS.includes(add.kind)
      || typeof add.label !== 'string' || !add.label.trim()
      || typeof add.value !== 'object' || add.value === null) {
    return Response.json({ error: 'add needs {area, kind, value, label}' }, { status: 400 })
  }
  if (product.pins.length >= 32) {
    return Response.json({ error: 'pin limit reached (32)' }, { status: 400 })
  }
  const pin: Pin = {
    id: `pin-${randomUUID().slice(0, 8)}`,
    area: add.area, kind: add.kind,
    value: add.value, label: String(add.label).slice(0, 120),
    createdAt: new Date().toISOString(),
  }
  const updated = updateProduct(productId, (p) => {
    // one pin per (kind,label) — re-pinning replaces, never duplicates
    p.pins = p.pins.filter((x) => !(x.kind === pin.kind && x.label === pin.label))
    p.pins.push(pin)
  })
  return Response.json({ ok: true, pin, pins: updated?.pins ?? [] })
}
