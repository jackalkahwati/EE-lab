/**
 * Simulation module — runs the applicable physics simulations for the product
 * and returns real results with honest fidelity + which tool produced each.
 * Inputs are drawn from the product spec, the real built board, and (optionally)
 * the optimizer's selected design.
 *
 * Fidelity is REAL where a solver is wired, honest where it isn't:
 *  - thermal: real 2D FEM steady-state heat solve (scikit-fem) — spatially
 *    resolved plate + convection, not a lumped node.
 *  - drop:    real Kirchhoff-plate modal FEM (scikit-fem) — the board's
 *    fundamental frequency (shock/flex robustness).
 *  - structural3d / enclosure_fea: REAL 3D FEA (gmsh C3D10 mesh + CalculiX
 *    modal solve) — the board slab and the run's actual Onshape STEP.
 *  - acoustic/rf: still analytic/surrogate — a real acoustic FEM (Elmer) and
 *    antenna FDTD (openEMS) are the install-gated next-fidelity upgrades.
 * The runner never fabricates a metric it can't compute; each result carries its
 * own tool + fidelity, so the panel shows exactly how each number was produced.
 */
import { promises as fs } from 'node:fs'
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
    const py = spawn(process.env.FL_PYTHON || 'python3', [script], { timeout: 100_000 })
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
    let boardMm: { w: number; h: number } | undefined
    let layerCount: number | undefined
    let enclosureStep: string | undefined
    if (runId && RUN_ID.test(runId)) {
      // real Onshape CAD (when the mechanical stage has run) → 3D FEA target
      const stepPath = path.join(process.cwd(), 'public', 'runs', runId, 'mechanical', 'enclosure.step')
      try { await fs.access(stepPath); enclosureStep = stepPath } catch { /* no enclosure yet */ }
      // prefer the chip-scale board so thermal/RF/etc. use the real product area,
      // the REAL w×h (no squaring), and the real layer count when known.
      const gb = await loadGroundBoard(runId)
      if (gb) {
        boardAreaMm2 = gb.wMm * gb.hMm
        boardMm = { w: gb.wMm, h: gb.hMm }
        if (typeof gb.layers === 'number' && isFinite(gb.layers) && gb.layers > 0)
          layerCount = gb.layers
      }
    }

    const p = spec.budgets?.power ?? {}
    const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : undefined)
    // A specified sleep power implies a duty-cycled sensor/wearable — default to a
    // small realistic active fraction so runtime reflects average (not peak) draw.
    // Prefer an explicit dutyCycle from the design/spec over this default. When the
    // default IS injected, flag it (dutyCycleAssumed) so the runner labels the
    // runtime result as resting on an assumption, not a spec value.
    const DEFAULT_DUTY = 0.02
    const sleepUw = num(design.sleepUw) ?? p.sleepUw
    const specDuty = num(design.dutyCycle) ?? p.dutyCycle
    const dutyCycleAssumed = specDuty == null && sleepUw != null
    const dutyCycle = specDuty ?? (sleepUw != null ? DEFAULT_DUTY : undefined)
    // design (optimizer's selected candidate) overrides spec budgets where present
    const simReq: Record<string, unknown> = {
      activeMw: num(design.activeMw) ?? p.activeMw,
      batteryMah: num(design.batteryMah) ?? p.batteryMah,
      boardAreaMm2: num(design.boardAreaMm2) ?? boardAreaMm2,
      boardMm,
      layerCount,
      massG: num(design.massG) ?? spec.budgets?.massG,
      envelopeMm: spec.budgets?.sizeMm,
      enclosureMaterial: design.enclosureMaterial,
      antennaPlacement: design.antennaPlacement,
      runtimeTargetHours: p.runtimeHours,
      sleepUw, dutyCycle, dutyCycleAssumed,
      enclosureStep,
    }

    const out = await runSim(simReq)
    const payload = {
      scipy: !!out.scipy,
      // FEM health passthrough: if scikit-fem failed to import or a FEM solve
      // raised (and the runner degraded to lumped/analytic), the UI must see it.
      femAvailable: !!out.femAvailable,
      femErrors: Array.isArray(out.femErrors) ? out.femErrors : [],
      results: out.results ?? [],
      solvers: out.solvers ?? {},
      inputs: simReq,
    }

    // Persist so the orchestrated sim result is durable + the tab shows it on
    // reload, and the feedback controller can read the real FAILs (was in-memory).
    if (runId && RUN_ID.test(runId)) {
      try {
        const dir = path.join(process.cwd(), 'public', 'runs', runId, 'disciplines')
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, 'simulation.json'), JSON.stringify(payload))
      } catch { /* best effort */ }
    }

    return Response.json(payload)
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
