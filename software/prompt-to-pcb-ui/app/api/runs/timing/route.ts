/**
 * Per-stage pipeline timing sink — persists the orchestrator's wall-clock record
 * to public/runs/<id>/timing.json so a run can be MEASURED after the fact without
 * depending on the dev server's stdout surviving (a redirected `next dev` log is
 * orphaned the moment the server is relaunched, which is exactly how per-stage
 * timing got inferred from the wrong artifacts once already).
 *
 *   POST /api/runs/timing  { runId, startedAt, finishedAt?, totalMs?, stages: [...] }
 *
 * The orchestrator runs in the BROWSER (lib/run-pipeline.ts is imported by the
 * 'use client' compose page), so it can't write the file itself — it posts the
 * whole in-memory snapshot here and the last write wins. Every POST carries the
 * COMPLETE record, never a delta, so a dropped or out-of-order write can only
 * cost freshness, never corrupt the document.
 *
 * Hardening:
 * - Auth: the global gate (proxy.ts) already 401s EVERY /api/* request without a
 *   valid fl_session cookie — /api/runs/timing matches none of its
 *   PUBLIC_PATTERNS — so a session is required to reach this handler at all.
 *   It is re-checked here anyway (defense in depth): route-level enforcement
 *   must not silently depend on the middleware matcher staying in sync. Same
 *   posture as the pipeline's other artifact routes (/api/mechanical,
 *   /api/discipline), which also key artifacts off runId under the global gate.
 * - Body cap: 256KB — a timing snapshot is a few KB; anything bigger is abuse.
 * - Shape: only a document matching RunTiming (lib/run-pipeline.ts) is
 *   persisted, REBUILT from the validated fields so unknown keys never land on
 *   disk. Anything else is rejected 400.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { isValidRunId, sessionEmail } from '@/lib/auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_BODY_BYTES = 256 * 1024
const MAX_STAGES = 200
// mirrors PipeStatus in lib/run-pipeline.ts (the browser client sends exactly these)
const STATUSES = new Set(['pending', 'running', 'passed', 'failed', 'blocked', 'skipped'])

const isIsoish = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 40
const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** Validate + rebuild one StageTiming entry; null if it doesn't fit the shape. */
function sanitizeStage(s: unknown): Record<string, unknown> | null {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null
  const t = s as Record<string, unknown>
  if (typeof t.stage !== 'string' || !t.stage || t.stage.length > 40) return null
  if (typeof t.status !== 'string' || !STATUSES.has(t.status)) return null
  if (!isIsoish(t.startedAt)) return null
  if (t.endedAt !== undefined && !isIsoish(t.endedAt)) return null
  if (t.ms !== undefined && !isMs(t.ms)) return null
  if (t.detail !== undefined && typeof t.detail !== 'string') return null
  if (t.unfinished !== undefined && typeof t.unfinished !== 'boolean') return null
  const out: Record<string, unknown> = { stage: t.stage, status: t.status, startedAt: t.startedAt }
  if (t.endedAt !== undefined) out.endedAt = t.endedAt
  if (t.ms !== undefined) out.ms = t.ms
  if (t.detail !== undefined) out.detail = String(t.detail).slice(0, 2000)
  if (t.unfinished !== undefined) out.unfinished = t.unfinished
  return out
}

export async function POST(req: Request) {
  // Defense-in-depth session check (the proxy already enforces this globally).
  if (!sessionEmail(req)) return Response.json({ error: 'sign in required' }, { status: 401 })

  let raw = ''
  try { raw = await req.text() } catch { /* fall through to the shape check */ }
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json({ error: 'body too large' }, { status: 413 })
  }
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(raw) } catch { /* fall through to the id check */ }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'invalid body' }, { status: 400 })
  }

  const runId = String(body?.runId ?? '')
  if (!isValidRunId(runId)) return Response.json({ error: 'missing/invalid runId' }, { status: 400 })

  // Shape validation: persist only a RunTiming-shaped document (rebuilt).
  if (!isIsoish(body.startedAt)) return Response.json({ error: 'invalid startedAt' }, { status: 400 })
  if (body.finishedAt !== undefined && !isIsoish(body.finishedAt)) {
    return Response.json({ error: 'invalid finishedAt' }, { status: 400 })
  }
  if (body.totalMs !== undefined && !isMs(body.totalMs)) {
    return Response.json({ error: 'invalid totalMs' }, { status: 400 })
  }
  if (!Array.isArray(body.stages) || body.stages.length > MAX_STAGES) {
    return Response.json({ error: 'invalid stages' }, { status: 400 })
  }
  const stages: Record<string, unknown>[] = []
  for (const s of body.stages) {
    const clean = sanitizeStage(s)
    if (!clean) return Response.json({ error: 'invalid stage entry' }, { status: 400 })
    stages.push(clean)
  }
  const doc: Record<string, unknown> = { runId, startedAt: body.startedAt, stages }
  if (body.finishedAt !== undefined) doc.finishedAt = body.finishedAt
  if (body.totalMs !== undefined) doc.totalMs = body.totalMs

  const dir = path.join(process.cwd(), 'public', 'runs', runId)
  const dest = path.join(dir, 'timing.json')
  try {
    await fs.mkdir(dir, { recursive: true })
    // write-then-rename: a reader polling timing.json mid-run must never catch a
    // half-written document (rename is atomic within the directory).
    const tmp = `${dest}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(doc, null, 2))
    await fs.rename(tmp, dest)
  } catch (e: any) {
    return Response.json({ error: 'write failed', detail: String(e?.message ?? e).slice(0, 120) }, { status: 500 })
  }
  return Response.json({ ok: true, runId })
}
