# Stage A — Shared Product State + Declared Dependency Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One canonical `product-state.json` per run — a unified view over the artifacts every stage already persists — plus the constraint/dependency graph as DECLARED data with a walk function, so the scorecard (Stage B) and propagation loop (Stage C) have a substrate. Zero behavior change to any existing stage.

**Architecture:** A pure client-safe module (`lib/product-state.ts`: types, the declared edge map, BFS walk) + one server route (`app/api/runs/product-state/route.ts`: assembles from the run dir on disk, records per-section presence/hash/validationStatus, persists, and answers "what does changing X affect?") + a best-effort hook at the end of `lib/run-pipeline.ts`. Assembly is READ-ONLY over existing artifacts — it never invents data; absent artifacts are recorded `{present: false}`, never faked.

**Tech Stack:** Next.js route (Node fs), TypeScript. No new dependencies.

**Grounding (verified against a real run, `public/runs/run-b9117835-…`):** artifacts exist at `product-spec.json`, `data/{design,design-tree,verification,devices,drc,bom,power-budget,substitutions}.json`, `electronics/chipscale-board.json`, `disciplines/{id-brief,simulation,firmware,manufacturing,supplyChain,validation,redesign}.json`, `id/render.json`, `mechanical/mechanical.json`, `timing.json`, `stage-hashes.json`. The fidelity plan (running in parallel) adds `disciplines/mech-fidelity.json` and `id/consistency.json` — include them as optional sections from day one.

---

### Task 1: lib/product-state.ts — types, declared graph, walk

**Files:**
- Create: `software/prompt-to-pcb-ui/lib/product-state.ts`

- [ ] **Step 1: Write the module**

```typescript
/**
 * Product state — the shared system model (orchestrator roadmap, Stage A).
 * One JSON per run unifying what every stage already persists, each section
 * carrying presence + content hash + validation status. The DEPENDENCY graph
 * is DECLARED data (auditable, no inference): field -> what a change affects.
 * Stage B (scorecard) reads sections; Stage C (propagation) walks the graph.
 * This module is pure and client-safe — all fs work lives in the API route.
 */

export type SectionStatus = 'passed' | 'failed' | 'warnings' | 'unverified' | 'absent'

export interface StateSection {
  present: boolean
  /** sha1 of the artifact file(s) — change detection for Stage C */
  hash?: string
  status: SectionStatus
  /** tiny extract for the scorecard — NEVER the whole artifact */
  summary?: Record<string, unknown>
  paths: string[]
}

export interface ProductState {
  runId: string
  assembledAt: string
  sections: Record<string, StateSection>
  graph: typeof DEPENDENCY_EDGES
}

/**
 * The constraint/dependency graph, declared: a change to KEY invalidates each
 * listed dependent (section names or other keys — walk is transitive).
 * Deliberately coarse in Stage A; Stage C refines granularity as it needs.
 */
export const DEPENDENCY_EDGES: Record<string, string[]> = {
  'spec.budgets': ['electronics', 'power'],
  'spec.product': ['id.brief', 'electronics'],
  'electronics.board': ['mechanical', 'id.scaffold', 'simulation', 'firmware'],
  'electronics.bom': ['supplyChain', 'manufacturing', 'cost', 'power'],
  'electronics.mcu': ['firmware', 'power'],
  'power': ['electronics.board'],
  'id.brief': ['id.render', 'mechanical'],
  'id.envelope': ['mechanical'],
  'mechanical.enclosure': ['manufacturing', 'simulation'],
  'simulation': ['validation'],
}

/** Transitive closure of what a change to `field` affects (BFS, cycle-safe). */
export function affectedBy(field: string, edges: Record<string, string[]> = DEPENDENCY_EDGES): string[] {
  const seen = new Set<string>()
  const queue = [field]
  while (queue.length) {
    const f = queue.shift() as string
    for (const dep of edges[f] ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep)
        queue.push(dep)
      }
    }
    // section-level edges also fire for field-level keys under them
    // (a change to electronics.mcu affects whatever depends on electronics)
    const parent = f.includes('.') ? f.split('.')[0] : null
    if (parent && !seen.has(`__p:${parent}`)) {
      seen.add(`__p:${parent}`)
      queue.push(parent)
    }
  }
  seen.delete(field)
  return [...seen].filter((s) => !s.startsWith('__p:'))
}

/** Section name -> the run-relative artifact files it is assembled from. */
export const SECTION_SOURCES: Record<string, string[]> = {
  spec: ['product-spec.json'],
  'id.brief': ['disciplines/id-brief.json'],
  'id.render': ['id/render.json', 'id/consistency.json'],
  electronics: [
    'data/design.json', 'data/design-tree.json', 'data/verification.json',
    'data/devices.json', 'data/drc.json', 'data/substitutions.json',
    'electronics/chipscale-board.json',
  ],
  bom: ['data/bom.json'],
  power: ['data/power-budget.json'],
  mechanical: ['mechanical/mechanical.json', 'disciplines/mech-fidelity.json'],
  simulation: ['disciplines/simulation.json'],
  firmware: ['disciplines/firmware.json'],
  manufacturing: ['disciplines/manufacturing.json'],
  supplyChain: ['disciplines/supplyChain.json'],
  validation: ['disciplines/validation.json'],
  timing: ['timing.json'],
  stageHashes: ['stage-hashes.json'],
}
```

