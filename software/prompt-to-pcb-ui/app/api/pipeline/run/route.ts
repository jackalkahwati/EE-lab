/**
 * Real pipeline runner: placement → routing → validation on an isolated
 * COPY of the board, streamed to the browser as SSE events.
 *
 * - Never touches the working rev-a-routed.kicad_pcb (runs in a temp
 *   workspace; promoting a result back is an explicit manual step).
 * - Uses the existing flroute release binary, never rebuilds it.
 * - Gates are enforced: placement gate failure blocks routing/validation.
 * - Ends by running sync-board.sh against the run output so the UI's
 *   Board/BOM/Gates tabs refresh with the new real artifacts.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callLLMText, extractRust } from '@/lib/llm'
// In-process handle on the chip-scale board builder: plan mode kicks it EARLY
// (the moment the merged design lands) so it overlaps the variant routing/
// validation below instead of running after the whole SSE chain. Direct module
// call, not an HTTP fetch — works headless and needs no origin guessing; the
// electronics-cs in-flight lock keeps the client's later call from double-building.
import { POST as electronicsCsBuild } from '@/app/api/electronics-cs/route'
import {
  canRun,
  chargeCredits,
  creditsAvailable,
  creditsForRun,
  getUser,
  isAdminRequest,
  isValidRunId,
  recordRun,
  runAccess,
  sessionEmail,
} from '@/lib/auth'
import { hasByok } from '@/lib/byok'
import { v1Auth } from '@/app/api/v1/_lib'
import { runDesignGate, runFunctionalWire } from '@/lib/design-gate'
import { resolvePlanModel } from '@/lib/plan-llm'
import { kicadCli, kicadPython } from '@/lib/toolchain'

export const dynamic = 'force-dynamic'
export const maxDuration = 1800

/** Forward the caller's identity/model/BYOK headers into an internal sub-call
 *  (electronics-cs is invoked as a direct function call with a synthetic
 *  Request) so plan routing resolves the SAME plan, model selection, and BYOK
 *  there as it did here. Without this the sub-call would look anonymous. */
function fwdHeaders(req: Request, base: Record<string, string>): Record<string, string> {
  const h = { ...base }
  for (const k of ['cookie', 'x-fl-model', 'x-llm-provider', 'x-llm-key']) {
    const v = req.headers.get(k)
    if (v) h[k] = v
  }
  return h
}

const KCLI = kicadCli()
const KPY = kicadPython()
const RUN_TIMEOUT_MS = 20 * 60 * 1000

// ---- planner python resolution ----------------------------------------------
// plan_cli.py needs jsonschema (UCS schema validation). Which `python3` wins
// depends on who started this server: an interactive shell resolves the
// Xcode/CLT python3 (has jsonschema), while the launchd deployment's PATH puts
// homebrew's bare python3 first — spawning that one made every headless plan
// leg die in ~45ms with ModuleNotFoundError, so the run silently fell back to
// LLM-invented parts. Probe once per process and cache the first interpreter
// that can actually import the planner's dependency.
let plannerPyCache: string | null = null
function plannerPython(): string {
  if (plannerPyCache) return plannerPyCache
  const candidates = [process.env.FL_PYTHON, 'python3', '/usr/bin/python3'].filter(Boolean) as string[]
  for (const c of candidates) {
    try {
      if (spawnSync(c, ['-c', 'import jsonschema'], { timeout: 15_000 }).status === 0) {
        plannerPyCache = c
        return c
      }
    } catch { /* candidate missing — try the next */ }
  }
  plannerPyCache = 'python3' // let the spawn fail loudly with the real traceback
  return plannerPyCache
}

// ---- firmware app-code generation (general, board-agnostic) -----------------
// Writing no_std embedded-hal 1.0 Rust is the hardest codegen target here, so we
// (1) use the strongest model, (2) show a golden example of the correct SHAPE,
// (3) encode the exact failure modes we've observed as hard rules, and (4) keep
// a deterministic baseline as the floor. The model then ENHANCES the baseline;
// on failure the board still ships the compiling deterministic control loop.
const FW_MODEL = process.env.FIRMWARE_MODEL || 'claude-opus-4-8'

// Hard rules — each line is a real, observed compile-failure mode.
const FW_RULES = [
  'no_std + core only. NO std, NO alloc, NO println!/format!/eprintln!/dbg!.',
  'embedded-hal 1.0 trait paths ONLY: i2c::I2c, spi::SpiDevice, digital::OutputPin, ' +
    'pwm::SetDutyCycle, delay::DelayNs; embedded_io::{Read, Write}. ' +
    'NEVER embedded_hal::digital::v2 — that is the removed 0.2 API and does not exist here.',
  'Call ONLY the real public functions shown in the crate modules. Do not invent methods or fields.',
  'Error handling: propagate with `?` or discard with `let _ = ...`. NEVER construct an associated ' +
    'error variant such as `I2C::Error::Other` — those associated error types have no known variants.',
  'Only reference peripherals whose module is present below. No `main`, no `#[entry]`, ' +
    'no panic handler — this is a library module (src/app.rs).',
].map((r, i) => `${i + 1}. ${r}`).join('\n')

// Golden example — the correct SHAPE (imports, generic bounds, error handling)
// for a representative peripheral. Board-agnostic: the model adapts it to
// whatever modules THIS board actually has.
const FW_GOLDEN = `\`\`\`rust
#![allow(dead_code)]
use embedded_hal::i2c::I2c;
use embedded_hal::delay::DelayNs;

/// Owns the peripherals present on the board, generic over the concrete HAL types.
pub struct Controller<I2C, D> {
    sensor: crate::tempsensor::TempSensor<I2C>,
    delay: D,
    last_milli_c: i32,
}

impl<I2C: I2c, D: DelayNs> Controller<I2C, D> {
    pub fn new(sensor: crate::tempsensor::TempSensor<I2C>, delay: D) -> Self {
        Self { sensor, delay, last_milli_c: 0 }
    }
    /// Bring up every peripheral; false if one does not answer.
    pub fn init(&mut self) -> Result<bool, I2C::Error> {
        self.sensor.probe()
    }
    /// One control iteration: read the sensor, keep the latest value, pace the loop.
    pub fn control_step(&mut self) -> Result<(), I2C::Error> {
        self.last_milli_c = self.sensor.read_milli_c()?;
        self.delay.delay_ms(100);
        Ok(())
    }
    pub fn latest_milli_c(&self) -> i32 { self.last_milli_c }
}
\`\`\``

// Scaffold-fill markers (must match gen_firmware_compose.py emit_app()).
const FILL_BEGIN = '// >>> FL_APP_FILL_BEGIN'
const FILL_END = '// >>> FL_APP_FILL_END'

// Splice a rewritten body between the FL_APP_FILL markers, preserving EVERYTHING
// else (struct, bounds, new/init, control_step signature, trailing Ok(())).
function spliceFillBody(scaffold: string, body: string, begin: string, end: string): string | null {
  const b = scaffold.indexOf(begin)
  const e = scaffold.indexOf(end)
  if (b < 0 || e < 0 || e < b) return null
  const afterBegin = scaffold.indexOf('\n', b) + 1
  return scaffold.slice(0, afterBegin) + body.replace(/\n*$/, '\n') + '        ' + scaffold.slice(e)
}

// The model is asked for statements only, but tolerate it returning the whole
// function or the marker block: extract just the inner statements, and drop a
// trailing Ok(()) (the scaffold already returns one).
function normalizeFillBody(text: string, begin: string, end: string): string {
  let t = text
  if (t.includes(begin) && t.includes(end)) {
    t = t.slice(t.indexOf(begin) + begin.length, t.indexOf(end)).replace(/^[^\n]*\n/, '')
  } else if (/fn\s+control_step/.test(t)) {
    const s = t.indexOf('{', t.search(/fn\s+control_step/))
    if (s >= 0) {
      let depth = 0, i = s
      for (; i < t.length; i++) {
        if (t[i] === '{') depth++
        else if (t[i] === '}') { depth--; if (depth === 0) break }
      }
      t = t.slice(s + 1, i)
    }
  }
  return t.replace(/\bOk\(\(\)\)\s*;?\s*$/, '').trim()
}

type PipelineEvent =
  | { type: 'stage'; id: string; state: string; failReason?: string }
  | { type: 'log'; stage: string; text: string; level?: string }
  | { type: 'design'; spec: Record<string, unknown> }
  | { type: 'coverage'; mapped: string[]; dropped: string[] }
  | { type: 'sourced'; parts: Record<string, unknown>[] }
  | {
      type: 'done'
      status: 'PASSED' | 'GATE FAILED'
      boardPath: string
      fabZip?: string
      fwZip?: string
      runDir?: string
    }
  | { type: 'error'; message: string }

// Per-user run concurrency. The old single global boolean made the app
// single-tenant (the 2nd concurrent user ANYWHERE got a 409). Instead track
// running runs per account: different users run concurrently up to a global
// capacity bound (the single machine's real limit), while one account can't
// hold more than its per-user slot. Lives on globalThis so it survives HMR.
const runReg = (globalThis as unknown as { __flRuns?: Map<string, number> })
runReg.__flRuns ??= new Map<string, number>()
const RUNS: Map<string, number> = runReg.__flRuns
const MAX_CONCURRENT_RUNS = Number(process.env.FL_MAX_CONCURRENT_RUNS || 3)
const MAX_RUNS_PER_USER = Number(process.env.FL_MAX_RUNS_PER_USER || 1)
function totalRunning(): number {
  let n = 0
  for (const c of RUNS.values()) n += c
  return n
}
function acquireRun(email: string): void {
  RUNS.set(email, (RUNS.get(email) ?? 0) + 1)
}
function releaseRun(email: string): void {
  const c = (RUNS.get(email) ?? 0) - 1
  if (c > 0) RUNS.set(email, c)
  else RUNS.delete(email)
}

/**
 * CSRF guard for a cookie-authenticated GET that spends credits. Browsers stamp
 * Sec-Fetch-Site on every request: 'same-origin' (the compose EventSource) and
 * 'none' (typed URL) are the app itself; 'cross-site' / 'same-site' is another
 * origin riding the user's cookie and is refused. Non-browser callers omit the
 * header entirely (lib/v1-jobs.ts server-side fetch, curl): those must present
 * an explicit non-browser marker — X-Requested-With, which no cross-site
 * navigation/EventSource can set — or a valid flk_ API key. The session cookie
 * is still required below; this only proves the request was not forged.
 */
function csrfRejection(req: Request): Response | null {
  const site = req.headers.get('sec-fetch-site')
  if (site === 'same-origin' || site === 'none') return null
  if (site) {
    return Response.json({ error: 'cross-site request refused' }, { status: 403 })
  }
  if (req.headers.get('x-requested-with')) return null
  // Older browsers (Safari < 16.4) send no Sec-Fetch-Site and EventSource
  // cannot add headers, but they do send Referer/Origin: accept when that
  // host matches the request host. A cross-site page cannot forge either.
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
  for (const h of ['origin', 'referer']) {
    const v = req.headers.get(h)
    if (!v || !host) continue
    try { if (new URL(v).host === host) return null } catch { /* not a URL */ }
  }
  if (/^Bearer\s+flk_/i.test(req.headers.get('authorization') ?? '')) {
    const v1 = v1Auth(req)
    if (!(v1 instanceof Response)) return null
  }
  return Response.json(
    { error: 'non-browser callers must send X-Requested-With or a flk_ API key' },
    { status: 403 },
  )
}

