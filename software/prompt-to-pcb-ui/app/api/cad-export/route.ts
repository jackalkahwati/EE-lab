/**
 * CAD interchange export (Altium · Cadence OrCAD/Allegro · any CAM). Compose is
 * KiCad-native; there is no reliable open read/write for the vendors' proprietary
 * binaries (.PcbDoc/.SchDoc, Allegro .brd), so a HONEST integration hands off
 * through the neutral formats those tools import natively: IPC-2581 and ODB++.
 * Both import into Altium (Import Wizard) and Allegro alike.
 *
 * GET /api/cad-export?run=<runDir>&format=ipc2581|odb|pack
 *   ipc2581 -> single .xml (geometry + netlist + BOM)
 *   odb     -> ODB++ archive
 *   pack    -> zip of both + the BOM json when present + an import readme
 *
 * Files are generated on demand with kicad-cli and streamed back (never written
 * under public/, so nothing is faked or left implying a build).
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { isValidRunId, runAccess } from '@/lib/auth'
import { kicadCli } from '@/lib/toolchain'

const KICAD_CLI = kicadCli()
const RUNS = path.join(process.cwd(), 'public', 'runs')

function findPcb(runDir: string): string | null {
  const dir = path.join(RUNS, runDir)
  if (!fs.existsSync(dir)) return null
  const direct = path.join(dir, 'variant.kicad_pcb')
  if (fs.existsSync(direct)) return direct
  const hit = fs.readdirSync(dir).find((f) => f.endsWith('.kicad_pcb'))
  return hit ? path.join(dir, hit) : null
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const run = (url.searchParams.get('run') ?? '').trim()
  const format = (url.searchParams.get('format') ?? 'ipc2581').trim()

  if (!isValidRunId(run)) {
    return Response.json({ error: 'invalid run' }, { status: 400 })
  }
  const auth = runAccess(req, run)
  if (auth.access === 'unauthenticated') {
    return Response.json({ error: 'sign in required' }, { status: 401 })
  }
  if (auth.access === 'forbidden') {
    return Response.json({ error: 'not your board' }, { status: 403 })
  }
  const pcb = findPcb(run)
  if (!pcb) return Response.json({ error: `no .kicad_pcb for run ${run}` }, { status: 404 })

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-'))
  try {
    const kc = (args: string[]) => execFileSync(KICAD_CLI, args, { timeout: 120_000 })

    if (format === 'ipc2581') {
      const out = path.join(tmp, `${run}.xml`)
      kc(['pcb', 'export', 'ipc2581', '--units', 'mm', '--output', out, pcb])
      return new Response(new Uint8Array(fs.readFileSync(out)), {
        headers: { 'content-type': 'application/xml',
                   'content-disposition': `attachment; filename="${run}.ipc2581.xml"` },
      })
    }

    if (format === 'odb') {
      const out = path.join(tmp, `${run}.odb.zip`)
      kc(['pcb', 'export', 'odb', '--compression', 'zip', '--units', 'mm', '--output', out, pcb])
      return new Response(new Uint8Array(fs.readFileSync(out)), {
        headers: { 'content-type': 'application/zip',
                   'content-disposition': `attachment; filename="${run}.odb.zip"` },
      })
    }

    if (format === 'pack') {
      kc(['pcb', 'export', 'ipc2581', '--units', 'mm', '--output', path.join(tmp, `${run}.ipc2581.xml`), pcb])
      kc(['pcb', 'export', 'odb', '--compression', 'zip', '--units', 'mm', '--output', path.join(tmp, `${run}.odb.zip`), pcb])
      const bom = path.join(RUNS, run, 'data', 'bom.json')
      if (fs.existsSync(bom)) fs.copyFileSync(bom, path.join(tmp, 'bom.json'))
      fs.writeFileSync(path.join(tmp, 'IMPORT.txt'),
        `Compose CAD handoff for "${run}"\n\n`
        + `- ${run}.ipc2581.xml : Altium File > Import Wizard > IPC-2581; Allegro import IPC-2581\n`
        + `- ${run}.odb.zip     : Altium Import Wizard / CAMtastic; Allegro ODB++ import\n`
        + `- bom.json           : bill of materials (when present)\n\n`
        + `Generated from the KiCad board with kicad-cli. Native .PcbDoc / Allegro\n`
        + `.brd write is not supported (no reliable open format); these neutral\n`
        + `formats are the vendors' own supported import paths.\n`)
      const zip = path.join(tmp, `${run}.cad-handoff.zip`)
      execFileSync('zip', ['-j', '-q', zip, ...fs.readdirSync(tmp)
        .filter((f) => f !== `${run}.cad-handoff.zip`)
        .map((f) => path.join(tmp, f))], { timeout: 60_000 })
      return new Response(new Uint8Array(fs.readFileSync(zip)), {
        headers: { 'content-type': 'application/zip',
                   'content-disposition': `attachment; filename="${run}.cad-handoff.zip"` },
      })
    }

    return Response.json({ error: `unknown format ${format}` }, { status: 400 })
  } catch (e: any) {
    return Response.json({ error: 'export failed', detail: String(e?.message ?? e).slice(0, 400) },
                        { status: 500 })
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}
