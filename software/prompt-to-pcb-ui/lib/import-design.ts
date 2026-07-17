/**
 * Shared "start from an existing design" core, used by both the session route
 * (app/api/pipeline/import) and the programmatic API (app/api/v1/imports).
 *
 * Seeds a FRESH product/run from an uploaded PCBA (.kicad_pcb) and/or CAD
 * assembly (.step). Honesty is the design: an imported board runs real KiCad DRC
 * on ingest and wears no green until it passes against YOUR file; an imported
 * assembly lands as geometry with the fit check nulled; firmware and physics are
 * not faked (they need a design spec Compose did not originate).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { chargeCredits, recordRun } from '@/lib/auth'
import { trackRun } from '@/lib/design-state'
import { kicadCli, kicadPython } from '@/lib/toolchain'

export const MAX_IMPORT_BYTES = 50 * 1024 * 1024

function sh(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(cmd, args)
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()))
    child.stderr?.on('data', (c: Buffer) => (out += c.toString()))
    child.on('error', (e) => resolve({ code: -1, out: out + `\nspawn failed: ${e.message}` }))
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
}

/** Validate an uploaded buffer looks like the claimed kind. Returns an error
 *  string, or null when it passes. */
export function validateUpload(buf: Buffer | null, kind: 'pcb' | 'step'): string | null {
  if (!buf) return null
  if (buf.byteLength > MAX_IMPORT_BYTES) return `${kind} exceeds ${MAX_IMPORT_BYTES / 1e6} MB`
  const head = buf.subarray(0, 4096).toString('utf8')
  if (kind === 'pcb' && !head.includes('(kicad_pcb')) return 'PCBA must be a KiCad .kicad_pcb file'
  if (kind === 'step' && !head.includes('ISO-10303-21')) return 'CAD assembly must be a STEP file (ISO-10303-21)'
  return null
}

export interface ImportResult {
  runId: string
  productId: string | null
  name: string
  imported: { pcb: boolean; step: boolean }
  board?: {
    sizeMm: [number, number] | null
    components: unknown
    netsTotal: unknown
    netsRouted: unknown
    drcViolations: unknown
    analysisError: string | null
  }
  note: string
}

export async function importDesign(opts: {
  pcbBuf: Buffer | null
  stepBuf: Buffer | null
  name: string
  email: string
}): Promise<ImportResult> {
  const { pcbBuf, stepBuf, email } = opts
  const name = (opts.name || '').trim().slice(0, 120) || 'Imported design'
  const appDir = process.cwd()
  const runId = `run-${randomUUID()}`
  const runRoot = path.join(appDir, 'public', 'runs', runId)
  const dataDir = path.join(runRoot, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const script = (n: string) => path.join(appDir, 'scripts', n)
  const KCLI = kicadCli()
  const KPY = kicadPython()

  const result: ImportResult = {
    runId,
    productId: null,
    name,
    imported: { pcb: !!pcbBuf, step: !!stepBuf },
    note:
      'imported design — the board wears no green until its checks pass against your file; firmware and physics need a spec before they run',
  }

  // --- PCBA: seed the editable board, run REAL DRC, extract honest stats -----
  if (pcbBuf) {
    fs.writeFileSync(path.join(runRoot, 'variant.kicad_pcb'), pcbBuf)
    fs.mkdirSync(path.join(runRoot, 'electronics'), { recursive: true })
    fs.writeFileSync(path.join(runRoot, 'electronics', 'chipscale.kicad_pcb'), pcbBuf)

    let board: Record<string, unknown> = { source: 'manual-import', imported: true }
    let analysisError: string | null = null
    const boardJsonPath = path.join(dataDir, 'board.json')
    if (fs.existsSync(KCLI) && fs.existsSync(KPY)) {
      const boardPath = path.join(runRoot, 'variant.kicad_pcb')
      const drcPath = path.join(dataDir, 'drc.json')
      const drcRes = await sh(KCLI, ['pcb', 'drc', '--format', 'json', '--severity-error', '-o', drcPath, boardPath])
      const exRes = await sh(KPY, [script('extract_stats.py'), boardPath, drcPath, boardJsonPath])
      try {
        board = { ...JSON.parse(fs.readFileSync(boardJsonPath, 'utf8')), source: 'manual-import', imported: true, runId }
      } catch {
        const log = `${drcRes.out}\n${exRes.out}`
        analysisError = /more recent version|upgrade KiCad|file format dated/i.test(log)
          ? 'This board was saved with a newer KiCad than our current toolchain. Re-export it from an older KiCad and import again.'
          : 'Could not read this board file — confirm it is a valid KiCad PCB.'
      }
    } else {
      analysisError = 'Board analysis is not available on this deployment.'
    }
    if (analysisError) board.analysisError = analysisError
    fs.writeFileSync(boardJsonPath, JSON.stringify(board, null, 1))

    const bs = Array.isArray(board.boardSize) ? (board.boardSize as number[]) : null
    const wMm = Number(board.wMm ?? bs?.[0] ?? 0)
    const hMm = Number(board.hMm ?? bs?.[1] ?? 0)
    const drc = board.drc as { violations?: number } | undefined
    fs.writeFileSync(
      path.join(runRoot, 'electronics', 'chipscale-board.json'),
      JSON.stringify(
        {
          boardMm: wMm && hMm ? [wMm, hMm] : null,
          components: board.components ?? null,
          netsTotal: board.netsTotal ?? null,
          netsRouted: board.netsRouted ?? null,
          drc: board.drc ?? null,
          boardSource: 'manual-import',
          imported: true,
          manualImport: { kind: 'pcb', at: new Date().toISOString() },
        },
        null,
        1,
      ),
    )
    result.board = {
      sizeMm: wMm && hMm ? [wMm, hMm] : null,
      components: board.components ?? null,
      netsTotal: board.netsTotal ?? null,
      netsRouted: board.netsRouted ?? null,
      drcViolations: drc?.violations ?? board.violations ?? null,
      analysisError,
    }
  }

  // --- CAD assembly: land the geometry; fit check nulled until re-checked ----
  if (stepBuf) {
    fs.mkdirSync(path.join(runRoot, 'mechanical'), { recursive: true })
    fs.writeFileSync(path.join(runRoot, 'mechanical', 'enclosure.step'), stepBuf)
    fs.writeFileSync(
      path.join(runRoot, 'mechanical', 'mechanical.json'),
      JSON.stringify(
        { source: 'manual-import', imported: true, fitCheck: null, manualImport: { kind: 'step', at: new Date().toISOString() } },
        null,
        1,
      ),
    )
  }

  // --- product spec + run report so it registers and displays as a product ---
  fs.writeFileSync(
    path.join(runRoot, 'product-spec.json'),
    JSON.stringify({ product: name, source: 'import', imported: true, createdAt: new Date().toISOString() }, null, 1),
  )
  fs.writeFileSync(
    path.join(dataDir, 'last-run.json'),
    JSON.stringify({ product: name, source: 'import', imported: true, at: new Date().toISOString(), runId }, null, 2),
  )

  chargeCredits(email, 1)
  recordRun(email, runId)
  const product = trackRun(runId, email)
  result.productId = product?.productId ?? null
  return result
}
