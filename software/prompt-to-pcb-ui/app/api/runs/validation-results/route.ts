/**
 * FL-1 validation results ingestion (Phase 6) — measured outcomes flow BACK
 * into the run:
 *   POST {runId, source?, results: [{test, outcome: 'pass'|'fail',
 *         measured?, notes?}]}   → disciplines/validation-results.json
 *   GET  ?run=<id>               → current results
 * Failed results become BLOCKING work-queue items (lib/work-items harvests
 * them), closing the plan → test → fix loop inside Compose.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { runAccess, isValidRunId } from '@/lib/auth'
import { writeWorkItems } from '@/lib/work-items'

export const dynamic = 'force-dynamic'

type Result = { test: string; outcome: 'pass' | 'fail'; measured?: string; notes?: string }

export async function GET(req: Request) {
  const runId = new URL(req.url).searchParams.get('run') ?? ''
  if (!isValidRunId(runId)) return Response.json({ error: 'invalid run id' }, { status: 400 })
  const a = runAccess(req, runId)
  if (a.access === 'unauthenticated') return Response.json({ error: 'sign in required' }, { status: 401 })
  if (a.access === 'forbidden') return Response.json({ error: 'not your board' }, { status: 403 })
  try {
    const p = path.join(process.cwd(), 'public', 'runs', runId, 'disciplines', 'validation-results.json')
    return Response.json(JSON.parse(await fs.readFile(p, 'utf8')))
  } catch {
    return Response.json({ runId, results: [] })
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const runId = typeof body?.runId === 'string' ? body.runId : ''
  if (!isValidRunId(runId)) return Response.json({ error: 'invalid run id' }, { status: 400 })
  const a = runAccess(req, runId)
  if (a.access === 'unauthenticated') return Response.json({ error: 'sign in required' }, { status: 401 })
  if (a.access !== 'owner' && a.access !== 'shared') {
    return Response.json({ error: 'not your board' }, { status: 403 })
  }
  const raw = Array.isArray(body?.results) ? body.results : []
  const results: Result[] = raw
    .filter((r: any) => typeof r?.test === 'string' && ['pass', 'fail'].includes(r?.outcome))
    .slice(0, 100)
    .map((r: any) => ({
      test: String(r.test).slice(0, 160),
      outcome: r.outcome as 'pass' | 'fail',
      ...(r.measured != null ? { measured: String(r.measured).slice(0, 120) } : {}),
      ...(r.notes != null ? { notes: String(r.notes).slice(0, 400) } : {}),
    }))
  if (!results.length) return Response.json({ error: 'results[] with {test, outcome} required' }, { status: 400 })

  const doc = {
    runId,
    source: typeof body?.source === 'string' ? body.source.slice(0, 80) : 'manual',
    recordedBy: a.email,
    recordedAt: new Date().toISOString(),
    results,
  }
  const dir = path.join(process.cwd(), 'public', 'runs', runId, 'disciplines')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'validation-results.json'), JSON.stringify(doc, null, 1))
  // failed tests surface immediately as blocking work items
  const items = await writeWorkItems(runId)
  return Response.json({
    ok: true,
    recorded: results.length,
    failed: results.filter((r) => r.outcome === 'fail').length,
    workItems: items.filter((i) => i.source.includes('validation-results')).length,
  })
}
