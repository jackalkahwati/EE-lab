/**
 * Incremental repair / re-validation of a SINGLE run, without re-running the
 * whole pipeline. Loads that run's persisted variant.kicad_pcb (written by the
 * run route), applies ONE targeted fix, refills zones, re-runs DRC, and rewrites
 * the run's own artifacts (board.json / bom.json / drc.json / renders). Touches
 * only public/runs/<id>/, never the shared reference or any other run.
 *
 * POST { runId, op }
 *   op = 'revalidate' | 'clearance' | 'placement' | 'stitch' | 'stitch-plane' | 'reroute' | 'diagnose'
 * Returns { ok, op, before, after, status, log } (diagnose returns { diagnosis }).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const dynamic = 'force-dynamic'
export const maxDuration = 600

const KCLI = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
const KPY =
  '/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3'

const OPS = [
  'revalidate',
  'clearance',
  'placement',
  'stitch',
  'stitch-plane',
  'reroute',
  'diagnose',
] as const
type Op = (typeof OPS)[number]

const globalState = globalThis as unknown as { __pipelineRunning?: boolean }

/** spawn a step, collect output, resolve {code,out}. KiCad swig scripts may
 *  segfault at teardown AFTER a clean save, so we never fail on exit code , 
 *  success is judged by the re-DRC delta, not the process code. */
function sh(cmd: string, args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(cmd, args, { cwd })
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()))
    child.stderr?.on('data', (c: Buffer) => (out += c.toString()))
    child.on('error', (e) => resolve({ code: -1, out: out + `\nspawn failed: ${e.message}` }))
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
}

