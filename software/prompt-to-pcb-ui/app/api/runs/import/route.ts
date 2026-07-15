/**
 * Manual-edit round-trip (Phase 6). POST /api/runs/import?parentRunId=&kind=
 * with the raw file body (kind: 'step' | 'pcb') — an engineer's hand-edited
 * artifact comes BACK into the platform as a revision:
 *
 *   fork the parent → replace the artifact → strip the claims the edit
 *   invalidated → track the revision ("manual edit import").
 *
 * Honesty is the design: an imported STEP nulls the fit check (it was
 * verified against the GENERATED geometry, not this one) and stales the
 * simulation (its hash covers the STEP). An imported .kicad_pcb clears the
 * DRC/routing claims entirely — the board wears no green until re-verified —
 * and downstream stages go stale through the board-identity hash. Nothing
 * regenerates over the human's edit: the affected stage's own artifact is
 * ACCEPTED as-is; only VERIFICATION and DOWNSTREAM work is invalidated.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { runAccess, isValidRunId, recordRun } from '@/lib/auth'
import { forkRun } from '@/lib/run-fork'
import { trackRun } from '@/lib/design-state'

export const dynamic = 'force-dynamic'

const MAX_BYTES = 25 * 1024 * 1024

export async function POST(req: Request) {
  try {
    const url = new URL(req.url)
    const parent = url.searchParams.get('parentRunId') ?? ''
    const kind = url.searchParams.get('kind') ?? ''
    if (!isValidRunId(parent) || !['step', 'pcb'].includes(kind)) {
      return Response.json({ error: 'parentRunId and kind=step|pcb required' }, { status: 400 })
    }
    const a = runAccess(req, parent)
    if (a.access === 'unauthenticated') return Response.json({ error: 'sign in required' }, { status: 401 })
    if (a.access !== 'owner' && a.access !== 'shared') {
      return Response.json({ error: 'not your board' }, { status: 403 })
    }

    const buf = Buffer.from(await req.arrayBuffer())
    if (!buf.byteLength || buf.byteLength > MAX_BYTES) {
      return Response.json({ error: `file must be 1 byte – ${MAX_BYTES / 1e6} MB` }, { status: 400 })
    }
    const head = buf.subarray(0, 4096).toString('utf8')
    if (kind === 'step' && !head.includes('ISO-10303-21')) {
      return Response.json({ error: 'not a STEP file (missing ISO-10303-21 header)' }, { status: 400 })
    }
    if (kind === 'pcb' && !head.includes('(kicad_pcb')) {
      return Response.json({ error: 'not a KiCad board file (missing (kicad_pcb)' }, { status: 400 })
    }

    const note = `manual edit import (${kind === 'step' ? 'enclosure STEP' : 'board .kicad_pcb'})`
    const fork = await forkRun(parent, note)
    const forkDir = path.join(process.cwd(), 'public', 'runs', fork)

    if (kind === 'step') {
      await fs.mkdir(path.join(forkDir, 'mechanical'), { recursive: true })
      await fs.writeFile(path.join(forkDir, 'mechanical', 'enclosure.step'), buf)
      // the generated GLB no longer matches the edited STEP — remove it rather
      // than show stale geometry as if it were the import
      await fs.rm(path.join(forkDir, 'mechanical', 'enclosure.glb'), { force: true })
      try {
        const mj = path.join(forkDir, 'mechanical', 'mechanical.json')
        const m = JSON.parse(await fs.readFile(mj, 'utf8'))
        m.fitCheck = null // verified against the GENERATED geometry, not this edit
        m.gltfUrl = null
        m.manualImport = { kind: 'step', at: new Date().toISOString() }
        await fs.writeFile(mj, JSON.stringify(m))
      } catch { /* no mechanical.json — the STEP still lands */ }
    } else {
      await fs.mkdir(path.join(forkDir, 'electronics'), { recursive: true })
      await fs.writeFile(path.join(forkDir, 'electronics', 'chipscale.kicad_pcb'), buf)
      try {
        const bj = path.join(forkDir, 'electronics', 'chipscale-board.json')
        const b = JSON.parse(await fs.readFile(bj, 'utf8'))
        // the edit invalidates every verification claim — the board is not
        // green again until DRC/routing are re-checked against THIS file
        b.drc = null
        b.drcRepair = null
        b.boardSource = 'manual-import'
        b.manualImport = { kind: 'pcb', at: new Date().toISOString() }
        await fs.writeFile(bj, JSON.stringify(b))
      } catch { /* board json absent — nothing to strip */ }
    }

    if (a.email) recordRun(a.email, fork)
    const product = trackRun(fork, a.email)
    return Response.json({
      runId: fork,
      parentRunId: parent,
      productId: product?.productId ?? null,
      note,
      invalidated: kind === 'step'
        ? ['fitCheck (nulled)', 'enclosure GLB (removed)', 'simulation (stale via STEP hash)']
        : ['DRC + routing claims (cleared — board not green until re-verified)', 'downstream stages (stale via board identity)'],
    })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
