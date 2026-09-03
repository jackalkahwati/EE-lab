/**
 * Auto-partition route. When a chip-scale board grew + escalated layers and STILL
 * can't route clean, it's too dense for one board. This runs the planner's
 * auto_partition.py on the run's netlist: it splits the netlist along the
 * analog/digital seam, synthesizes a board-to-board connector, gate-verifies each
 * half, and writes board_a/board_b specs + interconnect.json under the run's
 * partition/ dir. Returns a one-line summary the pipeline surfaces on the
 * electronics stage. Server-only (spawns Python) — the pipeline calls it by fetch
 * exactly like /api/electronics-cs, so run-pipeline.ts stays client-safe.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const maxDuration = 60

export async function POST(req: Request) {
  let runId = ''
  try {
    runId = (await req.json())?.runId
  } catch { /* no body */ }
  if (!runId || !/^run-[A-Za-z0-9._-]{1,128}$/.test(runId)) {
    return Response.json({ error: 'invalid runId' }, { status: 400 })
  }
  const runDir = path.join(process.cwd(), 'public', 'runs', runId)
  const specPath = path.join(runDir, 'data', 'chipscale-spec.json')
  const outDir = path.join(runDir, 'partition')
  if (!fs.existsSync(specPath)) {
    return Response.json({ error: 'no netlist to partition' }, { status: 404 })
  }
  const script = path.join(process.cwd(), '..', '..', 'hardware', 'planner', 'auto_partition.py')

  const out: string = await new Promise((resolve) => {
    let buf = ''
    let py
    try {
      py = spawn(process.env.FL_PYTHON || 'python3', [script, specPath, outDir], { timeout: 40_000 })
    } catch {
      resolve(''); return
    }
    py.stdout.on('data', (d) => (buf += d))
    py.stderr.on('data', (d) => (buf += d))
    py.on('error', () => resolve(''))
    py.on('close', () => resolve(buf))
  })

  const m = out.match(/PARTITION a=(\d+) b=(\d+) cut=(\d+)/)
  if (!m) {
    return Response.json({ error: 'partition did not produce a split', log: out.slice(0, 300) }, { status: 200 })
  }

  // FLEX DECISION: a short, fixed board-to-board link is the rigid-flex sweet spot
  // — one foldable part replacing 2 boards + connectors + cable. Run the decision
  // (fed the product intent for fold/dynamic-flex cues); if it recommends
  // rigid-flex, fuse the split into a single rigid-flex spec. (Deciding + synthesis
  // + gating are done here; fab-ready flex gerbers are the export slice.)
  let intent = ''
  try {
    const ps = JSON.parse(fs.readFileSync(path.join(runDir, 'product-spec.json'), 'utf8'))
    intent = String(ps?.prompt ?? ps?.product ?? ps?.description ?? '')
  } catch { /* no product spec */ }
  const plannerDir = path.join(process.cwd(), '..', '..', 'hardware', 'planner')
  const runPy = (args: string[]) => new Promise<string>((resolve) => {
    let b = ''
    let p
    try { p = spawn(process.env.FL_PYTHON || 'python3', args, { cwd: plannerDir, timeout: 20_000 }) } catch { resolve(''); return }
    p.stdout.on('data', (d) => (b += d))
    p.on('error', () => resolve(''))
    p.on('close', () => resolve(b))
  })
  let flex: Record<string, unknown> = {}
  const dec = await runPy([path.join(plannerDir, 'flex_decision.py'), '--partition', path.join(outDir, 'interconnect.json'), intent])
  const fd = dec.match(/FLEXDECISION (\w+)/)
  if (fd) {
    flex = { process: fd[1], rationale: (dec.split('\n').find((l) => l.trim().startsWith('because:')) || '').replace(/.*because:\s*/, '').trim() }
    if (fd[1] === 'rigid_flex' || fd[1] === 'flex') {
      const rf = await runPy([path.join(plannerDir, 'rigid_flex_synth.py'), outDir, path.join(outDir, 'rigid_flex.chipscale-spec.json')])
      const rm = rf.match(/RIGIDFLEX parts=(\d+) flex_conductors=(\d+)/)
      if (rm) flex.rigidFlex = { spec: 'partition/rigid_flex.chipscale-spec.json', parts: Number(rm[1]), flexConductors: Number(rm[2]) }
    }
  }

  return Response.json({
    split: `2 boards (${m[1]} + ${m[2]} parts, ${m[3]} interconnect nets) → partition/`,
    boardA: 'partition/board_a.chipscale-spec.json',
    boardB: 'partition/board_b.chipscale-spec.json',
    interconnect: 'partition/interconnect.json',
    flex,
  })
}
