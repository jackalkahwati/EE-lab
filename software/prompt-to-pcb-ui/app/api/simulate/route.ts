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
 *  - pdn:     REAL SPICE (ngspice) — AC impedance sweep of the rail decoupling
 *    network built from the run's netlist + power budget.
 *  - cfd thermal: REAL CFD (OpenFOAM buoyantBoussinesqSimpleFoam) — natural
 *    convection around the device; computes the h the 2D FEM assumes.
 *  - cavity acoustic FEM: REAL Elmer wave-equation eigenanalysis of the
 *    enclosure air cavity (upgrades the sealed-box estimate).
 *  - rf: still a link-budget surrogate — antenna FDTD (openEMS) is the
 *    install-gated next-fidelity upgrade.
 * The runner never fabricates a metric it can't compute; each result carries its
 * own tool + fidelity, so the panel shows exactly how each number was produced.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { loadGroundBoard } from '@/lib/ground-board'
import { isAdminRequest, runAccess } from '@/lib/auth'
import type { ProductSpec } from '@/lib/product-spec'
import { planSimulations, judge } from '@/lib/sim-router'
import { withKeepalive } from '@/lib/keepalive'

export const dynamic = 'force-dynamic'
// High-fidelity solvers (OpenFOAM CFD, docker-hosted Elmer/openEMS) run
// concurrently inside run_sim.py but the slowest can take ~2 min cold.
export const maxDuration = 300

const RUN_ID = /^run-[A-Za-z0-9._-]{1,128}$/

