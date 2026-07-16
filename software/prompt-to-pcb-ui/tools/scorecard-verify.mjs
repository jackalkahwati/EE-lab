#!/usr/bin/env node
/**
 * Stage B verification harness — exercises /api/runs/scorecard end-to-end
 * against a live dev server (default http://localhost:3009).
 *
 *   node tools/scorecard-verify.mjs <run-id> [--diagnose] [--base URL]
 *
 * Builds a real fl_session cookie from AUTH_SECRET in .env.local (same format
 * as lib/auth makeSession), calls the route, and prints:
 *  - the summary + every entry (status / margin / confidence)
 *  - each diagnosis corrective, re-checking alsoAffects ⊆ affectedBy(target)
 *    against the graph in the run's product-state.json (independent check —
 *    not trusting the route's own validation).
 */
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const runId = args.find((a) => !a.startsWith('--'))
const diagnose = args.includes('--diagnose')
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://localhost:3009'
const email = process.env.FL_EMAIL || 'jack@lattis.io'
if (!runId) {
  console.error('usage: node tools/scorecard-verify.mjs <run-id> [--diagnose] [--base URL]')
  process.exit(2)
}

// fileURLToPath, NOT .pathname — the repo path contains a space ("T9 Backup")
// which .pathname leaves percent-encoded and fs then can't open.
const uiDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const envLine = readFileSync(path.join(uiDir, '.env.local'), 'utf8')
  .split('\n').find((l) => l.startsWith('AUTH_SECRET='))
const secret = envLine ? envLine.slice('AUTH_SECRET='.length).trim() : 'firstlight-dev-secret'

const b64url = (b) => Buffer.from(b).toString('base64url')
const payload = `${b64url(email)}|${Date.now() + 3600_000}`
const cookie = `fl_session=${payload}|${b64url(createHmac('sha256', secret).update(payload).digest())}`

const url = `${base}/api/runs/scorecard?run=${encodeURIComponent(runId)}${diagnose ? '&diagnose=1' : ''}`
const r = await fetch(url, { headers: { cookie } })
if (!r.ok) {
  console.error(`HTTP ${r.status}: ${await r.text()}`)
  process.exit(1)
}
const sc = await r.json()

console.log(`\n== scorecard ${sc.runId} @ ${sc.generatedAt}`)
console.log(`summary: ${sc.summary}\n`)
for (const e of sc.entries) {
  console.log(`  [${e.status.toUpperCase().padEnd(10)}] (${e.confidence}) ${e.requirement}`)
  if (e.margin) console.log(`               margin: ${e.margin}`)
}
console.log(`\nfailures: ${sc.failures.length}`)

if (sc.diagnosis) {
  console.log(`\n== diagnosis: state=${sc.diagnosis.state}${sc.diagnosis.reason ? ` reason=${sc.diagnosis.reason}` : ''}`)
  // independent graph re-check from the persisted product-state
  let graph = null
  try {
    graph = JSON.parse(readFileSync(path.join(uiDir, 'public', 'runs', runId, 'product-state.json'), 'utf8')).graph
  } catch { /* no state — skip the independent check */ }
  const closure = (t) => {
    const seen = new Set(); const q = [t]
    while (q.length) for (const d of (graph?.[q.shift()] ?? [])) if (!seen.has(d)) { seen.add(d); q.push(d) }
    seen.delete(t); return seen
  }
  for (const c of sc.diagnosis.correctives ?? []) {
    console.log(`\n  failure: ${c.requirement}`)
    console.log(`  target: ${c.target} (in graph: ${c.targetInGraph}) confidence: ${c.confidence} provider: ${c.provider}`)
    console.log(`  change: ${c.change}`)
    console.log(`  expectedEffect: ${c.expectedEffect}`)
    console.log(`  penaltyEstimate: ${c.penaltyEstimate}`)
    console.log(`  alsoAffects: [${c.alsoAffects.join(', ')}]${c.graphRejected ? ` graphRejected: [${c.graphRejected.join(', ')}]` : ''}`)
    if (graph) {
      const allowed = closure(c.target)
      const bad = c.alsoAffects.filter((a) => !allowed.has(a))
      console.log(`  graph re-check: ${bad.length ? `VIOLATION — [${bad.join(', ')}] not in affectedBy(${c.target})` : `OK — alsoAffects ⊆ affectedBy(${c.target})`}`)
    }
  }
  if (sc.diagnosis.errors?.length) console.log(`\n  diagnostician errors: ${JSON.stringify(sc.diagnosis.errors)}`)
}
