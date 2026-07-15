/**
 * Work queue (Phase 3).
 *   GET  /api/runs/work-items?run=<id>  — current items (fresh harvest)
 *   POST /api/runs/work-items {runId}   — harvest + persist (pipeline end)
 * Session-authed with run access; harvesting reads only the run's artifacts.
 */
import { runAccess, isValidRunId } from '@/lib/auth'
import { harvestWorkItems, writeWorkItems } from '@/lib/work-items'

export const dynamic = 'force-dynamic'

function guard(req: Request, runId: string): Response | null {
  if (!isValidRunId(runId)) return Response.json({ error: 'invalid run id' }, { status: 400 })
  const a = runAccess(req, runId)
  if (a.access === 'unauthenticated') return Response.json({ error: 'sign in required' }, { status: 401 })
  if (a.access === 'forbidden') return Response.json({ error: 'not your board' }, { status: 403 })
  return null
}

export async function GET(req: Request) {
  const runId = new URL(req.url).searchParams.get('run') ?? ''
  const bad = guard(req, runId)
  if (bad) return bad
  try {
    return Response.json({ runId, items: await harvestWorkItems(runId) })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const runId = typeof body?.runId === 'string' ? body.runId : ''
  const bad = guard(req, runId)
  if (bad) return bad
  try {
    return Response.json({ runId, items: await writeWorkItems(runId) })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
