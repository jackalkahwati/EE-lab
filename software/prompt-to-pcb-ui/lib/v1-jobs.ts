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
import { spawn } from 'node:child_process'
import { makeSession, recordRun, getUser } from '@/lib/auth'
import { runFullPipeline, type PipeStage, type StageEvent } from '@/lib/run-pipeline'
import { trackAndSync } from '@/lib/programs-sync'
import { writeWorkItems } from '@/lib/work-items'
import { normalizeIdBrief, type IdBrief } from '@/lib/id-brief'
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

/** Functional-wiring synthesis (hardware/planner/functional_wire.py): adds the
 *  APPLICATION signal chains the per-IC bus/power synthesis omits (mux->ADC, MCU
 *  drives mux select, reference->channel, input/host connectors, module flag).
 *  Mutates the spec file in place; conservative (only wires patterns it matches,
 *  a no-op otherwise). Best-effort — a failure leaves the spec untouched. */
async function runFunctionalWire(specPath: string, prompt: string): Promise<number> {
  const plannerDir = path.join(process.cwd(), '..', '..', 'hardware', 'planner')
  return new Promise((resolve) => {
    let py
    try {
      py = spawn(process.env.FL_PYTHON || 'python3', [path.join(plannerDir, 'functional_wire.py'), specPath, path.join(plannerDir, 'design_rules.json'), prompt], { timeout: 25_000 })
    } catch { resolve(0); return }
    let out = ''
    py.stdout.on('data', (d) => (out += d))
    py.on('error', () => resolve(0))
    py.on('close', () => {
      const m = out.match(/FUNCWIRE (\d+)/)
      resolve(m ? Number(m[1]) : 0)
    })
  })
}

/** Run the FUNCTIONAL simulation stage (hardware/planner/functional_sim.py):
 *  auto-generates + runs real ngspice decks for the board's critical paths
 *  (reference stability, mux->ADC settling, RS485 drive, PDN rail impedance),
 *  parameterized from the actual netlist. Returns {pass, failCount, summary} or
 *  null if it couldn't run. This is what makes "goes through simulation" mean
 *  FUNCTIONAL-circuit, not just thermal — reported, not hard-blocking (it's a
 *  critical-path capability check with datasheet-class assumptions). */
async function runFunctionalSim(specPath: string): Promise<{ pass: boolean; failCount: number; summary: string } | null> {
  const plannerDir = path.join(process.cwd(), '..', '..', 'hardware', 'planner')
  return new Promise((resolve) => {
    let py
    try {
      py = spawn(process.env.FL_PYTHON || 'python3', [path.join(plannerDir, 'functional_sim.py'), specPath, path.join(plannerDir, 'design_rules.json')], { timeout: 90_000 })
    } catch { resolve(null); return }
    let out = ''
    py.stdout.on('data', (d) => (out += d))
    py.on('error', () => resolve(null))
    py.on('close', (code) => {
      if (code === null) { resolve(null); return }
      const sims = out.split('\n').filter((l) => l.startsWith('SIM ')).map((l) => l.replace(/^SIM /, '').trim())
      const fm = out.match(/FUNCSIM FAIL (\d+)/)
      resolve({ pass: /FUNCSIM PASS/.test(out), failCount: fm ? Number(fm[1]) : 0, summary: sims.map((s) => s.split(/\s+/).slice(0, 2).join(' ')).join(', ').slice(0, 200) })
    })
  })
}

/** Run the design-correctness gate (hardware/planner/design_check.py) on a
 *  synthesized netlist. Returns {pass, failCount, warnCount, summary}, or null
 *  if the gate itself couldn't run (Python missing / script absent) — the caller
 *  treats null as "don't block", so a broken gate never wedges the pipeline. */
async function runDesignGate(
  specPath: string,
  prompt: string,
): Promise<{ pass: boolean; failCount: number; warnCount: number; summary: string } | null> {
  const plannerDir = path.join(process.cwd(), '..', '..', 'hardware', 'planner')
  const script = path.join(plannerDir, 'design_check.py')
  const rules = path.join(plannerDir, 'design_rules.json')
  return new Promise((resolve) => {
    let py
    try {
      py = spawn(process.env.FL_PYTHON || 'python3', [script, specPath, rules, prompt], { timeout: 25_000 })
    } catch {
      resolve(null); return
    }
    let out = ''
    py.stdout.on('data', (d) => (out += d))
    py.stderr.on('data', (d) => (out += d))
    py.on('error', () => resolve(null))
    py.on('close', (code) => {
      if (code === null) { resolve(null); return } // killed / never ran cleanly
      const fails = out.split('\n').filter((l) => l.includes('FAIL ') && l.includes('✗')).map((l) => l.replace(/^.*?✗\s*FAIL\s*/, '').trim())
      const warns = out.split('\n').filter((l) => l.includes('WARN') && l.includes('⚠')).length
      const fm = out.match(/GATE FAIL (\d+)/)
      const failCount = fm ? Number(fm[1]) : fails.length
      resolve({
        pass: /GATE PASS/.test(out) || (code === 0 && failCount === 0),
        failCount,
        warnCount: warns,
        summary: fails.slice(0, 3).join(' · ').slice(0, 240) || 'see design-check log',
      })
    })
  })
}

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

