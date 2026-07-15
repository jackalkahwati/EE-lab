/**
 * GET /api/runs/diff?from=<runId>&to=<runId> — structured design delta
 * between two runs (lib/design-diff). Session-authed; the caller needs at
 * least shared access to BOTH runs.
 */
import { runAccess, isValidRunId } from '@/lib/auth'
import { designDiff } from '@/lib/design-diff'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const from = url.searchParams.get('from') ?? ''
  const to = url.searchParams.get('to') ?? ''
  if (!isValidRunId(from) || !isValidRunId(to)) {
    return Response.json({ error: 'invalid run id' }, { status: 400 })
  }
  for (const id of [from, to]) {
    const a = runAccess(req, id)
    if (a.access === 'unauthenticated') return Response.json({ error: 'sign in required' }, { status: 401 })
    if (a.access === 'forbidden') return Response.json({ error: 'not your board' }, { status: 403 })
  }
  try {
    return Response.json(designDiff(from, to))
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
