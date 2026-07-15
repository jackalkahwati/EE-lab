/**
 * Product comments (Phase 5).
 *   GET  ?productId=&runId=       — threads (member/owner/demo access)
 *   POST {productId, runId, anchor, text}          — add
 *   POST {productId, deleteId}                     — delete (author or owner)
 */
import { sessionEmail } from '@/lib/auth'
import { getProduct, productAccess } from '@/lib/design-state'
import { listComments, addComment, deleteComment } from '@/lib/comments'

export const dynamic = 'force-dynamic'

function accessOr403(req: Request, productId: string) {
  const email = sessionEmail(req)
  if (!email) return { err: Response.json({ error: 'sign in required' }, { status: 401 }) }
  const product = getProduct(productId)
  if (!product) return { err: Response.json({ error: 'unknown product' }, { status: 404 }) }
  const access = productAccess(email, product)
  if (access === 'forbidden') return { err: Response.json({ error: 'not your product' }, { status: 403 }) }
  return { email, product, access }
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const productId = url.searchParams.get('productId') ?? ''
  const a = accessOr403(req, productId)
  if ('err' in a) return a.err
  return Response.json({ comments: listComments(productId, url.searchParams.get('runId') ?? undefined) })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const productId = typeof body?.productId === 'string' ? body.productId : ''
  const a = accessOr403(req, productId)
  if ('err' in a) return a.err

  if (typeof body?.deleteId === 'string') {
    const ok = deleteComment(productId, body.deleteId, a.email!, a.access === 'owner')
    return ok ? Response.json({ ok: true }) : Response.json({ error: 'not found or not yours' }, { status: 403 })
  }

  const runId = typeof body?.runId === 'string' ? body.runId : ''
  const anchor = typeof body?.anchor === 'string' && body.anchor.trim() ? body.anchor.trim() : 'general'
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!runId || !text) return Response.json({ error: 'runId and text required' }, { status: 400 })
  return Response.json({ ok: true, comment: addComment(productId, { runId, anchor, author: a.email!, text }) })
}
