/**
 * Checkpoint-sealed revisions (Phase 7) — cryptographic provenance under the
 * iteration platform, via the Checkpoint Protocol (jackalkahwati/
 * Checkpoint-Protocol, `checkpoint-core` CLI).
 *
 * Each PRODUCT gets its own Checkpoint store (data/checkpoint/<productId>);
 * each completed revision becomes a full Checkpoint session:
 *
 *   start "<note> · <runId>"  (actor=agent compose-pipeline)
 *   → curated run artifacts synced into the working tree + gates.json
 *   → snapshot → verify (a REAL command that re-reads gates.json)
 *   → accept, Ed25519-signed by the store's ci identity
 *
 * The accepted-snapshot id + session id land on the product's revision record
 * (`sealed`), and `verify-history` proves the chain any time. HONESTY RULES:
 * sealing records what the gates SAID (a failed sim seals as failed — the
 * seal is provenance, not approval), it is strictly best-effort (a seal
 * failure never touches the pipeline), and requiring signed accepts is
 * enforced in the store config so an unsigned entry can't slip in.
 */
import { promises as fs } from 'node:fs'
import fsSync from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { productForRun, updateProduct, type Product } from '@/lib/design-state'
import { boardVerdict } from './verdict.ts'

const CK = process.env.CHECKPOINT_CORE || '/opt/homebrew/bin/checkpoint-core'
const STORES = path.join(process.cwd(), 'data', 'checkpoint')

/** Artifacts worth sealing — the design's identity, claims, and evidence. */
const SEAL_FILES = [
  'product-spec.json',
  'stage-hashes.json',
  'work-items.json',
  'data/last-run.json',
  'data/bom.json',
  'data/change-request.json',
  'electronics/chipscale-board.json',
  'electronics/chipscale.kicad_pcb',
  'mechanical/mechanical.json',
  'mechanical/enclosure.step',
  'disciplines/simulation.json',
  'disciplines/manufacturing.json',
  'disciplines/supplyChain.json',
  'disciplines/validation.json',
  'disciplines/firmware.json',
  'disciplines/id-brief.json',
  'disciplines/validation-results.json',
]

function run(cwd: string, args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const cp = spawn(CK, args, { cwd, timeout: timeoutMs, env: { ...process.env } })
    let out = ''
    cp.stdout.on('data', (d) => (out += d))
    cp.stderr.on('data', (d) => (out += d))
    cp.on('error', (e) => resolve({ ok: false, out: String(e) }))
    cp.on('close', (code) => resolve({ ok: code === 0, out }))
  })
}

async function ensureStore(productId: string): Promise<string | null> {
  const dir = path.join(STORES, productId)
  if (fsSync.existsSync(path.join(dir, '.checkpoint'))) return dir
  await fs.mkdir(dir, { recursive: true })
  const init = await run(dir, ['init', '--name', 'Compose Pipeline', '--email', 'compose@firstlight.build', '--yes'])
  if (!init.ok) return null
  const ident = await run(dir, ['identity', 'create', '--name', 'compose-pipeline', '--type', 'ci'])
  if (!ident.ok) return null
  // real verification command (re-reads the gates record inside the tree) +
  // signed accepts REQUIRED, so nothing unsigned can enter this history.
  const cfgPath = path.join(dir, '.checkpoint', 'config.yaml')
  let cfg = await fs.readFile(cfgPath, 'utf8')
  cfg = cfg.replace('  commands: []',
    `  commands:\n  - name: gates-record\n    run: python3 -c "import json; g=json.load(open('gates.json')); print('gates:', g['summary'])"`)
  cfg = cfg.replace('  require_signed_accepts: false', '  require_signed_accepts: true')
  await fs.writeFile(cfgPath, cfg)
  return dir
}

/** The honest-gate summary sealed WITH the artifacts (provenance of claims). */
function gatesSummary(runDir: string): { summary: string; detail: Record<string, unknown> } {
  const readJson = (rel: string) => {
    try { return JSON.parse(fsSync.readFileSync(path.join(runDir, rel), 'utf8')) } catch { return null }
  }
  const board = readJson('electronics/chipscale-board.json')
  const mech = readJson('mechanical/mechanical.json')
  const sim = readJson('disciplines/simulation.json')
  // The seal is the durable evidence record, so it must not seal a claim any
  // other surface would contradict — lib/verdict is the one decider.
  const bv = boardVerdict(board)
  const drc = bv.drcErrors
  const unrouted = bv.unrouted
  const fits = mech?.fitCheck?.fits ?? null
  const simResults = (sim?.results ?? []).filter((r: any) => !r.error)
  const simFails = simResults.filter((r: any) => r.pass === false).length
  const parts = [
    bv.state === 'unverified' ? 'board UNVERIFIED (no DRC ran)'
      : drc == null ? 'DRC unknown' : `DRC ${drc} error(s)`,
    unrouted == null ? '' : `${unrouted} unrouted`,
    // fits: null is 'unknown' — the cavity was never identified, so the fit was
    // never checked. Never seal that as a verified fit.
    fits == null ? 'fit unverified' : fits ? 'fit true' : 'fit FALSE',
    simResults.length ? `sim ${simResults.length - simFails}/${simResults.length} pass` : 'sim not run',
  ].filter(Boolean)
  return {
    summary: parts.join(' · '),
    detail: { drcErrors: drc, unrouted, fits, simFails, simTotal: simResults.length },
  }
}