export async function POST(req: Request) {
  // Repairs re-run KiCad/Python locally, lab workstation only.
  if (!fs.existsSync(KCLI)) {
    return Response.json(
      { error: 'Repair operations run on the FirstLight lab workstation and are not available in this preview deployment.' },
      { status: 503 },
    )
  }
  let body: { runId?: string; op?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const id = String(body.runId ?? '').replace(/[^a-zA-Z0-9_-]/g, '')
  const op = body.op as Op
  if (!id || !OPS.includes(op))
    return Response.json({ error: 'runId and a valid op are required' }, { status: 400 })

  if (globalState.__pipelineRunning)
    return Response.json({ error: 'a pipeline run or repair is already in progress' }, { status: 409 })
  globalState.__pipelineRunning = true

  const log: string[] = []
  try {
    const appDir = process.cwd()
    const hwDir = path.resolve(appDir, '../../hardware/pcba-rev-a')
    const fl1Bom = path.join(hwDir, 'build/builds/default/default.bom.csv')
    const runRoot = path.join(appDir, 'public/runs', id)
    const board = path.join(runRoot, 'variant.kicad_pcb')
    const pubData = path.join(runRoot, 'data')
    const pubBoard = path.join(runRoot, 'board')
    const drcPath = path.join(pubData, 'drc.json')
    const script = (name: string) => path.join(appDir, 'scripts', name)

    if (!fs.existsSync(board))
      return Response.json(
        {
          error:
            'no editable board for this run, it predates board persistence. Re-run it once to enable repair.',
        },
        { status: 404 },
      )

    const readDrc = () => {
      try {
        const d = JSON.parse(fs.readFileSync(drcPath, 'utf8'))
        const all = d.violations ?? []
        return {
          violations: all.filter((v: { type: string }) => v.type !== 'solder_mask_bridge').length,
          unconnected: (d.unconnected_items ?? []).length,
        }
      } catch {
        return { violations: -1, unconnected: -1 }
      }
    }
    const before = readDrc()

    // ---- diagnose: read-only. Pinpoint the gap on each open net. ----
    if (op === 'diagnose') {
      let nets: string[] = []
      try {
        const bj = JSON.parse(fs.readFileSync(path.join(pubData, 'board.json'), 'utf8'))
        nets = Array.isArray(bj.unroutedNets) ? bj.unroutedNets : []
      } catch {
        /* no board.json, leave nets empty */
      }
      if (nets.length === 0)
        return Response.json({ ok: true, op, before, diagnosis: 'No open nets to diagnose.', log })
      const r = await sh(KPY, [script('probe_open_nets.py'), board, ...nets])
      return Response.json({ ok: true, op, before, nets, diagnosis: r.out, log })
    }

    // ---- targeted repair: modify the board in place ----
    // (repairs that read DRC use the run's CURRENT drc.json = the before state)
    if (op === 'clearance') {
      log.push('repair_clearance: shoving off-grid copper out of clearance…')
      await sh(KPY, [script('repair_clearance.py'), board, drcPath])
    } else if (op === 'placement') {
      log.push('repair_placement: nudging keepout-violating parts toward center…')
      await sh(KPY, [script('repair_placement.py'), board])
    } else if (op === 'stitch') {
      log.push('stitch_pads: closing pad-entry gaps on near-miss endpoints…')
      await sh(KPY, [script('stitch_pads.py'), board])
    } else if (op === 'stitch-plane') {
      log.push('stitch_to_plane: dropping a via from each isolated power/gnd pad into its plane…')
      const r = await sh(KPY, [script('stitch_to_plane.py'), board, drcPath])
      const m = r.out.match(/STITCHED (\d+)/)
      if (m) log.push(`placed ${m[1]} plane via(s)`)
      log.push('stitch_islands: via-stitching isolated pour islands to their plane…')
      const ri = await sh(KPY, [script('stitch_islands.py'), board])
      const mi = ri.out.match(/STITCHED_ISLANDS (\d+)/)
      if (mi) log.push(`placed ${mi[1]} island via(s)`)
    } else if (op === 'reroute') {
      log.push('local_reroute: ripping & re-routing open nets on a fine grid (with vias)…')
      await sh(KPY, [script('local_reroute.py'), board, drcPath])
    } else {
      log.push('revalidate: re-running DRC on the current board (no changes)…')
    }

    // ---- refill zones so connectivity reflects any new copper, then re-DRC ----
    await sh(KPY, [script('fill_zones.py'), board])
    await sh(KCLI, ['pcb', 'drc', '--format', 'json', '--severity-error', '-o', drcPath, board])

    // ---- regenerate the run's artifacts from the (possibly repaired) board ----
    const vStats = path.join(runRoot, 'variant_board.json')
    await sh(KPY, [script('extract_stats.py'), board, drcPath, vStats])
    for (const side of ['top', 'bottom']) {
      await sh(KCLI, [
        'pcb', 'render', '--side', side, '--background', 'opaque',
        '--quality', 'basic', '--width', '1200', '--height', '1050',
        '-o', path.join(pubBoard, `render-${side}.png`), board,
      ])
    }
    for (const layer of ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu', 'Edge.Cuts', 'F.SilkS']) {
      await sh(KCLI, [
        'pcb', 'export', 'svg', '--mode-single', '--page-size-mode', '2',
        '--exclude-drawing-sheet', '--black-and-white', '--negative',
        '-l', layer, '-o', path.join(pubBoard, `${layer}.svg`), board,
      ])
    }
    await sh(KPY, [
      script('variant_sync.py'), board, fl1Bom, pubData, '--routing-json', vStats,
    ])

    // stamp the run id into the refreshed board.json (self-identifying artifact)
    try {
      const bjp = path.join(pubData, 'board.json')
      const bj = JSON.parse(fs.readFileSync(bjp, 'utf8'))
      bj.runId = id
      fs.writeFileSync(bjp, JSON.stringify(bj, null, 1))
    } catch {
      /* stamp best-effort */
    }

    const after = readDrc()
    let status = after.violations === 0 && after.unconnected === 0 ? 'PASSED' : 'GATE FAILED'

    // a repair that turns the board clean must update the run's RECORD too , 
    // otherwise last-run.json keeps reporting the pre-repair failure forever.
    // ERC was blocked when validation failed, so run it for real now.
    if (status === 'PASSED') {
      const erc = await sh(KPY, [script('erc_check.py'), board])
      const ercOk = erc.code === 0 || /ERC[ _]?OK|0 errors/i.test(erc.out)
      if (!ercOk) {
        status = 'GATE FAILED'
        log.push('ERC still failing after repair, run stays GATE FAILED')
      }
      try {
        const lrPath = path.join(runRoot, 'data/last-run.json')
        const lr = JSON.parse(fs.readFileSync(lrPath, 'utf8'))
        lr.status = status
        lr.repairedAt = new Date().toISOString()
        lr.stages = lr.stages ?? {}
        lr.stages.validation = { state: status === 'PASSED' ? 'passed' : 'failed' }
        lr.stages.erc = { state: ercOk ? 'passed' : 'failed' }
        if (status === 'PASSED' && lr.stages.firmware?.state === 'blocked') {
          // firmware never ran for this board, leave it blocked, but that's
          // not a gate failure once electrical checks pass
          lr.stages.firmware = { state: 'blocked' }
        }
        fs.writeFileSync(lrPath, JSON.stringify(lr, null, 2))
        log.push(`run report updated → ${status} (validation ${lr.stages.validation.state}, erc ${lr.stages.erc.state})`)
      } catch {
        log.push('could not update last-run.json (report may show stale status)')
      }
    }
    log.push(
      `done: violations ${before.violations}→${after.violations}, ` +
        `unconnected ${before.unconnected}→${after.unconnected}, ${status}`,
    )
    return Response.json({ ok: true, op, before, after, status, log })
  } catch (err) {
    return Response.json({ error: String(err), log }, { status: 500 })
  } finally {
    globalState.__pipelineRunning = false
  }
}
