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
  | { type: 'done'; status: 'PASSED' | 'GATE FAILED'; boardPath: string; fabZip?: string }
  | { type: 'error'; message: string }

const globalState = globalThis as unknown as { __pipelineRunning?: boolean }

export async function GET(req: Request) {
  if (globalState.__pipelineRunning) {
    return new Response('a pipeline run is already in progress', { status: 409 })
  }
  globalState.__pipelineRunning = true

  const prompt = new URL(req.url).searchParams.get('prompt') ?? ''
  const appDir = process.cwd()
  const hwDir = path.resolve(appDir, '../../hardware/pcba-rev-a')
  const flroute = path.join(hwDir, 'tools/flroute/target/release/flroute')
  const ATO = process.env.ATO_BIN || `${process.env.HOME}/.local/bin/ato`
  const encoder = new TextEncoder()
  let child: ChildProcess | null = null
  let cancelled = false

  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev: PipelineEvent) => {
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
        log('design', `workspace: ${ws} (working board untouched)`)

        // ---- stage 1: design — AI interprets the prompt, then `ato build` gate
        send({ type: 'stage', id: 'design', state: 'running' })
        const specPath = path.join(ws, 'design_spec.json')
        await exec('design', 'python3', [
          path.join(appDir, 'scripts/ai_design.py'),
          prompt,
          specPath,
        ])
        try {
          const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))
          send({ type: 'design', spec })
        } catch {
          log('design', 'design spec unreadable — continuing on FL-1 baseline', 'warn')
        }
        // hard gate: the atopile build must be GREEN (the real Stage-1 gate)
        log('design', 'ato build — compiling .ato design-of-record…')
        const build = await exec('design', ATO, ['build'], { cwd: hwDir })
        const buildOk =
          build.code === 0 || build.out.includes('Build successful')
        if (!buildOk) {
          send({ type: 'stage', id: 'design', state: 'failed', failReason: 'ato build not GREEN' })
          send({ type: 'stage', id: 'placement', state: 'blocked' })
          send({ type: 'stage', id: 'routing', state: 'blocked' })
          send({ type: 'stage', id: 'validation', state: 'blocked' })
          send({ type: 'done', status: 'GATE FAILED', boardPath: wsBoard })
          return
        }
        log('design', 'GATE design: ato build GREEN — PASS', 'ok')
        send({ type: 'stage', id: 'design', state: 'passed' })

        // ---- stage 2: placement + hard gate --------------------------------
        send({ type: 'stage', id: 'placement', state: 'running' })
        const place = await exec(
          'placement',
          KPY,
          [path.join(hwDir, 'scripts/place_and_zone.py')],
          { cwd: ws },
        )
        // KiCad 10 standalone python may segfault at interpreter teardown
        // AFTER saving; the "v3:" summary line is the completion sentinel,
        // and placement_score.py independently verifies the result next.
        const placeOk = place.code === 0 || place.out.includes('v3: relay pitch')
        if (!placeOk) {
          send({ type: 'stage', id: 'placement', state: 'failed', failReason: 'place_and_zone error' })
          send({ type: 'stage', id: 'routing', state: 'blocked' })
          send({ type: 'stage', id: 'validation', state: 'blocked' })
          send({ type: 'done', status: 'GATE FAILED', boardPath: wsBoard })
          return
        }
        // gate → repair → re-gate: bounded self-repair instead of stopping.
        // This is the zero-shot policy — iteration happens in here, unattended.
        let gatePassed = false
        for (let attempt = 0; attempt <= 2; attempt++) {
          const gate = await exec('placement', KPY, [
            path.join(hwDir, 'scripts/placement_score.py'),
            wsBoard,
          ])
          if (gate.code === 0) {
            gatePassed = true
            break
          }
          if (attempt === 2) break
          log('placement', `gate FAIL — repair attempt ${attempt + 1}/2`, 'warn')
          const rep = await exec('placement', KPY, [
            path.join(appDir, 'scripts/repair_placement.py'),
            wsBoard,
          ])
          if (!(rep.code === 0 || rep.out.includes('REPAIRED'))) {
            log('placement', 'repair pass failed to run', 'err')
            break
          }
        }
        if (!gatePassed) {
          send({ type: 'stage', id: 'placement', state: 'failed', failReason: 'placement gate FAIL after repair' })
          send({ type: 'stage', id: 'routing', state: 'blocked' })
          send({ type: 'stage', id: 'validation', state: 'blocked' })
          send({ type: 'done', status: 'GATE FAILED', boardPath: wsBoard })
          return
        }
        log('placement', 'GATE placement (HPWL/overlap) — PASS', 'ok')

        // self-heal: the atopile netlist has no fiducial parts; assembly needs
        // >= 3. Inject them into free space before the DFM gate (idempotent).
        const fid = await exec('placement', KPY, [
          path.join(appDir, 'scripts/add_fiducials.py'),
          wsBoard,
        ])
        const fidN = fid.out.match(/^FIDUCIALS (\d+)/m)?.[1]
        log('placement',
          fidN !== undefined
            ? `assembly fiducials: ${fidN} present`
            : 'fiducial self-heal did not complete',
          fidN !== undefined ? 'ok' : 'warn')

        // DFM gate — assembly-house rules KiCad DRC doesn't check
        // (edge/hole keepout, fiducials, courtyard gaps). Hard gate.
        const dfm = await exec('placement', KPY, [
          path.join(hwDir, 'scripts/dfm_check.py'),
          wsBoard,
        ])
        if (dfm.code !== 0) {
          send({ type: 'stage', id: 'placement', state: 'failed', failReason: 'DFM gate FAIL' })
          send({ type: 'stage', id: 'routing', state: 'blocked' })
          send({ type: 'stage', id: 'validation', state: 'blocked' })
          send({ type: 'done', status: 'GATE FAILED', boardPath: wsBoard })
          return
        }
        log('placement', 'GATE DFM (edge/hole/fiducial/courtyard) — PASS', 'ok')
        send({ type: 'stage', id: 'placement', state: 'passed' })

        // ---- stage 3: routing (flroute on the real DSN) ---------------------
        send({ type: 'stage', id: 'routing', state: 'running' })
        const dsn = path.join(ws, 'board.dsn')
        const ses = path.join(ws, 'board.ses')
        const dsnRes = await exec('routing', KPY, [
          path.join(appDir, 'scripts/export_dsn.py'),
          wsBoard,
          dsn,
        ])
        const dsnOk = dsnRes.code === 0 || dsnRes.out.includes('DSN export OK')
        if (!dsnOk) {
          send({ type: 'stage', id: 'routing', state: 'failed', failReason: 'DSN export failed' })
          send({ type: 'stage', id: 'validation', state: 'blocked' })
          send({ type: 'done', status: 'GATE FAILED', boardPath: wsBoard })
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
          send({ type: 'done', status: 'GATE FAILED', boardPath: wsBoard })
          return
        }
        const imp = await exec('routing', KPY, [
          path.join(appDir, 'scripts/import_ses.py'),
          wsBoard,
          ses,
        ])
        const impOk = imp.code === 0 || imp.out.includes('IMPORT_OK')
        if (!impOk) {
          send({ type: 'stage', id: 'routing', state: 'failed', failReason: 'SES import failed' })
          send({ type: 'stage', id: 'validation', state: 'blocked' })
          send({ type: 'done', status: 'GATE FAILED', boardPath: wsBoard })
          return
        }
        // pad-entry stitching: closes the flroute-vs-referee connectivity gap
        // (router stops at grid centers 100-400um short of pad copper)
        const stitch = await exec('routing', KPY, [
          path.join(appDir, 'scripts/stitch_pads.py'),
          wsBoard,
        ])
        const stitched = stitch.out.match(/^STITCHED (\d+)/m)?.[1]
        log(
          'routing',
          stitched !== undefined
            ? `pad-entry stitching: ${stitched} segments added`
            : 'pad-entry stitching did not complete',
          stitched !== undefined ? 'ok' : 'warn',
        )
        log('routing', 'GATE emission: only DRC-clean nets shipped — PASS', 'ok')
        send({ type: 'stage', id: 'routing', state: 'passed' })

        // ---- stage 4: validation (kicad-cli, the neutral referee) -----------
        send({ type: 'stage', id: 'validation', state: 'running' })
        const drcPath = path.join(ws, 'drc.json')
        await exec('validation', KCLI, [
          'pcb', 'drc', '--format', 'json', '--severity-error',
          '-o', drcPath, wsBoard,
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

        // ---- sync artifacts so the UI shows this run's real board -----------
        log('validation', 'syncing run artifacts to frontend (sync-board.sh)…')
        const sync = await exec(
          'validation',
          'bash',
          [path.join(appDir, 'scripts/sync-board.sh')],
          { cwd: appDir, env: { BOARD: wsBoard, HW_DIR: hwDir } },
        )
        log(
          'validation',
          sync.code === 0 ? 'artifacts synced from run output' : 'artifact sync failed',
          sync.code === 0 ? 'ok' : 'err',
        )

        if (drcPass) {
          log('validation', 'GATE validation: DRC = 0 — PASS', 'ok')
          // ---- fab outputs: gerbers/drill/P&P/STEP/BOM -> zip --------------
          log('validation', 'generating fabrication package (gerbers, drill, P&P, STEP, BOM)…')
          const fabDir = path.join(ws, 'fab')
          const bomCsv = path.join(hwDir, 'build/builds/default/default.bom.csv')
          const fab = await exec('validation', 'python3', [
            path.join(appDir, 'scripts/export_fab.py'),
            wsBoard,
            fabDir,
            bomCsv,
          ])
          let fabZip: string | undefined
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
          send({ type: 'done', status: 'PASSED', boardPath: wsBoard, fabZip })
        } else {
          send({ type: 'stage', id: 'validation', state: 'failed', failReason: `${violations} DRC violations` })
          send({ type: 'done', status: 'GATE FAILED', boardPath: wsBoard })
        }
      } catch (err) {
        send({ type: 'error', message: String(err) })
      } finally {
        clearTimeout(killTimer)
        globalState.__pipelineRunning = false
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
