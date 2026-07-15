/**
 * POST /api/programs/sync {runId} — upsert a completed Compose run into the
 * enterprise Programs portfolio. Called fire-and-forget by the browser
 * pipeline on completion (the v1 job engine calls the lib directly).
 * Session-authed; requires at least shared access to the run.
 */
import { runAccess, isValidRunId } from '@/lib/auth'
import { syncRunToPrograms } from '@/lib/programs-sync'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const runId = typeof body?.runId === 'string' ? body.runId : ''
    if (!isValidRunId(runId)) return Response.json({ error: 'invalid run id' }, { status: 400 })
    const auth = runAccess(req, runId)
    if (auth.access === 'unauthenticated') return Response.json({ error: 'sign in required' }, { status: 401 })
    if (auth.access === 'forbidden') return Response.json({ error: 'not your board' }, { status: 403 })
    return Response.json(await syncRunToPrograms(runId))
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