/** Server-side equivalent of the browser's ID scaffold (components/id-scaffold.tsx):
 *  the same standardized 4-view, to-scale orthographic sheet (front · ¾ iso ·
 *  top-down · side), drawn deterministically from the brief's envelope, as plain
 *  SVG. Same geometry math + one shared mm→px scale; hard-coded dark-theme colors
 *  (headless has no CSS theme). One honest difference from the browser sheet: no
 *  nested board footprint — at this point in a headless build the electronics
 *  board does not exist yet. */
function scaffoldSvg(brief: IdBrief): string | null {
  const e = brief.envelopeMm ?? {}
  const x = e.x ?? 0
  const y = e.y ?? 0
  if (!(x > 0 && y > 0)) return null
  const z = (e.z ?? 0) > 0 ? (e.z as number) : Math.max(6, Math.min(x, y) * 0.3)
  const CELL = 190
  const PAD = 30
  const S = CELL / Math.max(x, y, z) // one shared mm->px scale
  const cw = CELL + PAD * 2
  const W = cw * 2
  const cx = (col: number) => col * cw + cw / 2
  const cy = (row: number) => row * cw + cw / 2
  const TXT = 'font-family="ui-monospace,monospace" fill="#9ca3af" text-anchor="middle"'
  const STROKE = '#93b8e8'
  const ortho = (col: number, row: number, wMm: number, hMm: number, label: string) => {
    const w = wMm * S
    const h = hMm * S
    return (
      `<rect x="${(cx(col) - w / 2).toFixed(1)}" y="${(cy(row) - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(Math.min(w, h) * 0.08).toFixed(1)}" fill="rgba(147,184,232,0.06)" stroke="${STROKE}" stroke-width="1.2"/>` +
      `<text x="${cx(col)}" y="${row * cw + 18}" font-size="11" ${TXT}>${label}</text>` +
      `<text x="${cx(col)}" y="${(row + 1) * cw - 10}" font-size="10" ${TXT}>${Math.round(wMm)} × ${Math.round(hMm)} mm</text>`
    )
  }
  // ¾ isometric box, top-right cell — same projection as the browser scaffold.
  const COS30 = Math.cos(Math.PI / 6)
  const SIN30 = 0.5
  const iso = (u: number, v: number, w: number) => ({ px: (u - v) * COS30 * S, py: ((u + v) * SIN30 - w) * S })
  const pts = [
    iso(0, 0, 0), iso(x, 0, 0), iso(x, y, 0), iso(0, y, 0),
    iso(0, 0, z), iso(x, 0, z), iso(x, y, z), iso(0, y, z),
  ]
  const tx = cx(1) - (Math.min(...pts.map((p) => p.px)) + Math.max(...pts.map((p) => p.px))) / 2
  const ty = cy(0) - (Math.min(...pts.map((p) => p.py)) + Math.max(...pts.map((p) => p.py))) / 2
  const P = pts.map((p) => `${(p.px + tx).toFixed(1)},${(p.py + ty).toFixed(1)}`)
  const face = (idx: number[], fill: string) =>
    `<polygon points="${idx.map((i) => P[i]).join(' ')}" fill="${fill}" stroke="${STROKE}" stroke-width="1.2"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}" width="${W}" height="${W}">` +
    `<rect width="${W}" height="${W}" fill="#0f0f0f"/>` + // dark, matching the browser raster + render prompt
    ortho(0, 0, x, z, 'FRONT') +
    face([4, 5, 6, 7], 'rgba(147,184,232,0.10)') + // top
    face([0, 1, 5, 4], 'rgba(147,184,232,0.05)') + // front
    face([1, 2, 6, 5], 'rgba(147,184,232,0.03)') + // right
    `<text x="${cx(1)}" y="18" font-size="11" ${TXT}>PERSPECTIVE</text>` +
    `<text x="${cx(1)}" y="${cw - 10}" font-size="10" ${TXT}>${Math.round(x)} × ${Math.round(y)} × ${Math.round(z)} mm</text>` +
    ortho(0, 1, x, y, 'TOP') +
    ortho(1, 1, y, z, 'SIDE') +
    `</svg>`
  )
}

