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
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callLLMText, extractRust } from '@/lib/llm'
import { canRun, chargeCredits, creditsAvailable, creditsForRun, getUser, recordRun, sessionEmail } from '@/lib/auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 1800

const KCLI = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
const KPY =
  '/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3'
const RUN_TIMEOUT_MS = 20 * 60 * 1000

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

const globalState = globalThis as unknown as { __pipelineRunning?: boolean }

export async function GET(req: Request) {
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
  if (!canRun(userRec)) {
    return new Response(
      `Out of credits (${creditsAvailable(userRec)} left). Upgrade to Pro or buy a credit pack to keep designing.`,
      { status: 402 },
    )
  }
  if (globalState.__pipelineRunning) {
    return new Response('a pipeline run is already in progress', { status: 409 })
  }
  globalState.__pipelineRunning = true

  const qp = new URL(req.url).searchParams
  const prompt = qp.get('prompt') ?? ''
  // per-run artifact snapshot id (so each run keeps its OWN board/renders/data
  // instead of all runs sharing the latest write to public/board)
  const runId = (qp.get('runId') ?? '').replace(/[^a-zA-Z0-9_-]/g, '')
  // rev lineage (revise flow): parent run id + one-line reason
  const parentId = (qp.get('parent') ?? '').replace(/[^a-zA-Z0-9_-]/g, '')
  const revNote = (qp.get('revNote') ?? '').slice(0, 300)
  // Layer-2 compose mode: the interview passes a base64 {blocks, boardClass}
  const composeMode = qp.get('compose') === '1'
  let composeSpec: { blocks: string[]; boardClass: string } | null = null
  if (composeMode) {
    try {
      composeSpec = JSON.parse(
        Buffer.from(decodeURIComponent(qp.get('spec') ?? ''), 'base64').toString('utf8'),
      )
    } catch {
      composeSpec = null
    }
  }
  const appDir = process.cwd()
  const hwDir = path.resolve(appDir, '../../hardware/pcba-rev-a')
  const flroute = path.join(hwDir, 'tools/flroute/target/release/flroute')
  const ATO = process.env.ATO_BIN || `${process.env.HOME}/.local/bin/ato`
  const CARGO = process.env.CARGO_BIN || `${process.env.HOME}/.cargo/bin/cargo`
  // Each run owns an id-scoped output dir (public/runs/<id>/{data,board}); nothing
  // is shared between runs, so one run's board/BOM/renders can NEVER leak into
  // another. With no runId we fall back to the shared public/data + public/board
  // (the default "latest" view). At the end we also publish a run's outputs to
  // that shared location so the no-id default view shows the most recent board.
  const runRoot = runId ? path.join(appDir, 'public/runs', runId) : null
  const pubData = runRoot
    ? path.join(runRoot, 'data')
    : path.join(appDir, 'public/data')
  const pubBoard = runRoot
    ? path.join(runRoot, 'board')
    : path.join(appDir, 'public/board')
  const encoder = new TextEncoder()
  let child: ChildProcess | null = null
  let cancelled = false

  // Full record of the run, every event in order, persisted on completion so
  // the last iteration can be inspected later without re-running or screenshots.
  const startedAt = new Date().toISOString()
  const events: PipelineEvent[] = []

  // count the run + attach ownership up front (a crashed run still consumed
  // pipeline time; artifact filtering keys off this ownership record)
  recordRun(userEmail, runId)

  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev: PipelineEvent) => {
        // this run's artifacts were written straight into public/runs/<id>, point
        // the client at that snapshot. No copy needed; the dir already holds only
        // this run's board (publish-to-shared happens after the report is written).
        if (ev.type === 'done' && runId) {
          ev.runDir = `/runs/${runId}`
        }
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
            env: { ...process.env, ...opts.env },
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

        // ---- start this run's id-scoped output dir CLEAN. Every artifact below
        // is written straight into it, so a run only ever contains its own board.
        // A run that gate-fails before the render/validation stage leaves no
        // board.json, loadRealBoard keys off that, so it honestly shows no board
        // rather than inheriting another run's files. Wiping first also means a
        // re-run of the same id can't keep stale files from the prior attempt.
        if (runRoot) fs.rmSync(runRoot, { recursive: true, force: true })
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
        const skipArgs = zoneNets.flatMap((n) => ['--skip-net', n])
        log('routing', `flroute: skipping zone-served nets [${zoneNets.join(', ')}]`)
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

          const zipMatch = fab.out.match(/^FAB_ZIP:(.+)$/m)
          if (zipMatch && fs.existsSync(zipMatch[1].trim())) {
            const pubFab = path.join(appDir, 'public/fab')
            fs.mkdirSync(pubFab, { recursive: true })
            const dest = path.join(pubFab, 'fab-package.zip')
            fs.copyFileSync(zipMatch[1].trim(), dest)
            // ship the FL-1 test plan inside the fab package
            if (fs.existsSync(tpPath)) {
              await exec('validation', 'python3', [
                '-c',
                `import zipfile; z=zipfile.ZipFile(${JSON.stringify(dest)},'a'); ` +
                  `z.write(${JSON.stringify(tpPath)},'fl1-testplan.json'); z.close()`,
              ])
            }
            fabZip = '/fab/fab-package.zip'
            log('validation', `fab package ready (incl. FL-1 test plan) → ${fabZip}`, 'ok')
          } else {
            log('validation', 'fab package generation incomplete', 'warn')
          }
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
        const validationStatus: 'PASSED' | 'GATE FAILED' = drcPass
          ? 'PASSED'
          : 'GATE FAILED'

        const failBoard = composeMode ? variantBoard : wsBoard
        // ---- gate: DRC must be clean before electrical/firmware stages -------
        if (!drcPass) {
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
        if (!ercPass) {
          log('erc', `GATE ERC FAILED: ${ercErrors} electrical error(s), not proceeding to firmware`, 'err')
          send({ type: 'stage', id: 'erc', state: 'failed', failReason: `${ercErrors} ERC errors` })
          send({ type: 'stage', id: 'firmware', state: 'blocked' })
          send({ type: 'done', status: 'GATE FAILED', boardPath: failBoard, fabZip })
          return
        }
        log('erc', 'GATE ERC: 0 errors, board electrically sane, PASS', 'ok')
        send({ type: 'stage', id: 'erc', state: 'passed' })

        // ---- stage 6: firmware, netlist-derived BSP + HAL + self-test -------
        // Reached only when DRC and ERC are both clean.
        send({ type: 'stage', id: 'firmware', state: 'running' })
        let fwZip: string | undefined
        const fwDir = path.join(ws, 'firmware')
        // Relay boards get the crosspoint/coil HAL; composed boards get a generic
        // BSP + per-peripheral HAL (LoRa/IMU/motors) traced from the netlist.
        // Either way the hard gate is the same: `cargo build` for the RP2040.
        const fwGen = composeMode ? 'scripts/gen_firmware_compose.py' : 'scripts/gen_firmware.py'
        log('firmware', `${composeMode ? 'composed BSP + peripheral HAL' : 'relay-matrix HAL'} from netlist…`)
        const gen = await exec('firmware', KPY, [
          path.join(appDir, fwGen),
          variantBoard,
          fwDir,
        ])
        if (!gen.out.includes('FIRMWARE:') || gen.out.includes('ERROR')) {
          send({ type: 'stage', id: 'firmware', state: 'failed', failReason: 'firmware generation failed' })
        } else {
          log('firmware', 'cargo build --target thumbv6m-none-eabi (RP2040)…')
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
            try {
              const srcDir = path.join(fwDir, 'src')
              const libPath = path.join(srcDir, 'lib.rs')
              const libOrig = fs.readFileSync(libPath, 'utf8')
              const mods = fs
                .readdirSync(srcDir)
                .filter((f) => f.endsWith('.rs') && f !== 'lib.rs' && f !== 'app.rs')
              const apiDump = mods
                .map((f) => `// ===== src/${f} =====\n${fs.readFileSync(path.join(srcDir, f), 'utf8')}`)
                .join('\n\n')
              const sys =
                'You are an expert embedded Rust engineer writing no_std firmware. ' +
                'Output ONLY the Rust source of one module file, no prose, no markdown fences.'
              const ask =
                `Target: RP2040 (thumbv6m-none-eabi), no_std, embedded-hal 1.0 only ` +
                `(NO concrete HAL crate, NO runtime, NO new dependencies).\n` +
                `Board: ${composeMode ? composeSpec?.boardClass : 'FL-1 relay/probe matrix'}.\n\n` +
                `The crate already provides these modules, use them, do not redefine them:\n\n` +
                `${apiDump}\n\n` +
                `Write src/app.rs: a generic application controller that drives this board ` +
                `using the modules above. Rules:\n` +
                `- no_std; reference only crate::{${mods.map((m) => m.replace('.rs', '')).join(', ')}} and embedded-hal 1.0 traits.\n` +
                `- A struct owning ONLY the peripherals that exist above, generic over concrete types with ` +
                `EXACTLY these embedded-hal/embedded-io bounds where used: ` +
                `SPI: embedded_hal::spi::SpiDevice, RST: embedded_hal::digital::OutputPin, ` +
                `I2C: embedded_hal::i2c::I2c, PWM: embedded_hal::pwm::SetDutyCycle, D: embedded_hal::delay::DelayNs, ` +
                `R: embedded_io::Read, S: embedded_io::Read + embedded_io::Write.\n` +
                `- new(...), init(&mut self) that probes/brings up each present peripheral, and control_step(&mut self) ` +
                `running ONE realistic iteration that fits THIS board's peripherals, derive the behavior from what ` +
                `exists, do not assume motors or a radio. Examples by peripheral: GNSS -> read a fix sentence; ` +
                `cellular modem -> send the latest reading via an AT command; IMU -> read accel; motors -> apply a ` +
                `throttle with failsafe-disarm. Use only the modules above and only their real public functions.\n` +
                `- No main, no #[entry], no panic handler, this is a library module. It MUST compile. Return only src/app.rs.`

              log('firmware', 'app firmware: frontier model writing the control loop…')
              let appOk = false
              let provider = ''
              let lastErr = ''
              for (let attempt = 0; attempt < 2 && !appOk; attempt++) {
                const user =
                  attempt === 0
                    ? ask
                    : `${ask}\n\nYour previous src/app.rs failed to compile:\n${lastErr.slice(0, 1800)}\n\nReturn a corrected src/app.rs (code only).`
                const llm = await callLLMText(sys, user)
                provider = llm.provider
                fs.writeFileSync(path.join(srcDir, 'app.rs'), extractRust(llm.text))
                if (!libOrig.includes('pub mod app;'))
                  fs.writeFileSync(libPath, libOrig.replace(/\n*$/, '\n') + 'pub mod app;\n')
                const ab = await exec('firmware', CARGO, ['build', '--release'], { cwd: fwDir })
                appOk = ab.code === 0 || ab.out.includes('Finished')
                lastErr = ab.out
                if (appOk)
                  log('firmware', `GATE app firmware: ${provider} control loop compiles, PASS`, 'ok')
                else if (attempt === 0)
                  log('firmware', 'app firmware: draft failed to compile, self-repair pass…', 'warn')
              }
              if (!appOk) {
                // revert: ship the verified BSP/HAL crate without the app layer
                fs.rmSync(path.join(srcDir, 'app.rs'), { force: true })
                fs.writeFileSync(libPath, libOrig)
                await exec('firmware', CARGO, ['build', '--release'], { cwd: fwDir })
                log('firmware', 'app firmware: did not compile after repair, shipping BSP/HAL only', 'warn')
              }
            } catch (e) {
              log('firmware', `app firmware skipped: ${String(e)}`, 'warn')
            }

            // zip the crate (exclude target/) for download
            const zipRes = await exec('firmware', 'bash', [
              '-c',
              `cd ${JSON.stringify(fwDir)} && zip -qr firmware.zip . -x 'target/*' && echo FW_ZIP:${fwDir}/firmware.zip`,
            ])
            const fwm = zipRes.out.match(/^FW_ZIP:(.+)$/m)
            if (fwm && fs.existsSync(fwm[1].trim())) {
              const pubFw = path.join(appDir, 'public/firmware')
              fs.mkdirSync(pubFw, { recursive: true })
              fs.copyFileSync(fwm[1].trim(), path.join(pubFw, 'firmware.zip'))
              fwZip = '/firmware/firmware.zip'
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
          boardPath: composeMode ? variantBoard : wsBoard,
          fabZip,
          fwZip,
        })
      } catch (err) {
        send({ type: 'error', message: String(err) })
      } finally {
        clearTimeout(killTimer)
        globalState.__pipelineRunning = false
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
            mode: composeMode ? 'compose' : 'matrix',
            prompt,
            composeSpec,
            parentId,
            revNote,
            events,
          })
          // charge credits by the finished board's complexity (nets + parts).
          // Read the just-written board.json; fall back to 1 credit if absent.
          try {
            const bj = JSON.parse(
              fs.readFileSync(path.join(pubData, 'board.json'), 'utf8'),
            )
            const cost = creditsForRun(bj.netsTotal ?? bj.netsRouted ?? 0, bj.components ?? 0)
            chargeCredits(userEmail, cost)
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
      globalState.__pipelineRunning = false
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
    composeSpec: { blocks: string[]; boardClass: string } | null
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
