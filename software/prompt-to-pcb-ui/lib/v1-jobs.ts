/**
 * v1 API job engine — server-side prompt→product orchestration behind the
 * programmatic API (and thus the CLI + MCP server).
 *
 * A job runs the SAME flow the Compose UI does, by calling the app's own HTTP
 * routes with a server-minted session for the API key's owner: industrial
 * design (force) → architect (self-answered until it finalizes a spec) →
 * runFullPipeline (the exact orchestrator the browser uses, with baseUrl
 * threaded so Node fetch works). Nothing is duplicated and every honest gate
 * (DRC-clean electronics, fitCheck, sim verdicts) applies unchanged.
 *
 * Jobs are SERIALIZED (one pipeline at a time) — the deployment is a single
 * node and a pipeline run is heavy (KiCad, freerouting, Onshape, LLM calls).
 * State is persisted to public/runs/<id>/v1-job.json on every transition, so
 * status survives restarts; the in-memory map only adds queue position.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { makeSession, recordRun, getUser } from '@/lib/auth'
import { runFullPipeline, type StageEvent } from '@/lib/run-pipeline'
import { trackAndSync } from '@/lib/programs-sync'
import type { ProductSpec } from '@/lib/product-spec'

export type V1Job = {
  runId: string
  mode?: 'build' | 'rebuild'
  prompt: string
  owner: string
  status: 'queued' | 'running' | 'complete' | 'failed'
  phase?: string
  stages: Record<string, { status: string; detail?: string }>
  error?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

const jobs = new Map<string, V1Job>()
let chain: Promise<void> = Promise.resolve()
let queued = 0

const runDir = (runId: string) => path.join(process.cwd(), 'public', 'runs', runId)

async function persist(job: V1Job) {
  try {
    await fs.mkdir(runDir(job.runId), { recursive: true })
    await fs.writeFile(path.join(runDir(job.runId), 'v1-job.json'), JSON.stringify(job))
  } catch { /* best effort — in-memory state still serves */ }
}

export function getJob(runId: string): V1Job | undefined {
  return jobs.get(runId)
}

export function queueDepth(): number {
  return queued
}

/** Self-answering interview against a stateless Q&A route (architect /
 *  industrial-design pattern): accept each question's suggested default until
 *  the model finalizes. Returns the route's final JSON. */
async function selfAnswered(
  url: string, base: Record<string, unknown>, headers: Record<string, string>, doneKey: string,
): Promise<any> {
  const answers: { question: string; answer: string }[] = []
  for (let round = 0; round < 5; round++) {
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ ...base, answers }),
    })
    const d = await r.json().catch(() => ({}))
    if (d?.error) throw new Error(String(d.error))
    if (d?.type === doneKey) return d
    if (d?.type === 'question') {
      answers.push({
        question: String(d.question ?? 'remaining requirements'),
        answer: String(d.default || (Array.isArray(d.options) && d.options[0]) || 'use your best judgment'),
      })
      continue
    }
    throw new Error(`unexpected reply from ${url}`)
  }
  throw new Error('interview did not converge in 5 rounds')
}

async function runJob(job: V1Job, baseUrl: string) {
  job.status = 'running'
  job.startedAt = new Date().toISOString()
  await persist(job)
  const cookie = `fl_session=${makeSession(job.owner)}`
  const headers = { cookie }
  try {
    // REBUILD mode: the run already has its spec + artifacts (e.g. a fork) —
    // skip ID/architect and go straight to the pipeline. With incremental
    // enabled, unchanged stages skip as 'current'; changed ones re-run.
    if (job.mode === 'rebuild') {
      const spec = JSON.parse(
        await fs.readFile(path.join(runDir(job.runId), 'product-spec.json'), 'utf8')) as ProductSpec
      job.phase = 'pipeline'
      await persist(job)
      const result = await runFullPipeline({
        spec, runId: job.runId, baseUrl, headers, dirtyOnly: true,
        onStage: (e: StageEvent) => {
          job.stages[e.stage] = { status: e.status, detail: e.detail }
          void persist(job)
        },
      })
      const bad = Object.entries(result.stages)
        .filter(([, s]) => s?.status === 'failed' || s?.status === 'blocked')
        .map(([k, s]) => `${k}: ${s?.detail ?? s?.status}`)
      job.status = bad.length ? 'failed' : 'complete'
      if (bad.length) job.error = bad.join(' | ')
      job.phase = undefined
      try { await trackAndSync(job.runId, job.owner) } catch { /* best effort */ }
      return
    }
    // 1. Industrial design brief (one-click force — persists id-brief.json).
    //    Best-effort: a product can proceed without a brief.
    job.phase = 'industrial design'
    await persist(job)
    let idBrief: unknown
    try {
      const id = await fetch(`${baseUrl}/api/industrial-design`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ request: job.prompt, answers: [], force: true, runId: job.runId }),
      }).then((r) => r.json())
      if (id?.type === 'brief') idBrief = id.brief
    } catch { /* advisory */ }

    // 2. Product spec via the architect (self-answered clarifications).
    job.phase = 'product architecture'
    await persist(job)
    const arch = await selfAnswered(
      `${baseUrl}/api/architect`,
      { request: job.prompt, ...(idBrief ? { idBrief } : {}) },
      headers, 'spec')
    const spec = arch.spec as ProductSpec
    await fs.mkdir(runDir(job.runId), { recursive: true })
    await fs.writeFile(path.join(runDir(job.runId), 'product-spec.json'), JSON.stringify(spec))

    // 3. Full pipeline — the browser's exact orchestrator, server-side.
    job.phase = 'pipeline'
    await persist(job)
    const result = await runFullPipeline({
      spec, runId: job.runId, baseUrl, headers,
      dirtyOnly: true, // no-op unless FL_INCREMENTAL=1 (server-decided)
      onStage: (e: StageEvent) => {
        job.stages[e.stage] = { status: e.status, detail: e.detail }
        void persist(job)
      },
    })
    const failed = Object.entries(result.stages)
      .filter(([, s]) => s?.status === 'failed' || s?.status === 'blocked')
      .map(([k, s]) => `${k}: ${s?.detail ?? s?.status}`)
    job.status = failed.length ? 'failed' : 'complete'
    if (failed.length) job.error = failed.join(' | ')
    job.phase = undefined
    // Portfolio bridge: completed API builds appear in Programs too.
    try { await trackAndSync(job.runId, job.owner) } catch { /* best effort */ }
  } catch (e) {
    job.status = 'failed'
    job.error = String(e)
  } finally {
    job.finishedAt = new Date().toISOString()
    await persist(job)
  }
}

/** Enqueue a build. Returns the job immediately; the pipeline runs serialized
 *  in the background of this long-lived server process. */
export function enqueueBuild(prompt: string, owner: string, baseUrl: string, opts?: { rebuildRunId?: string }): V1Job {
  const job: V1Job = {
    runId: opts?.rebuildRunId ?? `run-${randomUUID()}`,
    mode: opts?.rebuildRunId ? 'rebuild' : 'build',
    prompt, owner,
    status: 'queued',
    stages: {},
    createdAt: new Date().toISOString(),
  }
  jobs.set(job.runId, job)
  // Ownership BEFORE the run starts, so the artifacts are private to the key's
  // owner from the first byte (unowned runs are shared demos). No-op if the
  // key's actor has no user record — the run still builds, just unowned.
  if (getUser(owner)) recordRun(owner, job.runId)
  void persist(job)
  queued += 1
  chain = chain
    .then(() => runJob(job, baseUrl))
    .catch(() => { /* runJob handles its own failure state */ })
    .finally(() => { queued -= 1 })
  return job
}