/** Rasterize the scaffold SVG to a base64 PNG using macOS QuickLook (qlmanage —
 *  already on the deployment host, zero npm dependencies). Best-effort: any
 *  failure returns null and the headless render proceeds WITHOUT a proportion
 *  reference (the id-render prompt then falls back to the envelope text). The
 *  svg + png persist under the run's id/ dir as evidence of what conditioned
 *  the render. */
async function rasterizeScaffold(brief: IdBrief, runId: string): Promise<string | null> {
  const svg = scaffoldSvg(brief)
  if (!svg) return null
  try {
    const dir = path.join(runDir(runId), 'id')
    await fs.mkdir(dir, { recursive: true })
    const svgPath = path.join(dir, 'scaffold.svg')
    await fs.writeFile(svgPath, svg)
    const ok = await new Promise<boolean>((resolve) => {
      const p = spawn('qlmanage', ['-t', '-s', '1024', '-o', dir, svgPath], { timeout: 60_000 })
      p.on('error', () => resolve(false))
      p.on('close', (code) => resolve(code === 0))
    })
    if (!ok) return null
    const png = path.join(dir, 'scaffold.png')
    await fs.rename(path.join(dir, 'scaffold.svg.png'), png) // qlmanage names it <src>.png
    return (await fs.readFile(png)).toString('base64')
  } catch {
    return null
  }
}

/** Headless ID concept render — POSTs the same /api/id-render the browser calls,
 *  so the self-consistency gate fires on v1 API runs too. Returns the stage
 *  record for the job's status surface; never throws. Image generation may be
 *  billing-gated — the route replies { ok:false, reason } honestly and that is
 *  recorded verbatim (never faked); the build continues either way. */
