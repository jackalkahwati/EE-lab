/**
 * GET /api/v1/runs/<runId> — programmatic run status (API-key auth).
 * Merges the v1 job record (queued/running/complete/failed + per-stage
 * status), the stage timing telemetry, and the honest electronics verdict.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { v1Auth, V1_RUN_ID } from '@/app/api/v1/_lib'
import { runAccessByEmail } from '@/lib/auth'
import { getJob } from '@/lib/v1-jobs'
import { electronicsVerdict } from '@/lib/run-pipeline'

export const dynamic = 'force-dynamic'

async function readJson(p: string): Promise<any | null> {
  try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return null }
}

export async function GET(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const auth = v1Auth(req)
  if (auth instanceof Response) return auth
  const { runId } = await ctx.params
  if (!V1_RUN_ID.test(runId)) return Response.json({ error: 'invalid run id' }, { status: 400 })
  if (runAccessByEmail(auth.email, runId) === 'forbidden') {
    return Response.json({ error: 'not your board' }, { status: 403 })
  }

  const dir = path.join(process.cwd(), 'public', 'runs', runId)
  const [jobFile, timing, board, idRenderFile, idConsistency] = await Promise.all([
    readJson(path.join(dir, 'v1-job.json')),
    readJson(path.join(dir, 'timing.json')),
    readJson(path.join(dir, 'electronics', 'chipscale-board.json')),
    readJson(path.join(dir, 'id', 'render.json')),
    readJson(path.join(dir, 'id', 'consistency.json')),
  ])
  const job = getJob(runId) ?? jobFile
  if (!job && !board && !timing) {
    return Response.json({ error: `unknown run ${runId}` }, { status: 404 })
  }

  let electronics: { clean: boolean; detail: string } | undefined
  if (board?.boardMm?.w) {
    try { electronics = electronicsVerdict(board) } catch { /* partial board file */ }
  }

  return Response.json({
    runId,
    status: job?.status ?? (board ? 'complete' : 'unknown'),
    phase: job?.phase,
    prompt: job?.prompt,
    stages: job?.stages ?? {},
    error: job?.error,
    // Industrial-design concept sheet + its self-consistency verdict. null when
    // no render landed (e.g. image generation billing-gated) — the honest
    // gated/failed reason then lives in stages['id render'].detail.
    idRender: idRenderFile ? {
      url: idRenderFile.url, provider: idRenderFile.provider,
      consistency: idConsistency ? { state: idConsistency.state, reason: idConsistency.reason ?? null } : null,
    } : null,
    electronics,
    board: board?.boardMm ? {
      widthMm: board.boardMm.w, heightMm: board.boardMm.h,
      components: board.components, drcErrors: board?.drc?.errors ?? null,
      unrouted: board?.drcRepair?.unrouted ?? null,
    } : null,
    timing: timing ? { startedAt: timing.startedAt, finishedAt: timing.finishedAt, totalMs: timing.totalMs } : null,
    artifactsUrl: `/api/v1/runs/${runId}/artifacts`,
  })
}
