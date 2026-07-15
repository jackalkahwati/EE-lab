/**
 * GET /api/products            — the caller's products (owned + shared demos)
 * GET /api/products?run=<id>   — the product containing a given run (or null)
 * Session-authed. Products carry lineage only; artifacts stay run-scoped and
 * keep their own access checks.
 */
import { sessionEmail, isValidRunId } from '@/lib/auth'
import { listProducts, productForRun, productAccess } from '@/lib/design-state'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const email = sessionEmail(req)
  if (!email) return Response.json({ error: 'sign in required' }, { status: 401 })
  const url = new URL(req.url)
  const run = url.searchParams.get('run')
  if (run) {
    if (!isValidRunId(run)) return Response.json({ error: 'invalid run id' }, { status: 400 })
    const p = productForRun(run)
    if (!p) return Response.json({ product: null })
    if (productAccess(email, p) === 'forbidden') {
      return Response.json({ error: 'not your product' }, { status: 403 })
    }
    return Response.json({ product: p })
  }
  return Response.json({ products: listProducts(email) })
}