async function renderIdSheet(
  briefRaw: unknown, runId: string, baseUrl: string, headers: Record<string, string>,
): Promise<{ status: string; detail?: string }> {
  try {
    const brief = normalizeIdBrief(briefRaw as Partial<IdBrief>)
    const scaffoldPng = await rasterizeScaffold(brief, runId)
    const noRef = scaffoldPng ? '' : ' · no scaffold reference (rendered from envelope text)'
    const r = await fetch(`${baseUrl}/api/id-render`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ brief, runId, ...(scaffoldPng ? { scaffoldPng } : {}) }),
    })
    const d = await r.json().catch(() => null)
    if (d?.ok) {
      const cons = d?.consistency?.state ? ` · consistency ${d.consistency.state}` : ''
      return { status: 'passed', detail: `${d.provider ?? 'rendered'}${cons}${noRef}` }
    }
    // gated (billing/quota) → skipped; a real fault → failed. Both recorded
    // honestly; neither blocks the build (a product can proceed without a
    // render — the consistency gate then records nothing, which is correct).
    return {
      status: d?.reason === 'unavailable' ? 'skipped' : 'failed',
      detail: `${d?.reason ?? 'error'}: ${d?.message ?? `id-render HTTP ${r.status}`}`,
    }
  } catch (e) {
    return { status: 'failed', detail: `id-render unreachable: ${String(e).slice(0, 200)}` }
  }
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
    try { await writeWorkItems(job.runId) } catch { /* best effort */ }
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
    // Persist the brief to disciplines/id-brief.json in the SAME normalized
    // shape the mechanical route reads back (normalizeIdBrief) — the fidelity
    // loop and the Design tab key off this file. /api/industrial-design also
    // persists it when given a runId, but the headless path guarantees it here
    // so a v1 run always lands the brief whenever one was produced.
    if (idBrief) {
      try {
        const dDir = path.join(runDir(job.runId), 'disciplines')
        await fs.mkdir(dDir, { recursive: true })
        await fs.writeFile(
          path.join(dDir, 'id-brief.json'),
          JSON.stringify(normalizeIdBrief(idBrief as Partial<IdBrief>)))
      } catch { /* best effort — mechanical falls back to box-from-board */ }
    }

    // 1b. ID concept render + self-consistency gate — the same /api/id-render
    //     the browser calls, so headless runs get the concept sheet (and its
    //     judge evidence under id/) too. Best-effort: a gated or failed render
    //     is recorded in the stage detail and the build continues.
    if (idBrief) {
      job.phase = 'id render'
      job.stages['id render'] = { status: 'running' }
      await persist(job)
      job.stages['id render'] = await renderIdSheet(idBrief, job.runId, baseUrl, headers)
      await persist(job)
    }

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

    // 2.5. Plan leg (two-engine collapse): run the planner so the REAL design
    // (real MPN/LCSC parts + netlist) lands as data/chipscale-spec.json BEFORE
    // the pipeline's electronics stage — electronics-cs then builds the chip-
    // scale board from it and skips the part-inventing LLM. Best-effort: with
    // no spec file, electronics-cs falls back exactly as before. The route
    // streams SSE and 409s if a pipeline is already running (v1 jobs are
    // serialized, so that only means a browser run is live — skip honestly).
    job.phase = 'design plan'
    await persist(job)
    try {
      const r = await fetch(
        `${baseUrl}/api/pipeline/run?plan=1&runId=${encodeURIComponent(job.runId)}&prompt=${encodeURIComponent(job.prompt)}`,
        { headers },
      )
      let planFail = ''
      if (r.ok && r.body) {
        // consume the stream to completion so the spec (and the early
        // chip-scale kick's lock) fully settle before the pipeline starts —
        // and capture the design stage's failReason from the SSE events, so a
        // dead planner is NAMED in the job status instead of a generic skip
        // (a launchd-PATH python without jsonschema died in 45ms and the only
        // evidence was buried in the discarded stream).
        const reader = r.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let i: number
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim()
            buf = buf.slice(i + 1)
            if (!line.startsWith('data:')) continue
            try {
              const ev = JSON.parse(line.slice(5)) as { type?: string; id?: string; state?: string; failReason?: string }
              if (ev?.type === 'stage' && ev.id === 'design' && ev.state === 'failed') {
                planFail = String(ev.failReason ?? 'design failed')
              }
            } catch { /* partial or non-JSON SSE line */ }
          }
        }
      }
      const specPath = path.join(runDir(job.runId), 'data', 'chipscale-spec.json')
      const hasSpec = await fs.access(specPath).then(() => true, () => false)
      job.stages['design plan' as PipeStage] = hasSpec
        ? { status: 'passed', detail: 'planner design → chipscale-spec.json (real parts)' }
        : { status: 'skipped', detail: r.ok ? `planner produced no chip-scale spec${planFail ? ` (${planFail})` : ''} — electronics falls back` : `plan leg unavailable (${r.status}) — electronics falls back` }

      // 2.6. DESIGN-CORRECTNESS GATE — the check DRC and the physics sims cannot
      // do. A netlist can route clean (0 DRC) and still be non-functional: an MCU
      // with no flash to boot from, a mux with only its power pin connected, a mux
      // output that never reaches the ADC, a reference whose output goes nowhere,
      // a board that needs a connector and has none. This runs the netlist against
      // hardware/planner/design_rules.json; a FAIL BLOCKS the design plan so a
      // hollow-but-buildable design can never ride through as "done". Fail-safe:
      // if the gate itself can't run, the prior verdict stands (never block on a
      // broken gate).
      if (hasSpec) {
        // 2.55. FUNCTIONAL-WIRING synthesis — add the application signal chains the
        // per-IC bus/power synthesis omits, BEFORE the gate checks and the router
        // builds, so what gets routed is the complete functional board, not a hollow
        // one. (Runs first; the gate then verifies the augmented netlist.)
        const wired = await runFunctionalWire(specPath, job.prompt)
        const gate = await runDesignGate(specPath, job.prompt)
        const wireNote = wired ? ` · functional-wire +${wired}` : ''
        if (gate && !gate.pass) {
          job.stages['design plan' as PipeStage] = {
            status: 'failed',
            detail: `design-correctness gate FAILED (${gate.failCount} issue${gate.failCount === 1 ? '' : 's'})${wireNote}: ${gate.summary}`,
          }
        } else {
          // Gate passed → the design is correct + complete, so a FUNCTIONAL sim is
          // meaningful: run the netlist-parameterized ngspice decks (reference,
          // signal chain, driver, PDN) so "goes through simulation" means the real
          // circuit paths, not just thermal. Reported in the stage detail; the
          // critical-path checks carry datasheet-class assumptions so this informs
          // rather than hard-blocks (the connectivity gate is the hard block).
          const fsim = await runFunctionalSim(specPath)
          const cur = job.stages['design plan' as PipeStage] as { status: string; detail: string }
          const pass = gate ? ` · design gate PASS${gate.warnCount ? ` (${gate.warnCount} advisory)` : ''}` : ''
          const fnote = fsim ? ` · funcsim ${fsim.pass ? 'PASS' : `FAIL(${fsim.failCount})`}` : ''
          job.stages['design plan' as PipeStage] = { status: cur.status as any, detail: `${cur.detail}${wireNote}${pass}${fnote}` }
        }
      }
    } catch (e) {
      job.stages['design plan' as PipeStage] = { status: 'skipped', detail: `plan leg failed (${String(e).slice(0, 120)}) — electronics falls back` }
    }
    void persist(job)

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
    try { await writeWorkItems(job.runId) } catch { /* best effort */ }
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