// One seal at a time per product — sessions are stateful in the store.
const chains = new Map<string, Promise<void>>()

/**
 * Seal a tracked revision into its product's Checkpoint store. Idempotent
 * (already-sealed revisions are skipped) and strictly best-effort.
 */
export async function sealRevision(runId: string): Promise<
  { sealed: true; snapshotId: string; sessionId: string } | { sealed: false; reason: string }
> {
  const product = productForRun(runId)
  if (!product) return { sealed: false, reason: 'run not tracked in a product' }
  const rev = product.revisions.find((r) => r.runId === runId)
  if (!rev) return { sealed: false, reason: 'not a revision' }
  if ((rev as any).sealed) return { sealed: true, ...(rev as any).sealed }

  const prev = chains.get(product.productId) ?? Promise.resolve()
  let result: { sealed: true; snapshotId: string; sessionId: string } | { sealed: false; reason: string } =
    { sealed: false, reason: 'unknown' }
  const next = prev.then(async () => {
    result = await doSeal(product, runId, rev.note)
  }).catch(() => { /* chain must survive */ })
  chains.set(product.productId, next)
  await next
  return result
}

async function doSeal(product: Product, runId: string, note?: string): Promise<
  { sealed: true; snapshotId: string; sessionId: string } | { sealed: false; reason: string }
> {
  const store = await ensureStore(product.productId)
  if (!store) return { sealed: false, reason: 'checkpoint store init failed' }
  const runDir = path.join(process.cwd(), 'public', 'runs', runId)

  // sync the curated artifact set into the working tree (previous tree files
  // are replaced wholesale — the tree always shows exactly one revision)
  for (const entry of await fs.readdir(store)) {
    if (entry === '.checkpoint') continue
    await fs.rm(path.join(store, entry), { recursive: true, force: true })
  }
  let copied = 0
  for (const rel of SEAL_FILES) {
    try {
      const dst = path.join(store, rel)
      await fs.mkdir(path.dirname(dst), { recursive: true })
      await fs.copyFile(path.join(runDir, rel), dst)
      copied++
    } catch { /* artifact not produced for this run */ }
  }
  if (!copied) return { sealed: false, reason: 'no artifacts to seal' }
  const gates = gatesSummary(runDir)
  await fs.writeFile(path.join(store, 'gates.json'),
    JSON.stringify({ runId, summary: gates.summary, ...gates.detail, sealedAt: new Date().toISOString() }, null, 1))

  const label = `${note ?? 'revision'} · ${runId}`
  const started = await run(store, ['start', label.slice(0, 140), '--actor', 'agent', '--agent', 'compose-pipeline', '--no-watch'])
  if (!started.ok) return { sealed: false, reason: `start failed: ${started.out.slice(-120)}` }
  const snap = await run(store, ['snapshot', '-m', `artifacts of ${runId}`])
  if (!snap.ok) { await run(store, ['reject', '--reason', 'seal aborted']); return { sealed: false, reason: 'snapshot failed' } }
  await run(store, ['verify']) // recorded; accept re-runs it (run_on_accept)
  const accepted = await run(store, ['accept', '-m', `sealed ${runId} · gates ${gates.summary}`.slice(0, 200)])
  if (!accepted.ok) return { sealed: false, reason: `accept failed: ${accepted.out.slice(-160)}` }

  const hist = await run(store, ['history'])
  const m = hist.out.match(/^([0-9a-f]{12,})\s/m)
  const sm = hist.out.match(/session\s+(\S+)/)
  const sealed = {
    snapshotId: m?.[1] ?? 'accepted',
    sessionId: sm?.[1] ?? 'unknown',
    at: new Date().toISOString(),
  }
  updateProduct(product.productId, (p) => {
    const r = p.revisions.find((x) => x.runId === runId)
    if (r) (r as any).sealed = sealed
  })
  return { sealed: true, snapshotId: sealed.snapshotId, sessionId: sealed.sessionId }
}

/** verify-history for a product's store — the provenance proof. */
export async function verifyProvenance(productId: string): Promise<{ ok: boolean; report: string }> {
  const dir = path.join(STORES, productId)
  if (!fsSync.existsSync(path.join(dir, '.checkpoint'))) {
    return { ok: false, report: 'no checkpoint store for this product yet' }
  }
  const [vh, ts] = [await run(dir, ['verify-history']), await run(dir, ['trust-status'])]
  return { ok: vh.ok, report: `${vh.out.trim()}\n${ts.out.trim()}` }
}
