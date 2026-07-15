/**
 * POST /api/runs/fork {parentRunId, note} — create a warm revision of a run
 * (lib/run-fork), record ownership, and track it into the parent's product.
 * Owner-only: forking is a design action.
 */
import { runAccess, isValidRunId, recordRun } from '@/lib/auth'
import { forkRun } from '@/lib/run-fork'
import { trackRun } from '@/lib/design-state'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const parent = typeof body?.parentRunId === 'string' ? body.parentRunId : ''
    const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim() : 'fork'
    if (!isValidRunId(parent)) return Response.json({ error: 'invalid parent run id' }, { status: 400 })
    const a = runAccess(req, parent)
    if (a.access === 'unauthenticated') return Response.json({ error: 'sign in required' }, { status: 401 })
    if (a.access === 'forbidden') return Response.json({ error: 'not your board' }, { status: 403 })
    const runId = await forkRun(parent, note)
    if (a.email) recordRun(a.email, runId)
    const product = trackRun(runId, a.email)
    return Response.json({ runId, productId: product?.productId ?? null })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
