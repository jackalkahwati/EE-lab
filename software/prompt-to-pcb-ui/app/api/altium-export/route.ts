/**
 * Altium handoff export. Compose is KiCad-native; there is no reliable open
 * read/write for Altium's proprietary .PcbDoc/.SchDoc binaries, so a HONEST
 * Altium integration hands off through the neutral formats Altium imports
 * natively: IPC-2581 (Import Wizard) and ODB++ (CAMtastic / Import Wizard).
 *
 * GET /api/altium-export?run=<runDir>&format=ipc2581|odb|pack
 *   ipc2581 -> single .xml (geometry + netlist + BOM)
 *   odb     -> ODB++ archive
 *   pack    -> zip of both + the BOM json when present
 *
 * Files are generated on demand with kicad-cli and streamed back (never written
 * under public/, so nothing is faked or left implying a build).
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

const KICAD_CLI = process.env.KICAD_CLI
  ?? '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
const RUNS = path.join(process.cwd(), 'public', 'runs')

function findPcb(runDir: string): string | null {
  const dir = path.join(RUNS, runDir)
  if (!fs.existsSync(dir)) return null
  // prefer variant.kicad_pcb, else the first .kicad_pcb in the run root
  const direct = path.join(dir, 'variant.kicad_pcb')
  if (fs.existsSync(direct)) return direct
  const hit = fs.readdirSync(dir).find((f) => f.endsWith('.kicad_pcb'))
  return hit ? path.join(dir, hit) : null
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const run = (url.searchParams.get('run') ?? '').trim()
  const format = (url.searchParams.get('format') ?? 'ipc2581').trim()

  // sanitize: no path traversal, must be an existing run dir
  if (!run || !/^[A-Za-z0-9._-]+$/.test(run)) {
    return Response.json({ error: 'invalid run' }, { status: 400 })
  }
  const pcb = findPcb(run)
  if (!pcb) return Response.json({ error: `no .kicad_pcb for run ${run}` }, { status: 404 })

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'altium-'))
  try {
    const kc = (args: string[]) => execFileSync(KICAD_CLI, args, { timeout: 120_000 })

    if (format === 'ipc2581') {
      const out = path.join(tmp, `${run}.xml`)
      kc(['pcb', 'export', 'ipc2581', '--units', 'mm', '--output', out, pcb])
      const buf = fs.readFileSync(out)
      return new Response(new Uint8Array(buf), {
        headers: {
          'content-type': 'application/xml',
          'content-disposition': `attachment; filename="${run}.ipc2581.xml"`,
        },
      })
    }

    if (format === 'odb') {
      const out = path.join(tmp, `${run}.odb.zip`)
      kc(['pcb', 'export', 'odb', '--compression', 'zip', '--units', 'mm', '--output', out, pcb])
      const buf = fs.readFileSync(out)
      return new Response(new Uint8Array(buf), {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${run}.odb.zip"`,
        },
      })
    }

    if (format === 'pack') {
      kc(['pcb', 'export', 'ipc2581', '--units', 'mm', '--output', path.join(tmp, `${run}.ipc2581.xml`), pcb])
      kc(['pcb', 'export', 'odb', '--compression', 'zip', '--units', 'mm', '--output', path.join(tmp, `${run}.odb.zip`), pcb])
      // include the BOM if the run produced one
      const bom = path.join(RUNS, run, 'data', 'bom.json')
      if (fs.existsSync(bom)) fs.copyFileSync(bom, path.join(tmp, 'bom.json'))
      // a short README so the recipient knows how to import
      fs.writeFileSync(path.join(tmp, 'IMPORT-INTO-ALTIUM.txt'),
        `Compose -> Altium handoff for "${run}"\n\n`
        + `- ${run}.ipc2581.xml : File > Import Wizard > IPC-2581\n`
        + `- ${run}.odb.zip     : File > Import Wizard > ODB++  (or CAMtastic)\n`
        + `- bom.json           : bill of materials (when present)\n\n`
        + `Generated from the KiCad board with kicad-cli. Native .PcbDoc write\n`
        + `is not supported (no reliable open format); these neutral formats are\n`
        + `Altium's own supported import paths.\n`)
      const zip = path.join(tmp, `${run}.altium-handoff.zip`)
      execFileSync('zip', ['-j', '-q', zip, ...fs.readdirSync(tmp)
        .filter((f) => f !== `${run}.altium-handoff.zip`)
        .map((f) => path.join(tmp, f))], { timeout: 60_000 })
      const buf = fs.readFileSync(zip)
      return new Response(new Uint8Array(buf), {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${run}.altium-handoff.zip"`,
        },
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
