/**
 * Stage currency endpoint (Phase 2 incremental rebuilds).
 *   GET  /api/runs/stage-hash?run=<id>&stage=<s> — is the stage current?
 *   POST /api/runs/stage-hash {runId, stage, status} — record a terminal
 *        build's inputs hash (called by the orchestrator after each stage).
 * Hashing runs entirely server-side from the run's artifacts + product pins,
 * so no client is trusted about what changed.
 */
import { runAccess, isValidRunId } from '@/lib/auth'
import {
  stageCurrent, recordStageHash, incrementalEnabled,
  STAGE_NAMES, type PipeStageName,
} from '@/lib/design-graph'

export const dynamic = 'force-dynamic'

function checkStage(v: string | null): PipeStageName | null {
  return STAGE_NAMES.includes(v as PipeStageName) ? (v as PipeStageName) : null
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const runId = url.searchParams.get('run') ?? ''
  const stage = checkStage(url.searchParams.get('stage'))
  if (!isValidRunId(runId) || !stage) return Response.json({ error: 'invalid run/stage' }, { status: 400 })
  const a = runAccess(req, runId)
  if (a.access === 'unauthenticated') return Response.json({ error: 'sign in required' }, { status: 401 })
  if (a.access === 'forbidden') return Response.json({ error: 'not your board' }, { status: 403 })
  return Response.json({ enabled: incrementalEnabled(), ...stageCurrent(runId, stage) })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const runId = typeof body?.runId === 'string' ? body.runId : ''
  const stage = checkStage(typeof body?.stage === 'string' ? body.stage : null)
  const status = typeof body?.status === 'string' ? body.status : ''
  if (!isValidRunId(runId) || !stage || !status) {
    return Response.json({ error: 'invalid run/stage/status' }, { status: 400 })
  }
  const a = runAccess(req, runId)
  if (a.access === 'unauthenticated') return Response.json({ error: 'sign in required' }, { status: 401 })
  if (a.access === 'forbidden') return Response.json({ error: 'not your board' }, { status: 403 })
  try {
    recordStageHash(runId, stage, status)
    return Response.json({ ok: true })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