- [ ] **Step 2: Typecheck**

Run: `cd software/prompt-to-pcb-ui && npx tsc --noEmit`
Expected: silent.

---

### Task 2: The assembly route

**Files:**
- Create: `software/prompt-to-pcb-ui/app/api/runs/product-state/route.ts`

- [ ] **Step 1: Discover the real status fields before coding the extractors**

```bash
cd "/Volumes/T9 Backup/EE-lab/software/prompt-to-pcb-ui/public/runs/run-b9117835-227b-46f7-86f6-16773db7385a"
python3 -c "import json;d=json.load(open('data/verification.json'));print(type(d), list(d)[:8])"
python3 -c "import json;d=json.load(open('data/drc.json'));print(list(d)[:8])"
python3 -c "import json;d=json.load(open('data/bom.json'));print(type(d), (list(d)[:8] if isinstance(d,dict) else ('list', len(d), list(d[0])[:8])))"
python3 -c "import json;d=json.load(open('disciplines/simulation.json'));print(list(d)[:8])"
```

Record the actual field names; the `summarize()` switch below must read THOSE (adjust the property names — the shapes shown are the expected ones, verify each).

- [ ] **Step 2: Write the route**

```typescript
/**
 * GET /api/runs/product-state?run=<id>            -> assemble + persist + return
 * GET /api/runs/product-state?run=<id>&changed=X  -> also answer the graph walk
 * Read-only over existing artifacts. Absent sections are {present:false,
 * status:'absent'} — assembly NEVER fakes or backfills.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DEPENDENCY_EDGES, SECTION_SOURCES, affectedBy, type ProductState, type SectionStatus, type StateSection } from '@/lib/product-state'

export const dynamic = 'force-dynamic'
const RUN_ID = /^[A-Za-z0-9._-]{1,128}$/

function summarize(section: string, files: Record<string, any>): { status: SectionStatus; summary?: Record<string, unknown> } {
  // tiny, honest extracts — adjust the field names to what Step 1 found
  switch (section) {
    case 'electronics': {
      const drc = files['data/drc.json']
      const ver = files['data/verification.json']
      if (!drc && !ver) return { status: 'unverified' }
      const errs = Array.isArray(drc?.violations) ? drc.violations.filter((v: any) => v?.severity === 'error').length : undefined
      const unc = Array.isArray(drc?.unconnected_items) ? drc.unconnected_items.length : undefined
      const converged = ver?.converged === true
      const status: SectionStatus = errs === 0 && unc === 0 ? 'passed' : errs == null ? 'unverified' : 'failed'
      return { status, summary: { drcErrors: errs, unconnected: unc, converged, mcu: files['data/design.json']?.mcu ?? null } }
    }
    case 'mechanical': {
      const fid = files['disciplines/mech-fidelity.json']
      if (!fid) return { status: 'unverified', summary: { fidelity: 'no fidelity report' } }
      const st = fid.state === 'verified' ? 'passed' : fid.state === 'failed-threshold' ? 'failed' : 'unverified'
      return { status: st, summary: { fidelity: fid.state, rounds: fid.rounds?.length ?? 0 } }
    }
    case 'id.render': {
      const con = files['id/consistency.json']
      if (!con) return { status: 'unverified', summary: { consistency: 'no consistency report' } }
      const st = con.state === 'verified' ? 'passed' : con.state === 'failed-threshold' ? 'failed' : 'unverified'
      return { status: st, summary: { consistency: con.state } }
    }
    case 'bom': {
      const bom = files['data/bom.json']
      if (!bom) return { status: 'unverified' }
      const rows = Array.isArray(bom) ? bom : Array.isArray(bom?.rows) ? bom.rows : []
      return { status: 'passed', summary: { lineItems: rows.length } }
    }
    default:
      return { status: files && Object.keys(files).length ? 'passed' : 'unverified' }
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const runId = url.searchParams.get('run') ?? ''
  if (!RUN_ID.test(runId)) return Response.json({ error: 'bad run id' }, { status: 400 })
  const runDir = path.join(process.cwd(), 'public', 'runs', runId)
  try { await fs.access(runDir) } catch { return Response.json({ error: 'unknown run' }, { status: 404 }) }

  const sections: Record<string, StateSection> = {}
  for (const [name, rels] of Object.entries(SECTION_SOURCES)) {
    const files: Record<string, any> = {}
    const found: string[] = []
    const h = createHash('sha1')
    for (const rel of rels) {
      try {
        const raw = await fs.readFile(path.join(runDir, rel), 'utf8')
        h.update(raw)
        found.push(rel)
        try { files[rel] = JSON.parse(raw) } catch { /* non-JSON artifact: hash only */ }
      } catch { /* absent — recorded below, never faked */ }
    }
    if (!found.length) {
      sections[name] = { present: false, status: 'absent', paths: rels }
      continue
    }
    const { status, summary } = summarize(name, files)
    sections[name] = { present: true, hash: h.digest('hex'), status, summary, paths: found }
  }

  const state: ProductState = { runId, assembledAt: new Date().toISOString(), sections, graph: DEPENDENCY_EDGES }
  try { await fs.writeFile(path.join(runDir, 'product-state.json'), JSON.stringify(state, null, 1)) }
  catch { /* persistence is best-effort; the response is authoritative */ }

  const changed = url.searchParams.get('changed')
  return Response.json(changed ? { ...state, changed, affected: affectedBy(changed) } : state)
}
```