function runSim(req: Record<string, unknown>): Promise<any> {
  const script = path.join(process.cwd(), '..', '..', 'tools', 'sim', 'run_sim.py')
  return new Promise((resolve, reject) => {
    const py = spawn(process.env.FL_PYTHON || 'python3', [script], { timeout: 280_000 })
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

/**
 * Long POSTs die at Cloudflare's ~100s no-bytes limit; this route can run for
 * minutes. withKeepalive returns fast responses untouched and only streams
 * filler when the handler is still working. See lib/keepalive.ts.
 */
export async function POST(req: Request): Promise<Response> {
  return withKeepalive(handlePost(req))
}

async function handlePost(req: Request) {
  try {
    const body = await req.json()
    const spec = body.spec as ProductSpec | undefined
    const runId = typeof body.runId === 'string' ? body.runId : undefined
    const design = (body.design ?? {}) as Record<string, number | string>
    if (!spec?.product) return Response.json({ error: 'missing product spec' }, { status: 400 })
    // Ownership: with a runId the route writes disciplines/simulation.json (and
    // sim artifacts) under public/runs/<runId>/ — owner or admin only.
    if (runId !== undefined) {
      if (!RUN_ID.test(runId)) return Response.json({ error: 'invalid runId' }, { status: 400 })
      const access = runAccess(req, runId)
      if (access.access === 'unauthenticated') return Response.json({ error: 'sign in required' }, { status: 401 })
      if (access.access !== 'owner' && !isAdminRequest(req)) {
        return Response.json({ error: 'run belongs to another account' }, { status: 403 })
      }
    }

    let boardAreaMm2: number | undefined
    let boardMm: { w: number; h: number } | undefined
    let layerCount: number | undefined
    let enclosureStep: string | undefined
    let pdn: Record<string, unknown> | undefined
    // the run's power-budget.json, passed whole so the thermal solver can derive
    // ON-BOARD dissipation from rail currents (not the product's activeMw budget)
    let powerBudget: Record<string, unknown> | undefined
    let autoAntenna: string | undefined
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
      // PDN inputs for the REAL ngspice rail-impedance sweep: per-rail load
      // currents from the run's power budget + the decoupling caps the
      // netlist actually places on each rail. Absent artifacts → the pdn sim
      // skips itself; it never invents a network.
      try {
        const dataDir = path.join(process.cwd(), 'public', 'runs', runId, 'data')
        const pb = JSON.parse(await fs.readFile(path.join(dataDir, 'power-budget.json'), 'utf8'))
        if (pb && typeof pb === 'object') powerBudget = pb
        const rails = Object.entries(pb?.rails ?? {}).map(([name, r]) => ({
          name,
          worstMa: typeof (r as any)?.worst_ma === 'number' ? (r as any).worst_ma : 0,
        }))
        // Fall back to the inlet budget for the input rail when its per-rail
        // loads list is empty (the 5 V inlet current is still real demand).
        const inlet = pb?.inlet_5v?.worst_ma
        for (const r of rails)
          if (r.worstMa === 0 && /5/.test(r.name) && typeof inlet === 'number') r.worstMa = inlet
        const ato = JSON.parse(await fs.readFile(path.join(dataDir, 'ato.json'), 'utf8'))
        const net: unknown = Array.isArray(ato)
          ? ato.find((f: any) => f?.name === 'netlist.txt')?.content
          : undefined
        const railCaps: { rail: string; ref: string }[] = []
        if (typeof net === 'string') {
          for (const line of net.split('\n')) {
            const m = line.match(/^(\S+)\s+(.+)$/)
            if (!m || !rails.some((r) => r.name === m[1])) continue
            for (const pin of m[2].split(',')) {
              const cm = pin.trim().match(/^(C\d+)\./)
              if (cm) railCaps.push({ rail: m[1], ref: cm[1] })
            }
          }
        }
        if (rails.length) pdn = { rails, railCaps }
      } catch { /* run has no power budget / netlist artifacts */ }
      // Radio products always engage the antenna-FDTD gate: when the design
      // didn't declare an antenna placement, derive one from the run's device
      // manifest (ESP32-C3 / LoRa / any device carrying a radio). The board
      // is the module antenna's counterpoise either way — that's exactly what
      // the FDTD pass grades.
      try {
        const devs = JSON.parse(await fs.readFile(
          path.join(process.cwd(), 'public', 'runs', runId, 'data', 'devices.json'), 'utf8',
        )) as Record<string, unknown>[]
        const radio = devs.find((d) =>
          typeof d.radio === 'string' || d.type === 'radio' ||
          (d.type === 'mcu' && d.family === 'esp32c3'))
        if (radio) {
          autoAntenna = `${radio.name ?? radio.type} module antenna at board edge (auto-declared from device manifest)`
        }
      } catch { /* no device manifest for this run */ }
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
      antennaPlacement: design.antennaPlacement ?? autoAntenna,
      runtimeTargetHours: p.runtimeHours,
      sleepUw, dutyCycle, dutyCycleAssumed,
      enclosureStep,
      pdn,
    }

    // Router: decide WHICH analyses this application requires (planned BEFORE the
    // solve so the thermal solver gets the application's junction rating as its
    // limitC), then judge each solver result against that requirement.
    // Availability of a result is not the same as meeting the requirement, and a
    // REQUIRED analysis that did not run is a surfaced gap — never a silent pass.
    const plan = planSimulations(spec, {
      hasEnclosure: !!enclosureStep,
      hasRadio: !!autoAntenna,
      rails: Array.isArray((pdn as any)?.rails) ? (pdn as any).rails.length : 0,
      hasBattery: !!(spec.budgets?.power?.batteryMah),
      isAudio: /audio|speaker|headphone|earbud|hearable|microphone/i.test(
        `${spec.product} ${spec.description ?? ''}`),
    })
    // thermal pass/fail limit = the reliability class's junction rating (lib/sim-judge.ts);
    // the solver's own default is 85. The 43°C skin figure is never the solver limit.
    simReq.limitC = plan.environment.ratingC ?? 85
    simReq.powerBudget = powerBudget

    const out = await runSim(simReq)
    const results = out.results ?? []
    const assessment = judge(plan, results)

    const payload = {
      scipy: !!out.scipy,
      // FEM health passthrough: if scikit-fem failed to import or a FEM solve
      // raised (and the runner degraded to lumped/analytic), the UI must see it.
      femAvailable: !!out.femAvailable,
      femErrors: Array.isArray(out.femErrors) ? out.femErrors : [],
      results,
      solvers: out.solvers ?? {},
      inputs: simReq,
      // engineering-intelligence layer: what this product needed + how it did
      plan,
      assessment,
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
