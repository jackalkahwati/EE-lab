import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isValidRunId, runAccess } from '@/lib/auth'

/**
 * Serves a binary glTF (GLB) of a run's routed board for the 3D viewer,
 * exporting it from the run's variant.kicad_pcb with kicad-cli on first
 * request and caching it next to the other board artifacts. Served through
 * this route (not statically) so freshly generated files never 404 behind
 * Next's static-file cache.
 */

const exec = promisify(execFile)

const APP = process.cwd()
const KCLI_CANDIDATES = [
  '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli',
  '/opt/homebrew/bin/kicad-cli',
]

// base → the .kicad_pcb that produced that artifact dir
function resolvePcb(base: string): string | null {
  if (base === '/board') {
    // shared seed board (see scripts/sync-board.sh)
    return path.resolve(APP, '../../hardware/pcba-rev-a/elec/layout/rev-a-routed.kicad_pcb')
  }
  const m = base.match(/^\/runs\/([A-Za-z0-9._-]+)\/board$/)
  if (!m) return null
  // Prefer the bespoke chip-scale board (the real chip-down design that was
  // routed) over the flroute reference board, so the 3D view shows the small
  // board that actually goes in the enclosure — not the RP2040 module board.
  const chip = path.join(APP, 'public', 'runs', m[1], 'electronics', 'chipscale.kicad_pcb')
  if (fs.existsSync(chip)) return chip
  return path.join(APP, 'public', 'runs', m[1], 'variant.kicad_pcb')
}

// serialize concurrent exports of the same board
const inFlight = new Map<string, Promise<void>>()

async function ensureGlb(pcb: string, glb: string): Promise<void> {
  try {
    const g = fs.statSync(glb)
    const p = fs.statSync(pcb)
    if (g.mtimeMs >= p.mtimeMs && g.size > 0) return
  } catch {
    /* glb missing, generate */
  }
  const running = inFlight.get(glb)
  if (running) return running
  const kcli = KCLI_CANDIDATES.find((c) => fs.existsSync(c)) ?? 'kicad-cli'
  const job = exec(
    kcli,
    [
      'pcb', 'export', 'glb', '--force', '--subst-models',
      '--include-tracks', '--include-pads', '--include-zones',
      '--include-silkscreen', '--include-soldermask',
      '-o', glb, pcb,
    ],
    { timeout: 180_000 },
  ).then(() => undefined)
  inFlight.set(glb, job)
  try {
    await job
  } finally {
    inFlight.delete(glb)
  }
}

export async function GET(req: Request) {
  const base = new URL(req.url).searchParams.get('base') ?? ''
  const runMatch = base.match(/^\/runs\/([A-Za-z0-9._-]+)\/board$/)
  if (runMatch) {
    if (!isValidRunId(runMatch[1])) {
      return Response.json({ error: 'invalid base' }, { status: 400 })
    }
    const auth = runAccess(req, runMatch[1])
    if (auth.access === 'unauthenticated') {
      return Response.json({ error: 'sign in required' }, { status: 401 })
    }
    if (auth.access === 'forbidden') {
      return Response.json({ error: 'not your board' }, { status: 403 })
    }
  }
  const pcb = resolvePcb(base)
  if (!pcb) return Response.json({ error: 'invalid base' }, { status: 400 })
  if (!fs.existsSync(pcb))
    return Response.json(
      { error: 'no .kicad_pcb kept for this run; 3D model unavailable' },
      { status: 404 },
    )

  // distinct cache file per source board so the chip-scale GLB never collides
  // with a previously-exported flroute GLB
  const glbName = pcb.includes('chipscale') ? 'chipscale.glb' : 'board.glb'
  const glb = path.join(APP, 'public', base.replace(/^\//, ''), glbName)
  try {
    await ensureGlb(pcb, glb)
  } catch (e: any) {
    return Response.json(
      { error: `kicad-cli glb export failed: ${String(e?.message ?? e).slice(0, 400)}` },
      { status: 500 },
    )
  }

  const buf = fs.readFileSync(glb)
  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'model/gltf-binary',
      'Content-Length': String(buf.length),
      'Cache-Control': 'no-store',
    },
  })
}