- [ ] **Step 3: Typecheck**

Run: `cd software/prompt-to-pcb-ui && npx tsc --noEmit` — silent.

- [ ] **Step 4: Verify against the real run (dev server on a spare port)**

```bash
cd "/Volumes/T9 Backup/EE-lab/software/prompt-to-pcb-ui"
PORT=3006 npm run dev >/dev/null 2>&1 &
sleep 8
curl -s "http://localhost:3006/api/runs/product-state?run=run-b9117835-227b-46f7-86f6-16773db7385a" | python3 -c "
import json, sys
s = json.load(sys.stdin)
secs = s['sections']
assert secs['spec']['present'] and secs['electronics']['present'], 'core sections missing'
assert secs['electronics']['hash'], 'no hash'
absent = [k for k, v in secs.items() if not v['present']]
print('sections:', len(secs), '| absent (expected for pre-fidelity runs):', absent)
print('electronics:', secs['electronics']['status'], secs['electronics']['summary'])
"
curl -s "http://localhost:3006/api/runs/product-state?run=run-b9117835-227b-46f7-86f6-16773db7385a&changed=electronics.bom" | python3 -c "
import json, sys
s = json.load(sys.stdin)
aff = set(s['affected'])
assert {'supplyChain', 'manufacturing', 'cost', 'power'} <= aff, aff
assert 'electronics.board' in aff, 'transitive power->board edge missed: %r' % aff
print('graph walk OK:', sorted(aff))
"
kill %1
cat public/runs/run-b9117835-227b-46f7-86f6-16773db7385a/product-state.json | head -5
```

Expected: both asserts pass; `product-state.json` persisted in the run dir.

---

### Task 3: Best-effort hook at pipeline end

**Files:**
- Modify: `software/prompt-to-pcb-ui/lib/run-pipeline.ts` (immediately before the final `return { stages, feedback, updatedSpec: … }` at the end of the pipeline function, after the fork reconciliation)

- [ ] **Step 1: Add the hook**

```typescript
  // Stage A (orchestrator roadmap): assemble the shared product state from
  // everything this run persisted. Best-effort — assembly is read-only and
  // must never affect the run result.
  try {
    await fetch(`${opts.baseUrl ?? ''}/api/runs/product-state?run=${encodeURIComponent(opts.runId)}`,
      { headers: opts.headers, signal: opts.signal })
  } catch { /* state assembly is evidence, not a gate */ }
```

- [ ] **Step 2: Typecheck + commit**

```bash
cd software/prompt-to-pcb-ui && npx tsc --noEmit
cd "/Volumes/T9 Backup/EE-lab"
git add software/prompt-to-pcb-ui/lib/product-state.ts \
        software/prompt-to-pcb-ui/app/api/runs/product-state/route.ts \
        software/prompt-to-pcb-ui/lib/run-pipeline.ts
git commit -m "orchestrator: Stage A — shared product state + declared dependency graph"
```

(If a parallel agent holds the git index, wait 5s and retry.)

---

### Task 4: Live verification on a fresh run

- [ ] **Step 1: After the next full Compose run (any product), confirm the hook fired**

```bash
LATEST=$(ls -t "/Volumes/T9 Backup/EE-lab/software/prompt-to-pcb-ui/public/runs" | head -1)
python3 -m json.tool "/Volumes/T9 Backup/EE-lab/software/prompt-to-pcb-ui/public/runs/$LATEST/product-state.json" | head -30
```

Expected: assembled state with fresh `assembledAt`, electronics section carrying real DRC numbers. If the fidelity plan has landed by then, `mechanical.summary.fidelity` and `id.render.summary.consistency` show real verdict states instead of "no … report".