export async function GET(req: Request) {
  const csrf = csrfRejection(req)
  if (csrf) return csrf
  // Live pipeline execution needs the lab workstation (KiCad CLI, flroute
  // binary, Python toolchain). On a cloud deploy those don't exist, fail
  // clean instead of spawning into nothing.
  if (!fs.existsSync(KCLI)) {
    return new Response(
      'Pipeline execution runs on the FirstLight lab workstation and is not available in this preview deployment. Browse existing runs, boards, and BOMs instead.',
      { status: 503 },
    )
  }
  // account + freemium quota: every run belongs to a signed-in user
  const userEmail = sessionEmail(req)
  if (!userEmail) {
    return new Response('sign in required', { status: 401 })
  }
  const userRec = getUser(userEmail)
  if (!userRec) return new Response('unknown account', { status: 401 })
  const admin = isAdminRequest(req)
  // LLM source: admin runs on the Mac subscription; a signed-up user runs on the
  // platform-funded model when one is configured (OPENROUTER_API_KEY), else they
  // must bring their own key. Only refuse when there is NO way to run inference
  // for them — no platform key and no BYOK.
  if (!admin && !hasByok(req) && !process.env.OPENROUTER_API_KEY) {
    return new Response(
      'Add your own model API key in settings to run, or subscribe once platform models are enabled.',
      { status: 402 },
    )
  }
  // Run allowance: a few free runs, then subscribe. BYOK does NOT grant
  // unlimited runs — it satisfies the LLM requirement, not the platform run
  // limit. Admin is uncapped.
  if (!canRun(userRec) && !admin) {
    return new Response(
      `You've used your free runs (${creditsAvailable(userRec)} left). Subscribe to Pro or Enterprise to unlock more.`,
      { status: 402 },
    )
  }
  // Selected model rides as the `model` query param (EventSource GET has no
  // custom headers). resolvePlanModel routes BYOK→their key, admin→subscription.
  const resolvedModel = resolvePlanModel(req, new URL(req.url).searchParams.get('model'))
  if (resolvedModel.error) {
    return new Response(resolvedModel.error, { status: resolvedModel.status ?? 402 })
  }
  // multi-tenant concurrency: one run per account, bounded total load. Admin is
  // uncapped (Jack's own testing). A user who already has a run in flight gets a
  // clear 409; when the machine is at capacity, a 503 with Retry-After.
  if (!admin) {
    if ((RUNS.get(userEmail) ?? 0) >= MAX_RUNS_PER_USER) {
      return new Response('You already have a run in progress. Wait for it to finish before starting another.', { status: 409 })
    }
    if (totalRunning() >= MAX_CONCURRENT_RUNS) {
      return new Response('The build queue is at capacity right now. Try again in a few minutes.', {
        status: 503,
        headers: { 'Retry-After': '120' },
      })
    }
  }

  const qp = new URL(req.url).searchParams
  const prompt = qp.get('prompt') ?? ''
  // per-run artifact snapshot id (so each run keeps its OWN board/renders/data
  // instead of all runs sharing the latest write to public/board)
  const runId = qp.get('runId') ?? ''
  if (!isValidRunId(runId)) {
    return new Response('a valid runId is required', { status: 400 })
  }
  // rev lineage (revise flow): parent run id + one-line reason
  const parentId = qp.get('parent') ?? ''
  if (parentId && !isValidRunId(parentId)) {
    return new Response('invalid parent run id', { status: 400 })
  }
  const revNote = (qp.get('revNote') ?? '').slice(0, 300)
  // Layer-2 compose mode: the interview passes a base64 {blocks, boardClass}
  const composeMode = qp.get('compose') === '1'
  let composeSpec: { blocks: string[]; boardClass: string; layers?: number } | null = null
  if (composeMode) {
    try {
      composeSpec = JSON.parse(
        Buffer.from(decodeURIComponent(qp.get('spec') ?? ''), 'base64').toString('utf8'),
      )
    } catch {
      composeSpec = null
    }
  }
  // Phase-11 UCS synth mode: the planner passes a base64 design
  // {final_design:[UCS...], intent, recovery_report}. synth.py emits the SAME
  // board contract as compose.py, so everything downstream is unchanged.
  const synthMode = qp.get('synth') === '1'
  let synthDesign: Record<string, unknown> | null = null
  if (synthMode) {
    try {
      synthDesign = JSON.parse(
        Buffer.from(decodeURIComponent(qp.get('design') ?? ''), 'base64').toString('utf8'),
      )
    } catch {
      synthDesign = null
    }
  }
  // Plan mode (Stage 0): the route runs the planner ITSELF on the prompt to
  // produce the UCS design, then feeds the synth path — real parts + the
  // requested MCU family instead of the RP2040-only compose block library. No
  // giant base64 design in the URL; synthDesign is filled in the design stage.
  const planMode = qp.get('plan') === '1'
  // Both compose and synth/plan produce a self-contained variant board (vs. the
  // rev-a baseline), so downstream board-path + firmware decisions treat alike.
  const boardMode = composeMode || synthMode || planMode
  const appDir = process.cwd()
  const hwDir = path.resolve(appDir, '../../hardware/pcba-rev-a')
  const flroute = path.join(hwDir, 'tools/flroute/target/release/flroute')
  const ATO = process.env.ATO_BIN || `${process.env.HOME}/.local/bin/ato`
  const CARGO = process.env.CARGO_BIN || `${process.env.HOME}/.cargo/bin/cargo`
  // Each run owns an id-scoped output dir (public/runs/<id>/{data,board}). A
  // caller may resume its own id, but can never claim or erase another user's
  // run (or an unowned shared demo) by guessing the directory name.
  const runRoot = path.join(appDir, 'public/runs', runId)
  const access = runAccess(req, runId)
  if (access.access === 'forbidden') {
    return new Response('run id belongs to another account', { status: 403 })
  }
  if (access.access !== 'owner' && fs.existsSync(runRoot)) {
    return new Response('run id already exists', { status: 409 })
  }
  if (parentId && runAccess(req, parentId).access === 'forbidden') {
    return new Response('parent run belongs to another account', { status: 403 })
  }
  const pubData = path.join(runRoot, 'data')
  const pubBoard = path.join(runRoot, 'board')
  const encoder = new TextEncoder()
  let child: ChildProcess | null = null
  let cancelled = false
  // release the per-user run slot exactly once — both the stream's finally and
  // its cancel() can fire for one run, and with a COUNTER (not the old idempotent
  // boolean) a double release would corrupt the concurrency accounting.
  let runReleased = false
  const releaseRunOnce = () => {
    if (runReleased) return
    runReleased = true
    releaseRun(userEmail)
  }
  // plan mode: the early chip-scale build running concurrently with the EDA
  // chain (see the kick after ucs_design.json lands). Abortable so a cancelled
  // or timed-out run can't leave an orphaned builder writing into the run dir.
  let earlyCs: Promise<Record<string, unknown>> | null = null
  const earlyCsAbort = new AbortController()

  // Full record of the run, every event in order, persisted on completion so
  // the last iteration can be inspected later without re-running or screenshots.
  const startedAt = new Date().toISOString()
  const events: PipelineEvent[] = []

  // ---- EDA-phase wall-clock instrumentation ---------------------------------
  // Server-side per-stage timing for the EDA chain, persisted to
  // public/runs/<id>/eda-timing.json — the same shape as the client-side
  // timing.json but a DIFFERENT file on purpose: the client owns timing.json and
  // two writers racing one file would corrupt it. Strictly best-effort: a
  // recording fault must never break a run, and partial timings still land on
  // failure/abort (persisted on every transition + closed out in finally).
  type EdaStageTiming = {
    stage: string; startedAt: string; endedAt?: string; ms?: number
    status: string; failReason?: string; detail?: string; unfinished?: boolean
  }
  const edaT0 = Date.now()
  const edaTiming: {
    runId: string; mode: string; startedAt: string
    finishedAt?: string; totalMs?: number; stages: EdaStageTiming[]
  } = {
    runId,
    mode: planMode ? 'plan' : synthMode ? 'synth' : composeMode ? 'compose' : 'matrix',
    startedAt,
    stages: [],
  }
  const edaOpen = new Map<string, { entry: EdaStageTiming; at: number }>()
  const persistEdaTiming = () => {
    try {
      fs.writeFileSync(path.join(runRoot, 'eda-timing.json'), JSON.stringify(edaTiming, null, 1))
    } catch { /* run dir may not exist yet — telemetry is best-effort */ }
  }
  const edaMark = (stage: string, state: string, failReason?: string, detail?: string) => {
    try {
      const now = Date.now()
      const iso = new Date(now).toISOString()
      if (state === 'running') {
        const prev = edaOpen.get(stage)
        // defensive: close a leaked attempt rather than lose it
        if (prev) { prev.entry.endedAt = iso; prev.entry.ms = now - prev.at; prev.entry.unfinished = true }
        const entry: EdaStageTiming = { stage, startedAt: iso, status: 'running', ...(detail ? { detail } : {}) }
        edaTiming.stages.push(entry)
        edaOpen.set(stage, { entry, at: now })
      } else {
        const cur = edaOpen.get(stage)
        if (cur) {
          cur.entry.endedAt = iso
          cur.entry.ms = now - cur.at
          cur.entry.status = state
          if (failReason) cur.entry.failReason = failReason
          if (detail) cur.entry.detail = detail
          edaOpen.delete(stage)
        } else {
          // terminal with no 'running' before it (e.g. 'blocked') — zero-duration mark
          edaTiming.stages.push({
            stage, startedAt: iso, endedAt: iso, ms: 0, status: state,
            ...(failReason ? { failReason } : {}), ...(detail ? { detail } : {}),
          })
        }
      }
      persistEdaTiming()
    } catch { /* never let timing take the run down */ }
  }

  // count the run + attach ownership up front (a crashed run still consumed
  // pipeline time; artifact filtering keys off this ownership record)
  recordRun(userEmail, runId)
  acquireRun(userEmail)

  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev: PipelineEvent) => {
        // this run's artifacts were written straight into public/runs/<id>, point
        // the client at that snapshot. No copy needed; the dir already holds only
        // this run's board (publish-to-shared happens after the report is written).
        if (ev.type === 'done' && runId) {
          ev.runDir = `/runs/${runId}`
        }
        // every stage transition funnels through here — the one hook the EDA
        // wall-clock recorder needs (running opens an attempt, terminal closes it)
        if (ev.type === 'stage') edaMark(ev.id, ev.state, ev.failReason)
        events.push(ev)
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`))
        } catch {
          /* client gone */
        }
      }
      const log = (stage: string, text: string, level?: string) =>
        send({ type: 'log', stage, text, level })

      /** spawn a step, stream its stdout/stderr, resolve exit code */
      const exec = (
        stage: string,
        cmd: string,
        args: string[],
        opts: { cwd?: string; env?: Record<string, string> } = {},
      ): Promise<{ code: number; out: string }> =>
        new Promise((resolve) => {
          if (cancelled) return resolve({ code: -1, out: '' })
          let out = ''
          child = spawn(cmd, args, {
            cwd: opts.cwd ?? hwDir,
            // KiCad's bundled Python has no CA store; point HTTPS at the system
            // bundle so live sourcing / datasheet fetches verify instead of
            // failing on "self signed certificate in certificate chain".
            env: {
              ...process.env,
              ...(process.env.SSL_CERT_FILE || !fs.existsSync('/etc/ssl/cert.pem')
                ? {}
                : { SSL_CERT_FILE: '/etc/ssl/cert.pem' }),
              ...opts.env,
            },
          })
          const feed = (chunk: Buffer, level?: string) => {
            const text = chunk.toString()
            out += text
            for (const line of text.split('\n')) {
              if (line.trim()) log(stage, line.trimEnd(), level)
            }
          }
          child.stdout?.on('data', (c: Buffer) => feed(c))
          child.stderr?.on('data', (c: Buffer) => feed(c, 'warn'))
          child.on('error', (err) => {
            log(stage, `spawn failed: ${err.message}`, 'err')
            resolve({ code: -1, out })
          })
          child.on('close', (code) => resolve({ code: code ?? -1, out }))
        })

      const killTimer = setTimeout(() => {
        cancelled = true
        child?.kill('SIGKILL')
        // a timed-out run must not leave the early chip-scale build orphaned
        try { earlyCsAbort.abort() } catch { /* already settled */ }
        send({ type: 'error', message: 'run timed out (20 min safety limit)' })
      }, RUN_TIMEOUT_MS)

      try {
        // ---- workspace: isolated copy, never the working board ------------
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'flrun-'))
        const wsLayout = path.join(ws, 'elec/layout')
        fs.mkdirSync(wsLayout, { recursive: true })
        for (const f of [
          'rev-a-routed.kicad_pcb',
          'rev-a-routed.kicad_pro',
          'rev-a-routed.kicad_prl',
        ]) {
          const src = path.join(hwDir, 'elec/layout', f)
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(wsLayout, f))
        }
        const wsBoard = path.join(wsLayout, 'rev-a-routed.kicad_pcb')
        const variantBoard = path.join(ws, 'variant.kicad_pcb')
        const fl1Bom = path.join(hwDir, 'build/builds/default/default.bom.csv')
        log('design', `workspace: ${ws} (working board untouched)`)

        // ---- start this run's id-scoped output dir CLEAN — but only the parts
        // THIS pipeline owns. Every artifact below is written straight into it,
        // so a run only ever contains its own board; a run that gate-fails before
        // render/validation leaves no board.json and loadRealBoard keys off that.
        // The ID-first flows (v1 headless jobs, Compose) legitimately create the
        // run dir BEFORE this board pipeline runs: v1-job.json, product-spec.json,
        // disciplines/id-brief.json and the id/ render + consistency-judge
        // evidence all pre-date this call, and the old blanket rmSync(runRoot)
        // silently destroyed them (headless runs lost their ID sheet + brief, so
        // the mechanical fidelity loop honestly skipped with "no ID brief").
        // Everything else — board/, data/, electronics/, stale top-level EDA
        // artifacts, stale discipline outputs — is wiped exactly as before, so a
        // re-run of the same id can't keep stale board files from a prior attempt.
        if (runRoot && fs.existsSync(runRoot)) {
          const keep = new Set(['v1-job.json', 'product-spec.json', 'id'])
          for (const name of fs.readdirSync(runRoot)) {
            if (keep.has(name)) continue
            if (name === 'disciplines') {
              // keep only the pre-pipeline ID brief; stage outputs are stale
              for (const f of fs.readdirSync(path.join(runRoot, 'disciplines'))) {
                if (f !== 'id-brief.json') {
                  fs.rmSync(path.join(runRoot, 'disciplines', f), { recursive: true, force: true })
                }
              }
              continue
            }
            fs.rmSync(path.join(runRoot, name), { recursive: true, force: true })
          }
        }
        fs.mkdirSync(pubBoard, { recursive: true })
        fs.mkdirSync(pubData, { recursive: true })

        // ---- stage 1: design --------------------------------------------------
        send({ type: 'stage', id: 'design', state: 'running' })
        const specPath = path.join(ws, 'design_spec.json')
        if (composeMode && composeSpec) {
          // Layer 2: block composition. compose.py maps the interview's blocks to
          // library blocks and emits the placed, zoned board the pipeline builds.
          log('design', `composing board: ${composeSpec.boardClass}`)
          send({ type: 'design', spec: composeSpec as Record<string, unknown> })
          fs.writeFileSync(specPath, JSON.stringify(composeSpec))
          const comp = await exec('design', KPY, [
            path.resolve(hwDir, '../blocks/compose.py'),
            specPath,
            variantBoard,
          ])
          if (!comp.out.includes('COMPOSE:')) {
            send({ type: 'stage', id: 'design', state: 'failed', failReason: 'compose failed' })
            for (const s of ['placement', 'routing', 'validation', 'erc', 'firmware'] as const)
              send({ type: 'stage', id: s, state: 'blocked' })
            send({ type: 'done', status: 'GATE FAILED', boardPath: variantBoard })
            return
          }
          // carry the resolved-part manifest (compose writes <board>.devices.json)
          // into the run's data dir so the BOM can name sourced ICs correctly.
          try {
            const devSrc = variantBoard.replace(/\.kicad_pcb$/, '.devices.json')
            if (fs.existsSync(devSrc)) {
              fs.copyFileSync(devSrc, path.join(pubData, 'devices.json'))
            }
            // real electrical values (ref -> "100nF"/"4.7k") for the schematic
            const valSrc = variantBoard.replace(/\.kicad_pcb$/, '.values.json')
            if (fs.existsSync(valSrc)) {
              fs.copyFileSync(valSrc, path.join(pubData, 'values.json'))
            }
          } catch {
            /* BOM just falls back to the footprint heuristic */
          }
          // coverage: surface which requested blocks the library could NOT build,
          // so an incomplete board never passes silently.
          const covMatch = comp.out.match(/^COMPOSE_COVERAGE:(.+)$/m)
          if (covMatch) {
            try {
              const cov = JSON.parse(covMatch[1]) as { mapped: string[]; dropped: string[] }
              send({ type: 'coverage', mapped: cov.mapped, dropped: cov.dropped })
              if (cov.dropped.length) {
                log(
                  'design',
                  `⚠ coverage: built [${cov.mapped.join(', ')}]; NOT built (no library block): [${cov.dropped.join(', ')}]`,
                  'warn',
                )
              } else {
                log('design', `coverage: every requested block built [${cov.mapped.join(', ')}]`, 'ok')
              }
            } catch {
              /* coverage line unparseable, non-fatal */
            }
          }
          // sourced parts: real MPN/price/stock/verification for parts pulled
          // live from DigiKey + datasheet (vs. hardcoded blocks).
          const sourced = [...comp.out.matchAll(/^SOURCED:(.+)$/gm)]
            .map((m) => {
              try {
                return JSON.parse(m[1]) as Record<string, unknown>
              } catch {
                return null
              }
            })
            .filter(Boolean) as Record<string, unknown>[]
          if (sourced.length) {
            send({ type: 'sourced', parts: sourced })
            for (const p of sourced) {
              const v = p.verified === 'verified' || String(p.verified).startsWith('verified')
              log(
                'design',
                `sourced ${p.ref}: ${p.mpn} (${p.manufacturer}) $${p.price} · ${p.stock} in stock · ${p.footprint} · ${v ? '✓ verified' : '⚠ ' + p.verified}`,
                v ? 'ok' : 'warn',
              )
            }
          }
          log('design', 'GATE design: blocks composed + wired, PASS', 'ok')
          send({ type: 'stage', id: 'design', state: 'passed' })
        } else if ((synthMode && synthDesign) || planMode) {
          // Stage 0 plan mode: run the planner on the prompt to resolve real
          // parts + an MCU (honouring the requested family), then hand the UCS
          // design to synth. synth.py emits the SAME contract as compose.py, so
          // the rest of the pipeline (route/DRC/stitch/fab/firmware/FL-1) is
          // unchanged. Every substitution the planner made is logged, not hidden.
          if (planMode) {
            log('design', 'planning: resolving the prompt to real parts + an MCU…')
            const plannerDir = path.resolve(hwDir, '../../hardware/planner')
            const pl = await exec('design', plannerPython(),
              [path.join(plannerDir, 'plan_cli.py'), prompt], { cwd: plannerDir })
            try {
              synthDesign = JSON.parse(pl.out.trim().split('\n').filter(Boolean).pop() || 'null')
            } catch { synthDesign = null }
            const sd = synthDesign as null | {
              final_design?: unknown[]
              honest_report?: { outcome: string; request: string; mpn?: string; lost?: string[] }[]
              intent?: { mcu?: { family?: string } }
              overall_status?: string
            }
            if (sd && Array.isArray(sd.final_design)) {
              const subs = (sd.honest_report || []).filter((h) => h.outcome === 'substituted')
              log('design', `planned: ${sd.final_design.length} real parts + ${sd.intent?.mcu?.family ?? '?'} MCU · ${sd.overall_status ?? ''}`, 'ok')
              for (const s of subs)
                log('design', `⚠ substituted ${s.request}${s.mpn ? ' → ' + s.mpn : ''}${s.lost?.length ? ' (lost: ' + s.lost.join(', ') + ')' : ''}`, 'warn')
              // Stage 2: the recursive subsystem tree — log the decomposition and
              // persist it so the product is legible as a hierarchy, not a flat list.
              const tree = (synthDesign as {
                design_tree?: {
                  children?: {
                    name: string
                    design_of_n?: { chosen?: string; candidates?: { option: string; feasible?: boolean }[] }
                  }[]
                }
              }).design_tree
              if (tree?.children?.length) {
                log('design', `decomposed into ${tree.children.length} subsystems: ${tree.children.map((c) => c.name).join(', ')}`, 'ok')
                // surface any subsystem that ran a real design-of-N (candidates
                // evaluated + chosen), so "we DESIGNED this subsystem" is visible.
                for (const c of tree.children) {
                  const don = c.design_of_n
                  if (don?.candidates?.length) {
                    const opts = don.candidates.map((x) => `${x.option}${x.feasible === false ? '✗' : ''}`).join(' vs ')
                    log('design', `  ${c.name}: evaluated ${opts} → chose ${don.chosen}`, 'ok')
                  }
                }
                try { fs.writeFileSync(path.join(pubData, 'design-tree.json'), JSON.stringify(tree)) } catch { /* non-fatal */ }
              }
              // Stage 3: real design verification (mcu-fit / rail-compat / coverage
              // / routing-risk) — reported honestly, converged only if it truly is.
              const verif = synthDesign as { checks?: { name: string; severity: string; detail: string }[]; converged?: boolean }
              if (Array.isArray(verif.checks)) {
                const errs = verif.checks.filter((c) => c.severity === 'error')
                const warns = verif.checks.filter((c) => c.severity === 'warn')
                log('design', `verified [real checks]: ${verif.converged ? 'converged' : 'NOT converged'} · ${errs.length} error(s), ${warns.length} warning(s)`, errs.length ? 'err' : 'ok')
                for (const c of verif.checks)
                  log('design', `  ${c.severity === 'ok' ? '✓' : c.severity === 'warn' ? '⚠' : '✗'} ${c.name}: ${c.detail}`, c.severity === 'error' ? 'err' : c.severity === 'warn' ? 'warn' : 'ok')
                try { fs.writeFileSync(path.join(pubData, 'verification.json'), JSON.stringify({ converged: verif.converged, checks: verif.checks })) } catch { /* non-fatal */ }
              }
              // Stage 4: ONE canonical design object — the single source of truth
              // the board, BOM, disciplines and UI all derive from, so the MCU the
              // plan names IS the MCU on the board, in the BOM, and in the tree.
              try {
                const sdx = synthDesign as {
                  intent?: { product_goal?: string; mcu?: { family?: string } }
                  final_design?: { mpn: string; category?: string }[]
                  honest_report?: { outcome: string; request: string; mpn?: string }[]
                }
                const design = {
                  product: sdx.intent?.product_goal ?? prompt.slice(0, 80),
                  mcu: sdx.intent?.mcu?.family ?? null,
                  parts: (sdx.final_design ?? []).map((p) => ({ mpn: p.mpn, category: p.category })),
                  subsystems: (tree?.children ?? []).map((c: { name: string; parts?: string[] }) => ({ name: c.name, parts: c.parts ?? [] })),
                  verification: { converged: verif.converged ?? null, checks: verif.checks ?? [] },
                  substitutions: (sdx.honest_report ?? []).filter((h) => h.outcome === 'substituted'),
                  unsupported: (sdx.honest_report ?? []).filter((h) => h.outcome === 'unsupported').map((h) => h.request),
                }
                fs.writeFileSync(path.join(pubData, 'design.json'), JSON.stringify(design))
              } catch { /* non-fatal */ }
              send({ type: 'design', spec: synthDesign as Record<string, unknown> })
            }
          }
          if (!synthDesign || !Array.isArray((synthDesign as { final_design?: unknown[] }).final_design)) {
            send({ type: 'stage', id: 'design', state: 'failed', failReason: planMode ? 'planning failed' : 'invalid synth design' })
            for (const s of ['placement', 'routing', 'validation', 'erc', 'firmware'] as const)
              send({ type: 'stage', id: s, state: 'blocked' })
            send({ type: 'done', status: 'GATE FAILED', boardPath: variantBoard })
            return
          }
          // Phase 11: synthesize the board from the UCS design (planner output).
          const parts = (synthDesign.final_design as unknown[])?.length ?? 0
          log('design', `synthesizing board from ${parts} Universal Component Specs…`)
          const designPath = path.join(ws, 'ucs_design.json')
          fs.writeFileSync(designPath, JSON.stringify(synthDesign))
          // MERGER: also persist the FULL UCS design publicly by runId so the
          // chip-scale board engine (electronics-cs) can build from this SAME real
          // design via the netlist bridge, instead of a separate LLM part-set.
          try { fs.writeFileSync(path.join(pubData, 'ucs_design.json'), JSON.stringify(synthDesign)) } catch { /* non-fatal */ }

          // MERGER artifact (one design → one board): export the SAME planner
          // design in run_board format — {parts, nets, gnd} with the planner's
          // REAL part names + LCSC ids — as data/chipscale-spec.json. The
          // chip-scale engine feeds tools/tscircuit/run_board.mjs DIRECTLY from
          // this file and skips its own LLM part-set entirely. Plain python3
          // (the netlist bridge needs no KiCad); quiet spawn, not exec() — the
          // spec is one large JSON line that would spam the client log.
          try {
            const plannerHome = path.resolve(hwDir, '../../hardware/planner')
            const nlRaw = await new Promise<string>((resolve, reject) => {
              const py = spawn('python3', [path.join(plannerHome, 'synth.py'), '--netlist', designPath],
                { cwd: plannerHome, timeout: 90_000 })
              let out = ''
              let err = ''
              py.stdout?.on('data', (d: Buffer) => (out += d))
              py.stderr?.on('data', (d: Buffer) => (err += d))
              py.on('error', reject)
              py.on('close', (code) => (code === 0 && out.trim()
                ? resolve(out)
                : reject(new Error(err.slice(0, 200) || `netlist bridge exit ${code}`))))
            })
            const nl = JSON.parse(nlRaw.trim().split('\n').filter(Boolean).pop() || 'null') as {
              parts?: { name: string; mpn?: string; lcsc?: string }[]
              nets?: unknown[]
              honest?: { dropped?: unknown[] }
            } | null
            if (nl && Array.isArray(nl.parts) && nl.parts.length) {
              fs.writeFileSync(path.join(pubData, 'chipscale-spec.json'), JSON.stringify(nl))
              const named = nl.parts.filter((p) => p.mpn)
              log('design',
                `chip-scale spec: ${nl.parts.length} parts — ${named.map((p) => `${p.name}=${p.mpn}${p.lcsc ? ' (' + p.lcsc + ')' : ''}`).join(', ')} — ${nl.nets?.length ?? 0} nets → data/chipscale-spec.json`,
                'ok')
              const nDropped = nl.honest?.dropped?.length ?? 0
              if (nDropped) {
                log('design',
                  `⚠ chip-scale spec: ${nDropped} part(s) had no honest run_board footprint mapping — dropped LOUDLY (chipscale-spec.json → honest.dropped)`,
                  'warn')
              }
            } else {
              log('design', 'chip-scale spec: netlist bridge returned no parts — electronics stage falls back honestly', 'warn')
            }
          } catch (e) {
            log('design', `chip-scale spec export failed: ${String(e).slice(0, 160)} — electronics stage falls back`, 'warn')
          }

          // ---- DESIGN-CORRECTNESS GATE (interactive pipeline) --------------
          // The netlist bridge wires buses + power, but the per-IC synthesis
          // omits the APPLICATION signal chains (mux->ADC, MCU drives the mux
          // select, reference->channel, input/host connectors). Wire those in
          // (functional_wire, mutates the spec in place) then VERIFY the design
          // is actually wired to work (design_check) — the SAME gate the headless
          // v1 path runs. This is what stops a DRC-clean but functionally hollow
          // board from shipping out of the pipeline users actually click, and it
          // enforces the supported-envelope beachhead: a product family we can't
          // yet wire correctly fails HERE, honestly, instead of building hollow.
          // Runs before the early chip-scale build so that build reads the WIRED
          // spec. Fail-SAFE: if the gate itself can't run, don't block.
          const csSpecPath = path.join(pubData, 'chipscale-spec.json')
          if (fs.existsSync(csSpecPath)) {
            // Both helpers return null when the tool did NOT run (timeout, python
            // missing, `ERROR` verdict, no verdict line). That is surfaced here with
            // the reason and never blocks — only a true GATE FAIL (pass:false) does.
            let wireNotRun = ''
            let gateNotRun = ''
            const wired = await runFunctionalWire(csSpecPath, prompt, { onNotRun: (r) => { wireNotRun = r } })
            if (wired === null)
              log('design', `functional wiring not run: ${wireNotRun.slice(0, 160)} — continuing with the spec as synthesized`, 'warn')
            else if (wired > 0)
              log('design', `functional wiring: added ${wired} application signal-chain connection(s) the bus synthesis omitted`, 'ok')
            const gate = await runDesignGate(csSpecPath, prompt, { onNotRun: (r) => { gateNotRun = r } })
            if (gate && !gate.pass) {
              log('design', `GATE design-correctness: FAIL — ${gate.failCount} issue(s): ${gate.summary}`, 'err')
              log('design', 'This design is not yet wired to work. Compose reliably builds measurement and sensor boards (an MCU with I2C / analog front ends) today; a design outside that supported envelope is blocked here rather than shipped hollow.', 'warn')
              send({ type: 'stage', id: 'design', state: 'failed', failReason: `design-correctness gate: ${gate.failCount} issue(s)` })
              for (const s of ['placement', 'routing', 'validation', 'erc', 'firmware'] as const)
                send({ type: 'stage', id: s, state: 'blocked' })
              send({ type: 'done', status: 'GATE FAILED', boardPath: variantBoard })
              return
            }
            if (gate)
              log('design', `GATE design-correctness: PASS${gate.warnCount ? ` (${gate.warnCount} advisory)` : ''}`, 'ok')
            else
              log('design', `GATE design-correctness: [design-gate] not run: ${gateNotRun.slice(0, 160)} — not blocking (the gate produced no verdict, so this design is UNCHECKED, not passed)`, 'warn')
          } else {
            log('design', 'GATE design-correctness: design gate skipped: spec export failed (no data/chipscale-spec.json) — the netlist was NOT checked for functional completeness', 'warn')
          }

          // ---- EARLY CHIP-SCALE BUILD (plan mode) ---------------------------
          // The merged design just landed, and in plan mode the board that SHIPS
          // is the chip-scale board built FROM it — so start that build NOW,
          // concurrent with the variant routing/validation below, instead of
          // after the whole SSE chain finishes (which used to serialize ~4 min
          // of product-pipeline behind ~10 min of EDA). The client's later
          // electronics stage reuses the persisted board (run-pipeline
          // existingBoard) or joins this build via electronics-cs's in-flight
          // lock, so nothing double-builds. plannerOnly: with ucs_design.json on
          // disk this build uses the planner netlist bridge; if the bridge fails
          // it stops instead of LLM-guessing from this minimal spec — the
          // client's full-spec call keeps the LLM fallback.
          if (planMode && !cancelled && fs.existsSync(path.join(pubData, 'ucs_design.json'))) {
            const sdi = synthDesign as { intent?: { product_goal?: string } }
            const csBody = {
              runId,
              plannerOnly: true,
              spec: {
                product: sdi.intent?.product_goal || prompt.slice(0, 120) || 'product',
                description: prompt.slice(0, 300),
                budgets: {},
              },
            }
            edaMark('chipscale-early', 'running', undefined,
              'merged chip-scale board build, concurrent with variant routing')
            log('design', 'chip-scale product board: build started EARLY from the merged design (overlaps variant routing; the product pipeline will reuse it)', 'ok')
            earlyCs = electronicsCsBuild(new Request('http://firstlight.internal/api/electronics-cs', {
              method: 'POST',
              // carry identity/BYOK AND the resolved model (the run's model came
              // from the query param, so inject it as the header electronics-cs
              // reads) so the sub-build designs on the same model.
              headers: fwdHeaders(req, { 'content-type': 'application/json', 'x-fl-model': resolvedModel.model.id }),
              body: JSON.stringify(csBody),
              signal: earlyCsAbort.signal,
            }))
              .then(async (r) => (await r.json()) as Record<string, unknown>)
              .catch((e) => ({ ok: false, error: String(e) } as Record<string, unknown>))
              .then((r) => {
                const built = !!(r as { boardMm?: unknown }).boardMm
                edaMark('chipscale-early', built ? 'passed' : 'failed',
                  built ? undefined : String((r as { error?: unknown }).error ?? 'no board'))
                return r
              })
          }
          const comp = await exec('design', KPY, [
            path.resolve(hwDir, '../../hardware/planner/synth.py'),
            designPath,
            variantBoard,
          ])
          if (!comp.out.includes('COMPOSE:')) {
            send({ type: 'stage', id: 'design', state: 'failed', failReason: 'UCS synth failed' })
            for (const s of ['placement', 'routing', 'validation', 'erc', 'firmware'] as const)
              send({ type: 'stage', id: s, state: 'blocked' })
            send({ type: 'done', status: 'GATE FAILED', boardPath: variantBoard })
            return
          }
          // carry the device manifest + the recovery/substitution report (P11 #13)
          // + the MCU selection & pin-assignment artifacts (MCU engine)
          for (const [suffix, dst] of [
            ['.devices.json', 'devices.json'],
            ['.values.json', 'values.json'], // real electrical values (ref -> "100nF"/"4.7k")
            ['.recovery.json', 'recovery.json'],
            ['.mcu-selection.json', 'mcu-selection.json'],
            ['.mcu-recovery.json', 'mcu-recovery.json'],
            ['.pin-assignment.json', 'pin-assignment.json'],
            ['.pin-assignment.md', 'pin-assignment.md'],
          ] as const) {
            try {
              const src = variantBoard.replace(/\.kicad_pcb$/, suffix)
              if (fs.existsSync(src)) fs.copyFileSync(src, path.join(pubData, dst))
            } catch {
              /* non-fatal */
            }
          }
          const mcuMatch = comp.out.match(/^MCU_SELECTED:(.+)$/m)
          if (mcuMatch) {
            try {
              const mc = JSON.parse(mcuMatch[1]) as {
                mcu: string; status: string; assigned: number; conflicts: number
                rejected: number; partial: string | null
              }
              log('design', `MCU: selected ${mc.mcu} (${mc.status}) — ${mc.assigned} pins allocated, ${mc.conflicts} conflicts, ${mc.rejected} candidate(s) rejected`, mc.conflicts === 0 ? 'ok' : 'warn')
              if (mc.partial)
                log('design', `⚠ ${mc.mcu} is a partial MCU: ${mc.partial}`, 'warn')
            } catch {
              /* non-fatal */
            }
          }
          const covMatch = comp.out.match(/^COMPOSE_COVERAGE:(.+)$/m)
          if (covMatch) {
            try {
              const cov = JSON.parse(covMatch[1]) as { mapped: string[]; dropped: unknown[] }
              send({ type: 'coverage', mapped: cov.mapped, dropped: cov.dropped as string[] })
              if (cov.dropped.length)
                log('design', `⚠ UCS synth dropped (honest): ${JSON.stringify(cov.dropped)}`, 'warn')
              else
                log('design', `synth: every UCS component instantiated [${cov.mapped.join(', ')}]`, 'ok')
            } catch {
              /* non-fatal */
            }
          }
          const notes = comp.out.match(/^SYNTH_NOTES:(.+)$/m)
          if (notes) log('design', `synth notes: ${notes[1]}`, 'warn')
          log('design', 'GATE design: UCS design synthesized + wired, PASS', 'ok')
          send({ type: 'stage', id: 'design', state: 'passed' })
        } else {
          // FL-1 relay/probe matrix: AI interprets the prompt, ato build gate.
          await exec('design', 'python3', [
            path.join(appDir, 'scripts/ai_design.py'),
            prompt,
            specPath,
          ])
          try {
            send({ type: 'design', spec: JSON.parse(fs.readFileSync(specPath, 'utf8')) })
          } catch {
            log('design', 'design spec unreadable, continuing on FL-1 baseline', 'warn')
          }
          log('design', 'ato build, compiling .ato design-of-record…')
          const build = await exec('design', ATO, ['build'], { cwd: hwDir })
          if (!(build.code === 0 || build.out.includes('Build successful'))) {
            send({ type: 'stage', id: 'design', state: 'failed', failReason: 'ato build not GREEN' })
            for (const s of ['placement', 'routing', 'validation', 'erc', 'firmware'] as const)
              send({ type: 'stage', id: s, state: 'blocked' })
            send({ type: 'done', status: 'GATE FAILED', boardPath: wsBoard })
            return
          }
          log('design', 'GATE design: ato build GREEN, PASS', 'ok')
          log('design', `gen_board: building the prompt's variant…`)
          const genV = await exec('design', KPY, [
            path.join(hwDir, 'scripts/gen_board.py'),
            variantBoard,
          ], { env: { DESIGN_SPEC: specPath } })
          if (!(genV.code === 0 || genV.out.includes('gen_board:'))) {
            send({ type: 'stage', id: 'design', state: 'failed', failReason: 'gen_board failed' })
            for (const s of ['placement', 'routing', 'validation', 'erc', 'firmware'] as const)
              send({ type: 'stage', id: s, state: 'blocked' })
            send({ type: 'done', status: 'GATE FAILED', boardPath: variantBoard })
            return
          }
          send({ type: 'stage', id: 'design', state: 'passed' })
        }

        // ---- stage 2: placement gates on the variant -----------------------
        // gen_board already placed the variant (with fiducials + zones); gate
        // it directly, no place_and_zone (that's the atopile placer).
        send({ type: 'stage', id: 'placement', state: 'running' })
        const pscore = await exec('placement', KPY, [
          path.join(hwDir, 'scripts/placement_score.py'),
          variantBoard,
        ])
        if (pscore.code !== 0) {
          send({ type: 'stage', id: 'placement', state: 'failed', failReason: 'placement gate FAIL' })
          send({ type: 'stage', id: 'routing', state: 'blocked' })
          send({ type: 'stage', id: 'validation', state: 'blocked' })
          send({ type: 'stage', id: 'erc', state: 'blocked' })
          send({ type: 'stage', id: 'firmware', state: 'blocked' })
          send({ type: 'done', status: 'GATE FAILED', boardPath: variantBoard })
          return
        }
        log('placement', 'GATE placement (HPWL/overlap), PASS', 'ok')
        const dfm = await exec('placement', KPY, [
          path.join(hwDir, 'scripts/dfm_check.py'),
          variantBoard,
        ])
        if (dfm.code !== 0) {
          send({ type: 'stage', id: 'placement', state: 'failed', failReason: 'DFM gate FAIL' })
          send({ type: 'stage', id: 'routing', state: 'blocked' })
          send({ type: 'stage', id: 'validation', state: 'blocked' })
          send({ type: 'stage', id: 'erc', state: 'blocked' })
          send({ type: 'stage', id: 'firmware', state: 'blocked' })
          send({ type: 'done', status: 'GATE FAILED', boardPath: variantBoard })
          return
        }
        log('placement', 'GATE DFM (edge/hole/fiducial/courtyard), PASS', 'ok')
        send({ type: 'stage', id: 'placement', state: 'passed' })

        // ---- Constraint Manager v1 -----------------------------------------
        // Classify every net (power / digital / I2C / SPI / UART / RS485 / CAN /
        // RF / analog / motor / clock …), emit per-class KiCad net-settings into
        // the .kicad_pro, write the constraint model, and surface the HONEST
        // unsupported list (USB-HS / Ethernet differential/impedance nets). Runs
        // before routing so the classes are part of the design.
        const cons = await exec('placement', KPY, [
          path.join(appDir, 'scripts/apply_constraints.py'),
          variantBoard,
        ])
        const cm = cons.out.match(/^CONSTRAINTS (\d+) (\d+) (\d+)/m)
        if (cm)
          log('placement', `constraints: ${cm[1]} nets in ${cm[2]} classes, ${cm[3]} unsupported feature-net(s)`, cm[3] === '0' ? 'ok' : 'warn')
        try {
          const cSrc = variantBoard.replace(/\.kicad_pcb$/, '.constraints.json')
          if (fs.existsSync(cSrc)) fs.copyFileSync(cSrc, path.join(pubData, 'constraints.json'))
        } catch {
          /* constraint model just won't show in the UI */
        }
        const crm = cons.out.match(/^CONSTRAINT_REPORT:(.+)$/m)
        if (crm) {
          try {
            const cr = JSON.parse(crm[1]) as {
              unsupported?: { feature: string; fallback: string }[]
              high_risk?: string[]
            }
            if (cr.unsupported?.length)
              log('placement', `⚠ unsupported (honest): ${cr.unsupported.map((u) => `${u.feature} → fallback ${u.fallback}`).join('; ')}`, 'warn')
            if (cr.high_risk?.length)
              log('placement', `high-risk nets (verify by hand): ${cr.high_risk.join(', ')}`, 'warn')
          } catch {
            /* report line unparseable, non-fatal */
          }
        }

        // ---- stage 3: routing (flroute on the variant) ---------------------
        send({ type: 'stage', id: 'routing', state: 'running' })
        const dsn = path.join(ws, 'variant.dsn')
        const ses = path.join(ws, 'variant.ses')
        const dsnRes = await exec('routing', KPY, [
          path.join(appDir, 'scripts/export_dsn.py'),
          variantBoard,
          dsn,
        ])
        const dsnOk = dsnRes.code === 0 || dsnRes.out.includes('DSN export OK')
        if (!dsnOk) {
          send({ type: 'stage', id: 'routing', state: 'failed', failReason: 'DSN export failed' })
          send({ type: 'stage', id: 'validation', state: 'blocked' })
          send({ type: 'stage', id: 'erc', state: 'blocked' })
          send({ type: 'stage', id: 'firmware', state: 'blocked' })
          send({ type: 'done', status: 'GATE FAILED', boardPath: variantBoard })
          return
        }
        const zoneNets =
          dsnRes.out.match(/^ZONE_NETS:(.*)$/m)?.[1]?.split(',').filter(Boolean) ?? []
        // pre-routed block nets: their copper is already on the board (frozen
        // templates; sidecar written by compose next to the board); flroute
        // must treat it as fixed and not re-route them
        let preroutedNets: string[] = []
        try {
          const pr = JSON.parse(fs.readFileSync(
            variantBoard.replace(/\.kicad_pcb$/, '.preroute.json'), 'utf8'))
          preroutedNets = [...new Set(((pr.entries ?? []) as { net?: unknown }[])
            .map((e) => String(e.net)).filter(Boolean))]
        } catch { /* no pre-routed blocks on this board */ }
        const skipArgs = [...zoneNets, ...preroutedNets].flatMap((n) => ['--skip-net', n])
        log('routing', `flroute: skipping zone-served nets [${zoneNets.join(', ')}]`)
        if (preroutedNets.length)
          log('routing', `flroute: ${preroutedNets.length} net(s) pre-routed by block templates [${preroutedNets.join(', ')}]`)
        const route = await exec('routing', flroute, [dsn, ses, ...skipArgs])
        if (route.code !== 0 || !fs.existsSync(ses)) {
          send({ type: 'stage', id: 'routing', state: 'failed', failReason: `flroute exit ${route.code}` })
          send({ type: 'stage', id: 'validation', state: 'blocked' })
          send({ type: 'stage', id: 'erc', state: 'blocked' })
          send({ type: 'stage', id: 'firmware', state: 'blocked' })
          send({ type: 'done', status: 'GATE FAILED', boardPath: variantBoard })
          return
        }
        const imp = await exec('routing', KPY, [
          path.join(appDir, 'scripts/import_ses.py'),
          variantBoard,
          ses,
        ])
        const impOk = imp.code === 0 || imp.out.includes('IMPORT_OK')
        if (!impOk) {
          send({ type: 'stage', id: 'routing', state: 'failed', failReason: 'SES import failed' })
          send({ type: 'stage', id: 'validation', state: 'blocked' })
          send({ type: 'stage', id: 'erc', state: 'blocked' })
          send({ type: 'stage', id: 'firmware', state: 'blocked' })
          send({ type: 'done', status: 'GATE FAILED', boardPath: variantBoard })
          return
        }
        // pad-entry stitching: closes the flroute-vs-referee connectivity gap
        // (router stops at grid centers 100-400um short of pad copper)
        const stitch = await exec('routing', KPY, [
          path.join(appDir, 'scripts/stitch_pads.py'),
          variantBoard,
        ])
        const stitched = stitch.out.match(/^STITCHED (\d+)/m)?.[1]
        log(
          'routing',
          stitched !== undefined
            ? `pad-entry stitching: ${stitched} segments added`
            : 'pad-entry stitching did not complete',
          stitched !== undefined ? 'ok' : 'warn',
        )

        // ---- apply per-class trace widths (Constraint Manager v1) -----------
        // flroute routes at one width; widen power / high-current tracks to
        // their class width where the copper still clears neighbours. Real
        // board effect, zero new DRC violations (skips where it can't fit).
        try {
          const cPath = variantBoard.replace(/\.kicad_pcb$/, '.constraints.json')
          if (fs.existsSync(cPath)) {
            const wp = await exec('routing', KPY, [
              path.join(appDir, 'scripts/widen_power.py'), variantBoard, cPath,
            ])
            const wm = wp.out.match(/^WIDENED (\d+) of (\d+)[^(]*\((\d+)/m)
            if (wm)
              log('routing', `per-class widths: widened ${wm[1]}/${wm[2]} power tracks (${wm[3]} clearance-limited)`, 'ok')
          }
        } catch {
          /* widths are an enhancement; routed board is already valid */
        }
        // fill the GND / coil-rail zones so plane pads connect via the pour
        await exec('routing', KPY, [
          '-c',
          `import pcbnew; b=pcbnew.LoadBoard(${JSON.stringify(variantBoard)}); ` +
            `pcbnew.ZONE_FILLER(b).Fill(b.Zones()); ` +
            `pcbnew.SaveBoard(${JSON.stringify(variantBoard)}, b)`,
        ])
        log('routing', 'zones filled (GND / coil-rail pours)')
        // RF pass: controlled-impedance widths + GND via fence on RF nets
        // (ANT, RF*, *_RF). IPC-2141 microstrip vs the 4-layer stackup.
        const rf = await exec('routing', KPY, [
          path.join(appDir, 'scripts/rf_pass.py'), variantBoard,
        ])
        const rfNets = rf.out.match(/^RF_NET .+$/gm) ?? []
        for (const line of rfNets) log('routing', `RF pass: ${line.slice(7)} (50Ω microstrip target)`, 'ok')
        if (!rfNets.length) log('routing', 'RF pass: no RF nets on this board')
        // high-speed checks: diff-pair skew + matched-length groups measured
        // from the routed copper. REPORTING stage (honest) — the router does
        // not yet honor length constraints; see docs/density-program.md.
        const hs = await exec('routing', KPY, [
          path.join(appDir, 'scripts/hs_check.py'), variantBoard,
        ])
        const hsPairs = hs.out.match(/^HS_PAIR: .+$/gm) ?? []
        for (const l of hsPairs)
          log('routing', `high-speed: ${l.slice(9)}`, l.includes('EXCEEDED') ? 'warn' : 'ok')
        if (!hsPairs.length) log('routing', 'high-speed: no differential pairs on this board')
        try {
          fs.copyFileSync(variantBoard.replace(/\.kicad_pcb$/, '.highspeed.json'),
            path.join(pubData, 'highspeed.json'))
        } catch { /* no report — nothing measured */ }
        log('routing', 'GATE emission: only DRC-clean nets shipped, PASS', 'ok')
        send({ type: 'stage', id: 'routing', state: 'passed' })

        // ---- stage 4: validation (kicad-cli, the neutral referee) -----------
        send({ type: 'stage', id: 'validation', state: 'running' })
        const drcPath = path.join(ws, 'drc.json')
        await exec('validation', KCLI, [
          'pcb', 'drc', '--format', 'json', '--severity-error',
          '-o', drcPath, variantBoard,
        ])
        let violations = -1
        let unconnected = -1
        try {
          const drc = JSON.parse(fs.readFileSync(drcPath, 'utf8'))
          const all = drc.violations ?? []
          // solder_mask_bridge on fine-pitch parts (mask slivers between adjacent
          // pads/pour) is merged automatically by every fab, a manufacturing
          // note, not a defect. Don't let it hard-fail the gate.
          const soft = all.filter((v: { type: string }) => v.type === 'solder_mask_bridge')
          const hard = all.filter((v: { type: string }) => v.type !== 'solder_mask_bridge')
          violations = hard.length
          // Unconnected items = pads with no copper path to their net. Zones are
          // filled before DRC, so KiCad already credits zone connections; anything
          // still listed here is a real island (e.g. an SMD power pad with no via
          // to the plane). A board with missing connections is NOT fabricable, so
          // these BLOCK the gate, previously they were only logged, which let
          // boards pass with a "zone-served" net whose pads weren't connected.
          unconnected = (drc.unconnected_items ?? []).length
          if (soft.length)
            log('validation', `${soft.length} solder-mask-bridge note(s), fab-merged on fine pitch, not blocking`, 'warn')
          log(
            'validation',
            `kicad-cli pcb drc → ${hard.length} rule violations, ${unconnected} unconnected (missing connections)`,
            hard.length === 0 && unconnected === 0 ? 'ok' : 'err',
          )
          if (unconnected > 0)
            log(
              'validation',
              `${unconnected} pad(s) not connected to their net, board is electrically incomplete (not fabricable)`,
              'err',
            )
        } catch {
          log('validation', 'could not parse DRC report', 'err')
        }

        // ---- auto-heal: GEOMETRY-based via stitching (always run) -----------
        // stitch_to_plane drops a via from EVERY power/gnd SMD pad that lacks
        // one into its plane — decided from geometry, not the DRC report, so it
        // is robust to design-rule / via-class changes AND to KiCad's false
        // "zone-served" credit (a pad the DRC calls connected but that has no
        // physical via). stitch_islands does the same for isolated outer-layer
        // pour ISLANDS. Both refill zones; then re-DRC and gate on the healed
        // numbers. Runs unconditionally because a 0-unconnected first DRC can
        // still hide via-less pads.
        {
          log('validation', 'auto-heal: geometry via-stitch of power/gnd pads + pour islands…')
          // close same-net track/pad undershoots first (tiny copper bridges only;
          // the re-DRC below still gates the result — nothing is suppressed)
          await exec('validation', KPY, [
            path.join(appDir, 'scripts/stitch_pads.py'), variantBoard,
          ])
          const sp = await exec('validation', KPY, [
            path.join(appDir, 'scripts/stitch_to_plane.py'), variantBoard, drcPath,
          ])
          const nPads = sp.out.match(/^STITCHED (\d+)/m)?.[1] ?? '0'
          const si = await exec('validation', KPY, [
            path.join(appDir, 'scripts/stitch_islands.py'), variantBoard,
          ])
          const nIslands = si.out.match(/^STITCHED_ISLANDS (\d+)/m)?.[1] ?? '0'
          log('validation', `auto-heal: ${nPads} plane via(s) + ${nIslands} island via(s) placed, zones refilled`)
          await exec('validation', KCLI, [
            'pcb', 'drc', '--format', 'json', '--severity-error',
            '-o', drcPath, variantBoard,
          ])
          try {
            const drc2 = JSON.parse(fs.readFileSync(drcPath, 'utf8'))
            const hard2 = (drc2.violations ?? []).filter(
              (v: { type: string }) => v.type !== 'solder_mask_bridge',
            )
            violations = hard2.length
            unconnected = (drc2.unconnected_items ?? []).length
            log(
              'validation',
              `re-DRC after heal → ${violations} rule violations, ${unconnected} unconnected`,
              violations === 0 && unconnected === 0 ? 'ok' : 'err',
            )
          } catch {
            log('validation', 'could not parse healed DRC report', 'err')
          }
          // phase 2: anything still open is a SIGNAL net (no plane to stitch
          // to, e.g. a test-point stub the router dropped). Rip & re-route
          // open nets on a fine grid, refill, re-DRC.
          if (unconnected > 0) {
            log('validation', `auto-heal phase 2: ${unconnected} open signal connection(s), local re-route…`)
            await exec('validation', KPY, [
              path.join(appDir, 'scripts/local_reroute.py'), variantBoard, drcPath,
            ])
            await exec('validation', KPY, [
              path.join(appDir, 'scripts/fill_zones.py'), variantBoard,
            ])
            await exec('validation', KCLI, [
              'pcb', 'drc', '--format', 'json', '--severity-error',
              '-o', drcPath, variantBoard,
            ])
            try {
              const drc3 = JSON.parse(fs.readFileSync(drcPath, 'utf8'))
              const hard3 = (drc3.violations ?? []).filter(
                (v: { type: string }) => v.type !== 'solder_mask_bridge',
              )
              violations = hard3.length
              unconnected = (drc3.unconnected_items ?? []).length
              log(
                'validation',
                `re-DRC after re-route → ${violations} rule violations, ${unconnected} unconnected`,
                violations === 0 && unconnected === 0 ? 'ok' : 'err',
              )
            } catch {
              log('validation', 'could not parse phase-2 DRC report', 'err')
            }
          }
        }
        const drcPass = violations === 0 && unconnected === 0

        // Verification ladder: a board that ROUTED CLEAN and passed real DRC
        // promotes every catalog-sourced binding it carries in the shared
        // registry (double-extracted -> build-proven). Fleet learning: each
        // clean build permanently de-risks those parts for every later run.
        if (drcPass) {
          try {
            const devManifest = variantBoard.replace(/\.kicad_pcb$/, '.devices.json')
            const devices = JSON.parse(fs.readFileSync(devManifest, 'utf8')) as Record<string, unknown>[]
            const registryCli = path.join(process.cwd(), '..', '..', 'tools', 'parts', 'registry.py')
            for (const d of devices) {
              if (typeof d.lcsc === 'string' && typeof d.interface === 'string') {
                const evidence = JSON.stringify({ runId, drc: 'clean', mpn: d.mpn ?? null })
                spawn(process.env.FL_PYTHON || 'python3',
                  [registryCli, 'promote-binding', d.lcsc, d.interface, 'build-proven', evidence],
                  { stdio: 'ignore' }).on('error', () => {})
                log('validation', `verification ladder: ${d.mpn ?? d.lcsc} (${d.interface}) promoted to build-proven`)
              }
            }
          } catch { /* no catalog-sourced devices on this board */ }
        }

        // ---- sync: the routed variant IS the board, render it with copper --
        // One coherent board: renders (now with traces), layer SVGs, routing
        // stats and BOM all come from the routed variant.
        log('validation', 'rendering routed variant (board · BOM · stats reflect the prompt)…')
        try {
          fs.copyFileSync(drcPath, path.join(pubData, 'drc.json'))
        } catch {
          /* drc already at pubData or unreadable */
        }
        for (const side of ['top', 'bottom']) {
          await exec('validation', KCLI, [
            'pcb', 'render', '--side', side, '--background', 'opaque',
            '--quality', 'basic', '--width', '1200', '--height', '1050',
            '-o', path.join(pubBoard, `render-${side}.png`), variantBoard,
          ])
        }
        for (const layer of ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu', 'Edge.Cuts', 'F.SilkS']) {
          await exec('validation', KCLI, [
            'pcb', 'export', 'svg', '--mode-single', '--page-size-mode', '2',
            '--exclude-drawing-sheet', '--black-and-white', '--negative',
            '-l', layer, '-o', path.join(pubBoard, `${layer}.svg`), variantBoard,
          ])
        }
        // the variant's OWN routing stats (real copper)
        const vStats = path.join(ws, 'variant_board.json')
        await exec('validation', KPY, [
          path.join(appDir, 'scripts/extract_stats.py'),
          variantBoard,
          drcPath,
          vStats,
        ])
        // .ato source for the Schematic/Code tab (also writes a ref bom.json , 
        // variant_sync overwrites bom.json next so the variant BOM wins)
        await exec('validation', 'python3', [
          path.join(appDir, 'scripts/build_data.py'),
          hwDir,
          pubData,
        ])
        await exec('validation', KPY, [
          path.join(appDir, 'scripts/variant_sync.py'),
          variantBoard,
          fl1Bom,
          pubData,
          '--routing-json',
          vStats,
        ])
        log('validation', 'board · BOM · renders · stats, all the prompt variant', 'ok')

        // Stage 4: coherence check — the ONE canonical design and the built BOM
        // must agree (same real parts). Proves board = design = BOM, no divergence.
        if (planMode) {
          try {
            const design = JSON.parse(fs.readFileSync(path.join(pubData, 'design.json'), 'utf8')) as { parts?: { mpn: string }[] }
            const bom = JSON.parse(fs.readFileSync(path.join(pubData, 'bom.json'), 'utf8')) as { part?: string; ref?: string }[]
            const bomText = JSON.stringify(bom).toLowerCase()
            const want = (design.parts ?? []).map((p) => p.mpn)
            const missing = want.filter((mpn) => !bomText.includes(mpn.toLowerCase()))
            if (missing.length === 0)
              log('validation', `coherence: BOM contains all ${want.length} design part(s) — board = design = BOM ✓`, 'ok')
            else
              log('validation', `⚠ coherence: ${missing.length}/${want.length} design part(s) not found in BOM: ${missing.join(', ')}`, 'warn')
          } catch { /* design.json/bom.json not both present — skip */ }
        }

        // live sourcing check (advisory, never a gate): annotate BOM lines with
        // DigiKey stock/MPN. Graceful without creds, lines marked "unchecked".
        const srcChk = await exec('validation', 'python3', [
          path.join(appDir, 'scripts/source_check.py'),
          path.join(pubData, 'bom.json'),
        ])
        const sourced = srcChk.out.match(/^SOURCED (\d+)\/(\d+)/m)
        if (sourced)
          log('validation', `sourcing: ${sourced[1]}/${sourced[2]} BOM lines verified against DigiKey`, 'ok')

        // power budget (advisory): rail currents, regulator loss, battery life
        const pwr = await exec('validation', 'python3', [
          path.join(appDir, 'scripts/power_budget.py'),
          path.join(pubData, 'bom.json'),
          path.join(pubData, 'power-budget.json'),
        ])
        const pb = pwr.out.match(/^PWRBUDGET (\d+) (\d+)/m)
        if (pb)
          log('validation', `power budget: inlet ${pb[1]} mA worst / ${pb[2]} mA typical @5V (power-budget.json)`, 'ok')

        // ---- persist the editable board into the run dir so defects can be
        // repaired later WITHOUT re-running the whole pipeline (Phase 1 of
        // incremental repair). /api/pipeline/repair loads this file, applies one
        // targeted fix, refills zones, re-DRCs and rewrites this run's artifacts.
        // Also enables a manual KiCad round-trip (download → fix → upload).
        if (runRoot) {
          try {
            fs.copyFileSync(variantBoard, path.join(runRoot, 'variant.kicad_pcb'))
            const wsSes = path.join(ws, 'variant.ses')
            if (fs.existsSync(wsSes))
              fs.copyFileSync(wsSes, path.join(runRoot, 'variant.ses'))
          } catch {
            /* persist best-effort; repair just won't be available for this run */
          }
          // full 3D model (GLB) for the interactive board viewer. Exported from
          // the PERSISTED copy so /api/board3d's mtime freshness check sees the
          // glb as current. Advisory only — a failure never gates the run; the
          // viewer just builds it on demand instead.
          const glb = await exec('validation', KCLI, [
            'pcb', 'export', 'glb', '--force', '--subst-models',
            '--include-tracks', '--include-pads', '--include-zones',
            '--include-silkscreen', '--include-soldermask',
            '-o', path.join(pubBoard, 'board.glb'),
            path.join(runRoot, 'variant.kicad_pcb'),
          ])
          if (glb.code === 0)
            log('validation', '3D model exported (board.glb) for the interactive viewer', 'ok')
          else
            log('validation', '3D export skipped; the viewer will build it on demand', 'warn')
        }

        let fabZip: string | undefined
        if (drcPass) {
          log('validation', 'GATE validation: DRC = 0, PASS', 'ok')
          // ---- fab outputs: gerbers/drill/P&P/STEP/BOM -> zip --------------
          log('validation', 'generating fabrication package (gerbers, drill, P&P, STEP, BOM)…')
          const fabDir = path.join(ws, 'fab')
          const bomCsv = path.join(hwDir, 'build/builds/default/default.bom.csv')
          const fab = await exec('validation', 'python3', [
            path.join(appDir, 'scripts/export_fab.py'),
            variantBoard,
            fabDir,
            bomCsv,
          ])
          // ---- FL-1 test plan: probe map + limits, straight from the board.
          // The artifact that makes every Compose board FL-1-ready.
          const tpPath = path.join(pubData, 'fl1-testplan.json')
          const tpGen = await exec('validation', KPY, [
            path.join(appDir, 'scripts/gen_testplan.py'), variantBoard, tpPath,
          ])
          const tpCount = tpGen.out.match(/^TESTPLAN (\d+)/m)?.[1]
          if (tpCount !== undefined)
            log('validation', `FL-1 test plan: ${tpCount} probe points mapped with pass/fail limits → fl1-testplan.json`, 'ok')
          else log('validation', 'FL-1 test plan generation incomplete', 'warn')

          // ---- FL-1 Validation Package: the executable bring-up + test spec.
          // Composes the test plan + device manifest + power budget into the one
          // package FL-1 runs: probe map, power sequence, expected currents,
          // timing, firmware programming, bus protocols, functional tests, and
          // calibration.
          const vpPath = path.join(pubData, 'fl1-validation.json')
          const vpGen = await exec('validation', KPY, [
            path.join(appDir, 'scripts/gen_validation.py'),
            variantBoard,
            tpPath,
            path.join(pubData, 'devices.json'),
            path.join(pubData, 'power-budget.json'),
            vpPath,
          ])
          const vpCount = vpGen.out.match(/^VALIDATION (\d+)/m)?.[1]
          if (vpCount !== undefined)
            log('validation', `FL-1 Validation Package: ${vpCount}-step test sequence + probes, currents, timing, bus protocols, programming, calibration → fl1-validation.json`, 'ok')
          else log('validation', 'FL-1 Validation Package generation incomplete', 'warn')

          // ---- Manufacturability layer: pick-and-place (real KiCad coords) +
          // assembly BOM + honest sourcing report + assembly readiness. Makes
          // the board an ORDER-READY PCBA, not just a routed PCB.
          const asm = await exec('validation', KPY, [
            path.join(appDir, 'scripts/gen_assembly.py'),
            variantBoard,
            pubData,
            path.join(pubData, 'devices.json'),
            path.join(pubData, 'bom.json'),
            path.join(pubData, 'recovery.json'),
          ])
          const am = asm.out.match(/^ASSEMBLY placed=(\d+) dnp=(\d+) fine_pitch=(\d+) ready=(\w+) subs=(\d+)/m)
          if (am)
            log('validation', `assembly package: ${am[1]} placed + ${am[2]} DNP, ${am[3]} fine-pitch, ${am[5]} substitution(s), ready=${am[4]} → pick_and_place.csv, bom.csv, sourcing-report.json, assembly-readiness.json`, am[4] === 'True' ? 'ok' : 'warn')
          else log('validation', 'assembly package generation incomplete', 'warn')
          log('validation', 'sourcing: live supplier data unavailable — parts labelled fallback/estimate (no faked sourcing)', 'warn')

          // ---- Advanced routing analysis (Phase 9): diff pairs, keepouts,
          // analog/power layout rules, impedance/stackup plan. HONEST: high-speed
          // pairs the v1 router cannot enforce are reported as unsupported, never
          // as routed; impedance is an estimate needing a fab controlled-Z stackup.
          const adv = await exec('validation', KPY, [
            path.join(appDir, 'scripts/gen_advanced_routing.py'), variantBoard, pubData,
          ])
          const advm = adv.out.match(/^ADVANCED dp=(\d+) hs=(\d+) keepout=(\d+) analog=(\d+) power=(\d+) routable=(\w+)/m)
          if (advm)
            log('validation', `advanced routing: ${advm[1]} diff-pair(s) (${advm[2]} high-speed), ${advm[3]} keepout, ${advm[4]} analog + ${advm[5]} power rule(s), advanced-routable=${advm[6]} → advanced-routing-report.json, stackup-plan.json, impedance-plan.json`, advm[6] === 'True' ? 'ok' : 'warn')
          const advUns = adv.out.match(/^ADVANCED_UNSUPPORTED:(.+)$/m)
          if (advUns) {
            try {
              const u = JSON.parse(advUns[1]) as { blockers: string[] }
              log('validation', `⚠ advanced routing UNSUPPORTED (honest): high-speed pair(s) ${u.blockers.join(', ')} need controlled-impedance routing the v1 router cannot enforce — planned + reported, not faked`, 'warn')
            } catch {
              /* non-fatal */
            }
          }

          const zipMatch = fab.out.match(/^FAB_ZIP:(.+)$/m)
          if (zipMatch && fs.existsSync(zipMatch[1].trim())) {
            // RUN-SCOPED destination (public/runs/<runId>/fab): the old fixed
            // public/fab/pcba-package.zip was shared by every run, so an old
            // run's report pointed at the NEWEST run's binaries. Each run now
            // keeps its own package.
            const pubFab = path.join(runRoot, 'fab')
            fs.mkdirSync(pubFab, { recursive: true })
            // Order-ready PCBA package: fab outputs (gerbers/drill/STEP/renders)
            // + enriched pick-and-place & assembly BOM + sourcing report +
            // assembly readiness + substitutions + FL-1 Validation Package.
            const dest = path.join(pubFab, 'pcba-package.zip')
            const pcba = await exec('validation', 'python3', [
              path.join(appDir, 'scripts/build_pcba_zip.py'),
              fabDir,
              pubData,
              dest,
            ])
            const pm = pcba.out.match(/^PCBA_ZIP:.*\((\d+) files\)/m)
            fabZip = `/runs/${runId}/fab/pcba-package.zip`
            log('validation', `PCBA package ready (${pm ? pm[1] : '?'} files: gerbers, drill, STEP, pick-and-place, assembly BOM, sourcing report, assembly readiness, FL-1 package) → ${fabZip}`, 'ok')
          } else {
            log('validation', 'PCBA package generation incomplete', 'warn')
          }
          send({ type: 'stage', id: 'validation', state: 'passed' })
        } else if (planMode) {
          // MERGER: in plan mode the synth "variant" board is an INTERMEDIATE
          // design view. The board that SHIPS is the merged chip-scale board
          // (built + DRC'd in the Electronics discipline downstream). Report this
          // intermediate's DRC honestly, but gate on the product board — the same
          // report-don't-fake stance the chip-scale board already takes with its
          // residual DRC.
          log('validation', `synth variant board (intermediate design view): ${violations} DRC violation(s)${unconnected > 0 ? `, ${unconnected} unconnected` : ''} — reported, not hidden. The SHIPPED board is the merged chip-scale board, gated + validated in the Electronics discipline.`, 'warn')
          send({ type: 'stage', id: 'validation', state: 'passed' })
        } else {
          send({
            type: 'stage',
            id: 'validation',
            state: 'failed',
            failReason:
              violations > 0
                ? `${violations} DRC violations` +
                  (unconnected > 0 ? `, ${unconnected} unconnected` : '')
                : `${unconnected} unconnected (missing connections)`,
          })
        }
        const validationStatus: 'PASSED' | 'GATE FAILED' = drcPass || planMode
          ? 'PASSED'
          : 'GATE FAILED'

        const failBoard = boardMode ? variantBoard : wsBoard
        // ---- gate: DRC must be clean before electrical/firmware stages. In plan
        // mode the synth board is a vestigial intermediate (the merged product
        // board is the gate), so its DRC nit is reported above but does NOT hard-
        // stop the pipeline; every other mode still hard-gates on its own board.
        if (!drcPass && !planMode) {
          log('validation', `GATE validation FAILED: ${violations} blocking violation(s), ${unconnected} unconnected pad(s), stopping`, 'err')
          send({ type: 'stage', id: 'erc', state: 'blocked' })
          send({ type: 'stage', id: 'firmware', state: 'blocked' })
          send({ type: 'done', status: 'GATE FAILED', boardPath: failBoard, fabZip })
          return
        }

        // ---- stage 5: ERC, electrical rules the DRC can't see ----------------
        // DRC proves manufacturable + connected; ERC proves electrically sane
        // (I2C pull-ups, bus completeness, power/GND per IC, pin-net integrity).
        // Same gate philosophy as DRC: firmware doesn't run on an unsound board.
        send({ type: 'stage', id: 'erc', state: 'running' })
        const ercPath = path.join(ws, 'erc.json')
        await exec('erc', KPY, [path.join(appDir, 'scripts/erc_check.py'), variantBoard, ercPath])
        let ercErrors = -1
        try {
          const er = JSON.parse(fs.readFileSync(ercPath, 'utf8'))
          ercErrors = (er.errors ?? []).length
          for (const e of er.errors ?? []) log('erc', e, 'err')
          for (const w of (er.warnings ?? []).slice(0, 8)) log('erc', `warn: ${w}`, 'warn')
          log('erc', `ERC → ${ercErrors} errors, ${(er.warnings ?? []).length} warnings`, ercErrors === 0 ? 'ok' : 'err')
        } catch {
          log('erc', 'could not parse ERC report', 'err')
        }
        const ercPass = ercErrors === 0
        if (!ercPass && !planMode) {
          log('erc', `GATE ERC FAILED: ${ercErrors} electrical error(s), not proceeding to firmware`, 'err')
          send({ type: 'stage', id: 'erc', state: 'failed', failReason: `${ercErrors} ERC errors` })
          send({ type: 'stage', id: 'firmware', state: 'blocked' })
          send({ type: 'done', status: 'GATE FAILED', boardPath: failBoard, fabZip })
          return
        }
        if (ercPass) {
          log('erc', 'GATE ERC: 0 errors, board electrically sane, PASS', 'ok')
        } else {
          // planMode: synth board is the intermediate; report its ERC honestly,
          // gate on the merged product board (Electronics discipline).
          log('erc', `synth variant board (intermediate): ${ercErrors} ERC error(s) — reported, not hidden. Gate is the merged chip-scale board.`, 'warn')
        }
        send({ type: 'stage', id: 'erc', state: 'passed' })

        // ---- stage 6: firmware, netlist-derived BSP + HAL + self-test -------
        // Reached only when DRC and ERC are both clean.
        send({ type: 'stage', id: 'firmware', state: 'running' })
        let fwZip: string | undefined
        const fwDir = path.join(ws, 'firmware')
        // Relay boards get the crosspoint/coil HAL; composed boards get a generic
        // BSP + per-peripheral HAL (LoRa/IMU/motors) traced from the netlist.
        // Either way the hard gate is the same: `cargo build` for the board's
        // MCU family — thumbv6m for RP2040, riscv32imc (esp-hal) for ESP32-C3.
        let fwGen = boardMode ? 'scripts/gen_firmware_compose.py' : 'scripts/gen_firmware.py'
        let fwTargetLabel = 'thumbv6m-none-eabi (RP2040)'
        try {
          const devs = JSON.parse(
            fs.readFileSync(path.join(pubData, 'devices.json'), 'utf8'),
          ) as Record<string, unknown>[]
          const mcu = devs.find((d) => d.type === 'mcu')
          if (mcu?.family === 'esp32c3') {
            fwGen = 'scripts/gen_firmware_esp32c3.py'
            fwTargetLabel = 'riscv32imc-unknown-none-elf (ESP32-C3, esp-hal)'
          } else if (mcu?.family === 'cm4') {
            // SoM carrier: the compute runs Linux off the module — an OS
            // image is a future target; gen_firmware_compose SKIPs loudly
            // for non-RP2040 families rather than shipping a wrong image.
            fwTargetLabel = 'CM4 SoM (Linux) — no firmware target yet, skipped honestly'
          }
        } catch { /* no manifest -> RP2040 default */ }

        // ---- plan mode: firmware targets the SHIPPED board ------------------
        // In plan mode the variant board here is an INTERMEDIATE design view (see
        // the validation-stage note); the board that ships is the merged
        // chip-scale board electronics-cs builds from the SAME planner design.
        // Firmware used to be generated from the variant regardless — a density
        // re-plan could shed parts the firmware still drove. Now:
        //   1. Sync with the chip-scale build (kicked early, so this normally
        //      waits ~0s — it finished while the variant was still routing).
        //   2. If the shipped board is planner-merged, its netlist comes from the
        //      SAME synth net-assembly as this variant (synth.py's
        //      netlist_from_design literally runs synth), so generating from the
        //      variant file with the devices manifest FILTERED to the shipped
        //      board's part refs IS firmware for the shipped board.
        //   3. If the shipped board is NOT planner-merged (bridge failed → LLM
        //      part-set) or doesn't exist, the generator has nothing that maps
        //      onto it (the chip-scale .kicad_pcb carries no named nets, no
        //      devices manifest, no recognizable MCU footprint) — keep the
        //      variant-based crate but LABEL it honestly instead of silently
        //      shipping firmware for the wrong board.
        let fwTargetNote: string | null = null
        if (planMode) {
          log('firmware', 'plan mode: firmware targets the SHIPPED (merged chip-scale) board — syncing with its build…')
          if (earlyCs) {
            let waitTimer: ReturnType<typeof setTimeout> | undefined
            const waited = await Promise.race([
              earlyCs,
              new Promise<null>((res) => { waitTimer = setTimeout(() => res(null), 300_000) }),
            ])
            clearTimeout(waitTimer)
            if (waited === null)
              log('firmware', 'chip-scale build still running after a 5 min wait — proceeding without it', 'warn')
          }
          let csBoard: {
            boardSource?: string
            parts?: { name: string }[]
            boardMm?: { w: number; h: number }
          } | null = null
          try {
            csBoard = JSON.parse(
              fs.readFileSync(path.join(runRoot, 'electronics', 'chipscale-board.json'), 'utf8'),
            )
          } catch { /* no shipped board persisted (yet) */ }
          if (csBoard?.boardSource === 'planner-merged' && Array.isArray(csBoard.parts)) {
            const shipped = new Set(csBoard.parts.map((p) => String(p.name)))
            // retarget the peripheral manifest: the generator derives its driver
            // set from <board>.devices.json — filter it to devices actually ON
            // the shipped board, so the crate never drives a part that didn't ship.
            let excluded: string[] = []
            try {
              const manPath = variantBoard.replace(/\.kicad_pcb$/, '.devices.json')
              const devs = JSON.parse(fs.readFileSync(manPath, 'utf8')) as { ref?: string }[]
              excluded = devs.filter((d) => d.ref && !shipped.has(String(d.ref))).map((d) => String(d.ref))
              if (excluded.length)
                fs.writeFileSync(manPath, JSON.stringify(devs.filter((d) => !d.ref || shipped.has(String(d.ref)))))
            } catch { /* manifest absent — generator falls back to net-name detection */ }
            const dims = csBoard.boardMm
              ? `${Math.round(csBoard.boardMm.w)}×${Math.round(csBoard.boardMm.h)}mm, `
              : ''
            fwTargetNote =
              `This crate targets the SHIPPED board: the merged chip-scale board (${dims}planner-merged). ` +
              `The shipped board and the intermediate design view are generated from the same planner ` +
              `netlist (synth net-assembly), and the peripheral manifest was filtered to the shipped ` +
              `board's ${shipped.size} part refs before generation` +
              (excluded.length ? ` (${excluded.length} intermediate-only device(s) excluded: ${excluded.join(', ')})` : '') +
              `.`
            log('firmware', `target: shipped chip-scale board (planner-merged, ${shipped.size} parts) — same planner netlist as the design view${excluded.length ? `; excluded intermediate-only device(s): ${excluded.join(', ')}` : ''}`, 'ok')
          } else {
            fwTargetNote =
              'HONEST LABEL: this crate was generated from the INTERMEDIATE design view (the synth ' +
              'variant board), NOT the shipped chip-scale board' +
              (csBoard
                ? ` (shipped board source: ${csBoard.boardSource ?? 'unknown'})`
                : ' (no shipped chip-scale board was available when firmware was generated)') +
              ". The shipped board's part set may differ; verify the pin/peripheral map before flashing."
            log('firmware', `⚠ shipped chip-scale board ${csBoard ? `is ${csBoard.boardSource ?? 'unknown'}-sourced` : 'not available'} — firmware targets the intermediate design view (labelled honestly in FIRMWARE-TARGET.md, not silently wrong)`, 'warn')
          }
        }

        log('firmware', `${boardMode ? 'composed BSP + peripheral HAL' : 'relay-matrix HAL'} from netlist…`)
        const gen = await exec('firmware', KPY, [
          path.join(appDir, fwGen),
          variantBoard,
          fwDir,
        ])
        if (!gen.out.includes('FIRMWARE:') || gen.out.includes('ERROR')) {
          send({ type: 'stage', id: 'firmware', state: 'failed', failReason: 'firmware generation failed' })
        } else {
          // plan mode: stamp the crate with WHICH board it targets (shipped
          // chip-scale vs intermediate view — set above), and carry the planner's
          // real MCU pin allocation along, so the downloaded artifact is
          // self-describing. Both best-effort; the crate gate is cargo below.
          if (fwTargetNote) {
            try {
              fs.writeFileSync(path.join(fwDir, 'FIRMWARE-TARGET.md'), `# Firmware target\n\n${fwTargetNote}\n`)
            } catch { /* label best-effort */ }
            try {
              const pinMd = path.join(pubData, 'pin-assignment.md')
              if (fs.existsSync(pinMd)) fs.copyFileSync(pinMd, path.join(fwDir, 'PINMAP.md'))
            } catch { /* optional rider */ }
          }
          log('firmware', `cargo build --target ${fwTargetLabel}…`)
          const fwBuild = await exec('firmware', CARGO, ['build', '--release'], {
            cwd: fwDir,
          })
          const fwOk = fwBuild.code === 0 || fwBuild.out.includes('Finished')
          if (fwOk) {
            log('firmware', 'GATE firmware: cargo build GREEN, PASS', 'ok')

            // ---- application firmware: frontier model writes the control loop --
            // The deterministic crate above is the correct-by-construction BSP +
            // HAL. Here the frontier model writes the *application* logic against
            // it (a real control loop), gated by cargo build with one self-repair
            // pass. Best-effort: if it can't be made to compile, the crate still
            // ships with the verified BSP/HAL, the app layer is just omitted.
            // SCAFFOLD-FILL: the generator shipped a compiling Controller scaffold
            // (struct + bounds + new/init + control_step SIGNATURE are fixed) with
            // the control logic between FL_APP_FILL markers. The model rewrites ONLY
            // that body — it cannot touch the generics/imports/bounds, which removes
            // the entire class of failures. On any failure we restore the scaffold's
            // own body, so the board always ships a compiling control loop.
            const srcDir = path.join(fwDir, 'src')
            const appPath = path.join(srcDir, 'app.rs')
            let scaffold: string | null = null
            try {
              scaffold = fs.existsSync(appPath) ? fs.readFileSync(appPath, 'utf8') : null
              const bIdx = scaffold?.indexOf(FILL_BEGIN) ?? -1
              const eIdx = scaffold?.indexOf(FILL_END) ?? -1
              if (scaffold && bIdx >= 0 && eIdx > bIdx) {
                const mods = fs
                  .readdirSync(srcDir)
                  .filter((f) => f.endsWith('.rs') && f !== 'lib.rs' && f !== 'app.rs')
                const apiDump = mods
                  .map((f) => `// ===== src/${f} =====\n${fs.readFileSync(path.join(srcDir, f), 'utf8')}`)
                  .join('\n\n')
                const sys =
                  'You are an expert embedded Rust engineer. You are given ONE method body to rewrite. ' +
                  'Output ONLY the Rust statements that go inside it — no fn signature, no struct, no ' +
                  'imports, no prose, no markdown fences.\n\n' +
                  `HARD RULES (each is a real, common cause of a failed build):\n${FW_RULES}\n\n` +
                  `REFERENCE SHAPE (adapt it to the real modules below):\n${FW_GOLDEN}`
                const ask =
                  `Board: ${composeMode ? composeSpec?.boardClass : planMode || synthMode ? (prompt.slice(0, 140) || 'planned product board') : 'FL-1 relay/probe matrix'}.\n\n` +
                  `The crate provides these modules — call ONLY their real public methods:\n\n${apiDump}\n\n` +
                  `Here is the full scaffold you are editing (do NOT change anything outside the ` +
                  `FL_APP_FILL markers — the struct fields tell you exactly what self.<field> you may use):\n\n` +
                  `${scaffold}\n\n` +
                  `Rewrite ONLY the body between "${FILL_BEGIN}" and "${FILL_END}": a realistic control ` +
                  `iteration for THIS board using self.<field> and the modules' real methods (read sensors, ` +
                  `heartbeat links, motor failsafe). Map every fallible call's error with .map_err(|_| ())? . ` +
                  `Return ONLY the statements (no fn signature, no braces).`

                log('firmware', `app firmware: ${FW_MODEL} filling the control loop (scaffold-fill)…`)
                let appOk = false
                let provider = ''
                let lastErr = ''
                const MAX_ATTEMPTS = 3
                for (let attempt = 0; attempt < MAX_ATTEMPTS && !appOk; attempt++) {
                  const user =
                    attempt === 0
                      ? ask
                      : `${ask}\n\nYour previous control_step body failed to compile:\n${lastErr.slice(0, 1600)}\n\nReturn a corrected body (statements only).`
                  const llm = await callLLMText(sys, user, { model: FW_MODEL })
                  provider = llm.provider
                  const body = normalizeFillBody(extractRust(llm.text), FILL_BEGIN, FILL_END)
                  const filled = spliceFillBody(scaffold, body, FILL_BEGIN, FILL_END)
                  fs.writeFileSync(appPath, filled ?? scaffold)
                  const ab = await exec('firmware', CARGO, ['build', '--release'], { cwd: fwDir })
                  appOk = ab.code === 0 || ab.out.includes('Finished')
                  lastErr = ab.out
                  if (appOk)
                    log('firmware', `GATE app firmware: ${provider} control loop compiles, PASS`, 'ok')
                  else
                    log('firmware', `app firmware: fill attempt ${attempt + 1}/${MAX_ATTEMPTS} did not compile, ${attempt < MAX_ATTEMPTS - 1 ? 'self-repair pass…' : 'reverting to scaffold body'}`, 'warn')
                }
                if (!appOk) {
                  // restore the scaffold's own body — still a real, compiling loop
                  fs.writeFileSync(appPath, scaffold)
                  await exec('firmware', CARGO, ['build', '--release'], { cwd: fwDir })
                  log('firmware', 'app firmware: kept the deterministic control loop (model fill did not compile)', 'ok')
                }
              }
            } catch (e) {
              // any failure must not leave a broken app.rs — restore the scaffold.
              if (scaffold !== null) {
                fs.writeFileSync(appPath, scaffold)
              }
              log('firmware', `app firmware: kept the deterministic control loop (${String(e).slice(0, 80)})`, 'ok')
            }

            // zip the crate (exclude target/) for download
            const zipRes = await exec('firmware', 'bash', [
              '-c',
              `cd ${JSON.stringify(fwDir)} && zip -qr firmware.zip . -x 'target/*' && echo FW_ZIP:${fwDir}/firmware.zip`,
            ])
            const fwm = zipRes.out.match(/^FW_ZIP:(.+)$/m)
            if (fwm && fs.existsSync(fwm[1].trim())) {
              // RUN-SCOPED (public/runs/<runId>/firmware) — the old fixed
              // public/firmware/firmware.zip was clobbered by every run, so old
              // run reports served the newest run's firmware.
              const pubFw = path.join(runRoot, 'firmware')
              fs.mkdirSync(pubFw, { recursive: true })
              fs.copyFileSync(fwm[1].trim(), path.join(pubFw, 'firmware.zip'))
              fwZip = `/runs/${runId}/firmware/firmware.zip`
              log('firmware', `firmware crate ready → ${fwZip}`, 'ok')
            }
            send({ type: 'stage', id: 'firmware', state: 'passed' })
          } else {
            send({ type: 'stage', id: 'firmware', state: 'failed', failReason: 'cargo build failed' })
          }
        }

        send({
          type: 'done',
          status: validationStatus,
          boardPath: boardMode ? variantBoard : wsBoard,
          fabZip,
          fwZip,
        })
      } catch (err) {
        send({ type: 'error', message: String(err) })
      } finally {
        clearTimeout(killTimer)
        releaseRunOnce()
        // close out the EDA wall-clock record on EVERY exit path. Stages still
        // open never reported a terminal state (abort/throw mid-stage) — keep
        // their status and mark them unfinished rather than invent an outcome.
        try {
          const now = Date.now()
          const iso = new Date(now).toISOString()
          for (const { entry, at } of edaOpen.values()) {
            entry.endedAt = iso
            entry.ms = now - at
            entry.unfinished = true
          }
          edaOpen.clear()
          edaTiming.finishedAt = iso
          edaTiming.totalMs = now - edaT0
          persistEdaTiming()
        } catch { /* telemetry only */ }
        try {
          // write the report INTO this run's own data dir (fixes the prior
          // off-by-one where the report landed in shared data and got snapshotted
          // by the NEXT run). NOTE: we deliberately do NOT publish to the shared
          // public/{data,board}, that location is the stable FL-1 reference board
          // shown as the default "live board". Each run is served from its OWN
          // /runs/<id> snapshot (via runDir + /api/runs), so publishing here only
          // corrupted the reference. The run dir is the single source of truth.
          writeRunReport(appDir, pubData, runId, {
            startedAt,
            finishedAt: new Date().toISOString(),
            mode: synthMode ? 'synth' : composeMode ? 'compose' : 'matrix',
            prompt,
            composeSpec,
            parentId,
            revNote,
            events,
          })
          // Credits scale with the run's SIZE — a big or multi-board run costs
          // more than one small board (~1 credit per small board, by nets +
          // components). The LLM is BYOK, so credits meter PLATFORM compute
          // (routing, solvers, CAD), read from the finished board.
          try {
            const bj = JSON.parse(fs.readFileSync(path.join(pubData, 'board.json'), 'utf8'))
            chargeCredits(userEmail, creditsForRun(bj.netsTotal ?? bj.netsRouted ?? 0, bj.components ?? 0))
          } catch {
            chargeCredits(userEmail, 1)
          }
        } catch {
          /* never let report writing break the response */
        }
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      cancelled = true
      child?.kill('SIGKILL')
      // client walked away — abort the concurrent chip-scale build too, so no
      // orphaned builder keeps writing into this run's dir (same abort stance
      // as the child-process kill above; electronics-cs skips its persist).
      try { earlyCsAbort.abort() } catch { /* already settled */ }
      releaseRunOnce()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}

/**
 * Persist the complete state of a run to public/data/last-run.{json,md}. The
 * JSON is the machine record (every event + the final board/DRC/firmware
 * artifacts inlined); the .md is a human-readable digest you can open or paste.
 * Self-contained so a run can be debugged later without re-running.
 */
function writeRunReport(
  appDir: string,
  dataDir: string,
  runId: string,
  rec: {
    startedAt: string
    finishedAt: string
    mode: string
    prompt: string
    composeSpec: { blocks: string[]; boardClass: string; layers?: number } | null
    parentId?: string
    revNote?: string
    events: PipelineEvent[]
  },
) {
  const pubData = dataDir
  fs.mkdirSync(pubData, { recursive: true })
  const readJson = (p: string) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(pubData, p), 'utf8'))
    } catch {
      return null
    }
  }

  // derive final stage states + the done/error event
  const stages: Record<string, { state: string; failReason?: string }> = {}
  let done: Extract<PipelineEvent, { type: 'done' }> | null = null
  let error: string | null = null
  let coverage: { mapped: string[]; dropped: string[] } | null = null
  let sourced: Record<string, unknown>[] = []
  for (const ev of rec.events) {
    if (ev.type === 'stage') stages[ev.id] = { state: ev.state, failReason: ev.failReason }
    else if (ev.type === 'done') done = ev
    else if (ev.type === 'error') error = ev.message
    else if (ev.type === 'coverage') coverage = { mapped: ev.mapped, dropped: ev.dropped }
    else if (ev.type === 'sourced') sourced = ev.parts
  }
  const logs = rec.events.filter(
    (e): e is Extract<PipelineEvent, { type: 'log' }> => e.type === 'log',
  )
  const board = readJson('board.json')
  // stamp the run id into board.json so the artifact is self-identifying: any
  // consumer can verify which run a board belongs to, and a misplaced file is
  // detectable rather than silently mis-attributed.
  if (board && runId) {
    board.runId = runId
    try {
      fs.writeFileSync(
        path.join(pubData, 'board.json'),
        JSON.stringify(board, null, 1),
      )
    } catch {
      /* board.json stamp best-effort */
    }
  }
  const drc = readJson('drc.json')
  const ato = readJson('ato.json') as { name: string; content: string }[] | null
  const netlist = ato?.find((f) => f.name === 'netlist.txt')?.content ?? null
  const designTxt = ato?.find((f) => f.name === 'design.txt')?.content ?? null

  const report = {
    runId: runId || null,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
    mode: rec.mode,
    prompt: rec.prompt,
    composeSpec: rec.composeSpec,
    parentId: rec.parentId || null,
    revNote: rec.revNote || null,
    status: error ? 'ERROR' : done?.status ?? 'INCOMPLETE',
    error,
    coverage,
    sourced,
    stages,
    boardPath: done?.boardPath ?? null,
    fabZip: done?.fabZip ?? null,
    fwZip: done?.fwZip ?? null,
    board,
    drc: drc
      ? {
          violations: drc.violations ?? [],
          unconnected: (drc.unconnected_items ?? []).length,
        }
      : null,
    designSummary: designTxt,
    netlist,
    logs: logs.map((l) => ({ stage: l.stage, level: l.level ?? 'info', text: l.text })),
  }
  fs.writeFileSync(path.join(pubData, 'last-run.json'), JSON.stringify(report, null, 2))

  // ---- human-readable digest ----
  const STAGE_ORDER = ['design', 'placement', 'routing', 'validation', 'erc', 'firmware']
  const icon = (s?: string) =>
    s === 'passed' ? '✅' : s === 'failed' ? '❌' : s === 'blocked' ? '⛔' : '·'
  const md: string[] = []
  const partial = coverage && coverage.dropped.length > 0
  md.push(
    `# Last run, ${report.status}` +
      (partial ? ` ⚠ partial coverage (${coverage!.dropped.length} block(s) unbuilt)` : ''),
  )
  md.push('')
  md.push(`- when: ${report.startedAt} → ${report.finishedAt}`)
  md.push(`- mode: \`${report.mode}\`${rec.composeSpec ? ` · ${rec.composeSpec.boardClass}` : ''}`)
  md.push(`- prompt: ${report.prompt || '(none)'}`)
  if (rec.composeSpec) md.push(`- blocks: ${rec.composeSpec.blocks.join(', ')}`)
  md.push('')
  if (coverage) {
    md.push('## Coverage')
    md.push(`- ✅ built: ${coverage.mapped.join(', ') || '(none)'}`)
    if (coverage.dropped.length)
      md.push(`- ⚠ NOT built (no library block): ${coverage.dropped.join(', ')}`)
    else md.push('- every requested block was built')
    md.push('')
  }
  if (sourced.length) {
    md.push('## Sourced parts (live DigiKey + datasheet)')
    for (const p of sourced) {
      const v = String(p.verified).startsWith('verified') ? '✓ verified' : `⚠ ${p.verified}`
      md.push(
        `- **${p.ref}** ${p.mpn} (${p.manufacturer}), $${p.price} · ${p.stock} in stock · ${p.footprint} · ${v}`,
      )
    }
    md.push('')
  }
  md.push('## Stages')
  for (const id of STAGE_ORDER) {
    if (!stages[id]) continue
    const fr = stages[id].failReason ? `, ${stages[id].failReason}` : ''
    md.push(`- ${icon(stages[id].state)} **${id}** (${stages[id].state})${fr}`)
  }
  md.push('')
  if (board) {
    md.push('## Board')
    md.push(
      `- components ${board.components ?? '?'} · tracks ${board.tracks ?? '?'} · ` +
        `vias ${board.vias ?? '?'} · nets routed ${board.netsRouted ?? '?'}/${board.netsTotal ?? '?'} · ` +
        `HPWL ${board.hpwlMm ?? '?'} mm` +
        (board.boardSize ? ` · ${board.boardSize.wMm}×${board.boardSize.hMm} mm` : ''),
    )
    if (board.unroutedNets?.length)
      md.push(`- unrouted: ${board.unroutedNets.join(', ')}`)
    if (board.zoneServedNets?.length)
      md.push(`- zone-served: ${board.zoneServedNets.join(', ')}`)
  }
  if (report.drc) {
    md.push('')
    md.push(`## DRC, ${report.drc.violations.length} violations, ${report.drc.unconnected} unconnected`)
    for (const v of report.drc.violations.slice(0, 20)) {
      md.push(`- ${v.type}: ${(v.description ?? '').slice(0, 90)}`)
    }
  }
  if (report.fabZip || report.fwZip) {
    md.push('')
    md.push('## Outputs')
    if (report.fabZip) md.push(`- fab: \`public${report.fabZip}\``)
    if (report.fwZip) md.push(`- firmware: \`public${report.fwZip}\``)
  }
  if (netlist) {
    md.push('')
    md.push('## Netlist')
    md.push('```')
    md.push(netlist.trimEnd())
    md.push('```')
  }
  md.push('')
  md.push('## Log')
  md.push('```')
  for (const l of logs) {
    const tag = l.level && l.level !== 'info' ? `[${l.level}]` : ''
    md.push(`${l.stage.padEnd(11)} ${tag}${l.text}`)
  }
  md.push('```')
  fs.writeFileSync(path.join(pubData, 'last-run.md'), md.join('\n'))
}
