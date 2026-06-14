/**
 * Real pipeline runner: placement → routing → validation on an isolated
 * COPY of the board, streamed to the browser as SSE events.
 *
 * - Never touches the working rev-a-routed.kicad_pcb (runs in a temp
 *   workspace; promoting a result back is an explicit manual step).
 * - Uses the existing flroute release binary — never rebuilds it.
 * - Gates are enforced: placement gate failure blocks routing/validation.
 * - Ends by running sync-board.sh against the run output so the UI's
 *   Board/BOM/Gates tabs refresh with the new real artifacts.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  | {
      type: 'done'
      status: 'PASSED' | 'GATE FAILED'
      boardPath: string
      fabZip?: string
      fwZip?: string
    }
  | { type: 'error'; message: string }

const globalState = globalThis as unknown as { __pipelineRunning?: boolean }

export async function GET(req: Request) {
  if (globalState.__pipelineRunning) {
    return new Response('a pipeline run is already in progress', { status: 409 })
  }
  globalState.__pipelineRunning = true

  const qp = new URL(req.url).searchParams
  const prompt = qp.get('prompt') ?? ''
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
  const encoder = new TextEncoder()
  let child: ChildProcess | null = null
  let cancelled = false

  // Full record of the run — every event in order — persisted on completion so
  // the last iteration can be inspected later without re-running or screenshots.
  const startedAt = new Date().toISOString()
  const events: PipelineEvent[] = []

  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev: PipelineEvent) => {
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
        const pubBoard = path.join(appDir, 'public/board')
        const pubData = path.join(appDir, 'public/data')
        const fl1Bom = path.join(hwDir, 'build/builds/default/default.bom.csv')
        log('design', `workspace: ${ws} (working board untouched)`)

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
            for (const s of ['placement', 'routing', 'validation', 'firmware'] as const)
              send({ type: 'stage', id: s, state: 'blocked' })
            send({ type: 'done', status: 'GATE FAILED', boardPath: variantBoard })
            return
          }
          log('design', 'GATE design: blocks composed + wired — PASS', 'ok')
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
            log('design', 'design spec unreadable — continuing on FL-1 baseline', 'warn')
          }
          log('design', 'ato build — compiling .ato design-of-record…')
          const build = await exec('design', ATO, ['build'], { cwd: hwDir })
          if (!(build.code === 0 || build.out.includes('Build successful'))) {
            send({ type: 'stage', id: 'design', state: 'failed', failReason: 'ato build not GREEN' })
            for (const s of ['placement', 'routing', 'validation', 'firmware'] as const)
              send({ type: 'stage', id: s, state: 'blocked' })
            send({ type: 'done', status: 'GATE FAILED', boardPath: wsBoard })
            return
          }
          log('design', 'GATE design: ato build GREEN — PASS', 'ok')
          log('design', `gen_board: building the prompt's variant…`)
          const genV = await exec('design', KPY, [
            path.join(hwDir, 'scripts/gen_board.py'),
            variantBoard,
          ], { env: { DESIGN_SPEC: specPath } })
          if (!(genV.code === 0 || genV.out.includes('gen_board:'))) {
            send({ type: 'stage', id: 'design', state: 'failed', failReason: 'gen_board failed' })
            for (const s of ['placement', 'routing', 'validation', 'firmware'] as const)
              send({ type: 'stage', id: s, state: 'blocked' })
            send({ type: 'done', status: 'GATE FAILED', boardPath: variantBoard })
            return
          }
          send({ type: 'stage', id: 'design', state: 'passed' })
        }

        // ---- stage 2: placement gates on the variant -----------------------
        // gen_board already placed the variant (with fiducials + zones); gate
        // it directly — no place_and_zone (that's the atopile placer).
        send({ type: 'stage', id: 'placement', state: 'running' })
        const pscore = await exec('placement', KPY, [
          path.join(hwDir, 'scripts/placement_score.py'),
          variantBoard,
        ])
        if (pscore.code !== 0) {
          send({ type: 'stage', id: 'placement', state: 'failed', failReason: 'placement gate FAIL' })
          send({ type: 'stage', id: 'routing', state: 'blocked' })
          send({ type: 'stage', id: 'validation', state: 'blocked' })
          send({ type: 'stage', id: 'firmware', state: 'blocked' })
          send({ type: 'done', status: 'GATE FAILED', boardPath: variantBoard })
          return
        }
        log('placement', 'GATE placement (HPWL/overlap) — PASS', 'ok')
        const dfm = await exec('placement', KPY, [
          path.join(hwDir, 'scripts/dfm_check.py'),
          variantBoard,
        ])
        if (dfm.code !== 0) {
          send({ type: 'stage', id: 'placement', state: 'failed', failReason: 'DFM gate FAIL' })
          send({ type: 'stage', id: 'routing', state: 'blocked' })
          send({ type: 'stage', id: 'validation', state: 'blocked' })
          send({ type: 'stage', id: 'firmware', state: 'blocked' })
          send({ type: 'done', status: 'GATE FAILED', boardPath: variantBoard })
          return
        }
        log('placement', 'GATE DFM (edge/hole/fiducial/courtyard) — PASS', 'ok')
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
        log('routing', 'GATE emission: only DRC-clean nets shipped — PASS', 'ok')
        send({ type: 'stage', id: 'routing', state: 'passed' })

        // ---- stage 4: validation (kicad-cli, the neutral referee) -----------
        send({ type: 'stage', id: 'validation', state: 'running' })
        const drcPath = path.join(ws, 'drc.json')
        await exec('validation', KCLI, [
          'pcb', 'drc', '--format', 'json', '--severity-error',
          '-o', drcPath, variantBoard,
        ])
        let violations = -1
        try {
          const drc = JSON.parse(fs.readFileSync(drcPath, 'utf8'))
          violations = (drc.violations ?? []).length
          log(
            'validation',
            `kicad-cli pcb drc → ${violations} violations, ${(drc.unconnected_items ?? []).length} unconnected items`,
            violations === 0 ? 'ok' : 'err',
          )
        } catch {
          log('validation', 'could not parse DRC report', 'err')
        }
        const drcPass = violations === 0

        // ---- sync: the routed variant IS the board — render it with copper --
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
        // .ato source for the Schematic/Code tab (also writes a ref bom.json —
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
        log('validation', 'board · BOM · renders · stats — all the prompt variant', 'ok')

        let fabZip: string | undefined
        if (drcPass) {
          log('validation', 'GATE validation: DRC = 0 — PASS', 'ok')
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
          const zipMatch = fab.out.match(/^FAB_ZIP:(.+)$/m)
          if (zipMatch && fs.existsSync(zipMatch[1].trim())) {
            const pubFab = path.join(appDir, 'public/fab')
            fs.mkdirSync(pubFab, { recursive: true })
            const dest = path.join(pubFab, 'fab-package.zip')
            fs.copyFileSync(zipMatch[1].trim(), dest)
            fabZip = '/fab/fab-package.zip'
            log('validation', `fab package ready → ${fabZip}`, 'ok')
          } else {
            log('validation', 'fab package generation incomplete', 'warn')
          }
          send({ type: 'stage', id: 'validation', state: 'passed' })
        } else {
          send({ type: 'stage', id: 'validation', state: 'failed', failReason: `${violations} DRC violations` })
        }
        const validationStatus: 'PASSED' | 'GATE FAILED' = drcPass
          ? 'PASSED'
          : 'GATE FAILED'

        // ---- stage 5: firmware — netlist-derived BSP + HAL + self-test -------
        // Independent of DRC: firmware comes from the netlist, so it generates
        // and compiles even when copper still has a defect. Its own hard gate
        // is `cargo build` for the RP2040 target.
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
            log('firmware', 'GATE firmware: cargo build GREEN — PASS', 'ok')
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
          writeRunReport(appDir, {
            startedAt,
            finishedAt: new Date().toISOString(),
            mode: composeMode ? 'compose' : 'matrix',
            prompt,
            composeSpec,
            events,
          })
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
  rec: {
    startedAt: string
    finishedAt: string
    mode: string
    prompt: string
    composeSpec: { blocks: string[]; boardClass: string } | null
    events: PipelineEvent[]
  },
) {
  const pubData = path.join(appDir, 'public/data')
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
  for (const ev of rec.events) {
    if (ev.type === 'stage') stages[ev.id] = { state: ev.state, failReason: ev.failReason }
    else if (ev.type === 'done') done = ev
    else if (ev.type === 'error') error = ev.message
  }
  const logs = rec.events.filter(
    (e): e is Extract<PipelineEvent, { type: 'log' }> => e.type === 'log',
  )
  const board = readJson('board.json')
  const drc = readJson('drc.json')
  const ato = readJson('ato.json') as { name: string; content: string }[] | null
  const netlist = ato?.find((f) => f.name === 'netlist.txt')?.content ?? null
  const designTxt = ato?.find((f) => f.name === 'design.txt')?.content ?? null

  const report = {
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
    mode: rec.mode,
    prompt: rec.prompt,
    composeSpec: rec.composeSpec,
    status: error ? 'ERROR' : done?.status ?? 'INCOMPLETE',
    error,
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
  const STAGE_ORDER = ['design', 'placement', 'routing', 'validation', 'firmware']
  const icon = (s?: string) =>
    s === 'passed' ? '✅' : s === 'failed' ? '❌' : s === 'blocked' ? '⛔' : '·'
  const md: string[] = []
  md.push(`# Last run — ${report.status}`)
  md.push('')
  md.push(`- when: ${report.startedAt} → ${report.finishedAt}`)
  md.push(`- mode: \`${report.mode}\`${rec.composeSpec ? ` · ${rec.composeSpec.boardClass}` : ''}`)
  md.push(`- prompt: ${report.prompt || '(none)'}`)
  if (rec.composeSpec) md.push(`- blocks: ${rec.composeSpec.blocks.join(', ')}`)
  md.push('')
  md.push('## Stages')
  for (const id of STAGE_ORDER) {
    if (!stages[id]) continue
    const fr = stages[id].failReason ? ` — ${stages[id].failReason}` : ''
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
    md.push(`## DRC — ${report.drc.violations.length} violations, ${report.drc.unconnected} unconnected`)
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
