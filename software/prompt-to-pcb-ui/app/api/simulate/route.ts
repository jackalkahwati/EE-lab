/**
 * Simulation module — runs the applicable lumped-physics simulations (open
 * source: numpy + scipy) for the product and returns real results with honest
 * fidelity + which tool produced each. Inputs are drawn from the product spec,
 * the real built board, and (optionally) the optimizer's selected design.
 *
 * Generic: the sim runner picks whichever sims its inputs support; it never
 * fabricates a metric it can't compute. High-fidelity FEA/FDTD (Elmer /
 * CalculiX / openEMS / OpenFOAM) is the install-gated upgrade, not faked here.
 */
import path from 'node:path'
import { spawn } from 'node:child_process'
import { loadGroundBoard } from '@/lib/ground-board'
import type { ProductSpec } from '@/lib/product-spec'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const RUN_ID = /^run-[A-Za-z0-9._-]{1,128}$/

function runSim(req: Record<string, unknown>): Promise<any> {
  const script = path.join(process.cwd(), '..', '..', 'tools', 'sim', 'run_sim.py')
  return new Promise((resolve, reject) => {
    const py = spawn('python3', [script], { timeout: 100_000 })
    let out = '', err = ''
    py.stdout.on('data', (d) => (out += d))
    py.stderr.on('data', (d) => (err += d))
    py.on('error', reject)
    py.on('close', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop() || '{}')) }
      catch { reject(new Error('sim runner produced no JSON: ' + (err || out).slice(0, 300))) }
    })
    py.stdin.write(JSON.stringify(req))
    py.stdin.end()
  })
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const spec = body.spec as ProductSpec | undefined
    const runId = typeof body.runId === 'string' ? body.runId : undefined
    const design = (body.design ?? {}) as Record<string, number | string>
    if (!spec?.product) return Response.json({ error: 'missing product spec' }, { status: 400 })

    let boardAreaMm2: number | undefined
    if (runId && RUN_ID.test(runId)) {
      // prefer the chip-scale board so thermal/RF/etc. use the real product area
      const gb = await loadGroundBoard(runId)
      if (gb) boardAreaMm2 = gb.wMm * gb.hMm
    }

    const p = spec.budgets?.power ?? {}
    const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : undefined)
    // design (optimizer's selected candidate) overrides spec budgets where present
    const simReq: Record<string, unknown> = {
      activeMw: num(design.activeMw) ?? p.activeMw,
      batteryMah: num(design.batteryMah) ?? p.batteryMah,
      boardAreaMm2: num(design.boardAreaMm2) ?? boardAreaMm2,
      massG: num(design.massG) ?? spec.budgets?.massG,
      envelopeMm: spec.budgets?.sizeMm,
      enclosureMaterial: design.enclosureMaterial,
      antennaPlacement: design.antennaPlacement,
      runtimeTargetHours: p.runtimeHours,
    }

    const out = await runSim(simReq)
    return Response.json({ scipy: !!out.scipy, results: out.results ?? [], inputs: simReq })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 })
  }
}
