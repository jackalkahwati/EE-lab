/**
 * Import a LIVE Onshape assembly into Compose (session-authenticated).
 *
 * Runs the read-only geometry-in pipeline (scripts/onshape_pipeline.py) against
 * an Onshape assembly URL: exports the STEP, builds the per-part parametric
 * state map, and runs part-attributed analysis (clash / thermal / mass). Seeds
 * a product from the STEP (shared honest-import core, lib/import-design) and
 * drops the state + analysis JSON alongside it as run artifacts.
 *
 * POST { url: string, name?: string, boardW?: number, boardH?: number }
 * boardW/boardH (mm) optionally run the Stage-4 PCBA placement plan.
 *
 * Onshape auth is read from the work-hub vault by the Python (no keys in the
 * app env). Writes (part edits) are a separate, write-scoped, human-gated path.
 */
import { canRun, creditsAvailable, getUser, isAdminRequest, sessionEmail } from '@/lib/auth'
import { importDesign } from '@/lib/import-design'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const dynamic = 'force-dynamic'
export const maxDuration = 600

function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(cmd, args, { env })
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()))
    child.stderr?.on('data', (c: Buffer) => (out += c.toString()))
    child.on('error', (e) => resolve({ code: -1, out: out + `\nspawn failed: ${e.message}` }))
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
}

export async function POST(req: Request) {
  const email = sessionEmail(req)
  if (!email) return Response.json({ error: 'sign in required' }, { status: 401 })
  const userRec = getUser(email)
  if (!userRec) return Response.json({ error: 'unknown account' }, { status: 401 })
  if (!canRun(userRec) && !isAdminRequest(req)) {
    return Response.json(
      { error: `You've used your free runs (${creditsAvailable(userRec)} left). Subscribe to unlock more.` },
      { status: 402 },
    )
  }

  let body: { url?: string; name?: string; boardW?: number; boardH?: number }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'expected JSON { url, name?, boardW?, boardH? }' }, { status: 400 })
  }
  const url = String(body.url ?? '').trim()
  if (!/cad\.onshape\.com\/documents\/[0-9a-f]+\/w\/[0-9a-f]+\/e\/[0-9a-f]+/.test(url)) {
    return Response.json({ error: 'provide an Onshape assembly URL (…/documents/<d>/w/<w>/e/<e>)' }, { status: 400 })
  }
  const name = String(body.name ?? '').trim()
  const boardW = Number(body.boardW) || null
  const boardH = Number(body.boardH) || null

  const appDir = process.cwd()
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'onshape-'))
  try {
    const args = [path.join(appDir, 'scripts', 'onshape_pipeline.py'), '--url', url, '--outdir', outdir]
    if (boardW && boardH) args.push('--board-w', String(boardW), '--board-h', String(boardH))
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FL_VAULT_SCRIPTS: path.join(os.homedir(), 'work-hub', 'scripts'),
    }
    const res = await sh('python3', args, env)
    const stepPath = path.join(outdir, 'assembly.step')
    if (res.code !== 0 || !fs.existsSync(stepPath)) {
      return Response.json({ error: 'Onshape import failed', detail: res.out.slice(-600) }, { status: 502 })
    }

    const stepBuf = fs.readFileSync(stepPath)
    const summary = JSON.parse(fs.readFileSync(path.join(outdir, 'onshape-summary.json'), 'utf8'))
    const result = await importDesign({
      pcbBuf: null,
      stepBuf,
      name: name || summary.assembly || 'Onshape import',
      email,
    })

    // drop the parametric state + analysis alongside the imported geometry
    const runMech = path.join(appDir, 'public', 'runs', result.runId, 'mechanical')
    fs.mkdirSync(runMech, { recursive: true })
    for (const f of ['onshape-state.json', 'onshape-analysis.json', 'onshape-codesign.json', 'onshape-summary.json']) {
      const src = path.join(outdir, f)
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(runMech, f))
    }
    return Response.json({ ...result, onshape: summary })
  } finally {
    fs.rmSync(outdir, { recursive: true, force: true })
  }
}
