/**
 * Product design state — Phase 1 of the iteration platform.
 *
 * A PRODUCT is the durable thing an engineer iterates on; runs are builds of
 * it. This module owns the product store (data/products.json — small records
 * only, artifacts stay in the run dirs), revision lineage, and the
 * run→product tracking used by the browser pipeline, the v1 API, and
 * backfill. Decisions and pins live here too (pins consumed in Phase 2).
 *
 * Lineage source of truth: the run report (public/runs/<id>/data/
 * last-run.json) already records `parentId` for revision builds — tracking
 * reads it server-side, so no client is trusted about ancestry.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export type Decision = {
  id: string
  area: 'electronics' | 'mechanical' | 'firmware' | 'manufacturing' | 'supplyChain' | 'validation' | 'design' | 'general'
  text: string
  source: 'engineer' | 'pipeline' | 'redesign-loop'
  createdAt: string
}

export type Pin = {
  id: string
  area: 'electronics' | 'mechanical' | 'budget'
  kind: 'part' | 'board-outline' | 'connector-position' | 'enclosure-dim' | 'budget'
  value: Record<string, unknown>
  label: string
  createdAt: string
}

export type Revision = {
  runId: string
  parentRunId: string | null
  createdAt: string
  note?: string
}

export type Product = {
  productId: string
  owner: string | null // account email; null = shared/demo (mirrors run ownership)
  name: string
  prompt?: string
  boardId?: string // enterprise portfolio board (Programs bridge)
  decisions: Decision[]
  pins: Pin[]
  revisions: Revision[]
  activeRunId: string
  createdAt: string
  updatedAt: string
}

const STORE = path.join(process.cwd(), 'data', 'products.json')

export function loadProducts(): Record<string, Product> {
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'))
  } catch {
    return {}
  }
}

export function saveProducts(all: Record<string, Product>) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true })
  const tmp = `${STORE}.tmp.${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(all, null, 1))
  fs.renameSync(tmp, STORE)
}

export function getProduct(productId: string): Product | null {
  return loadProducts()[productId] ?? null
}

export function productForRun(runId: string): Product | null {
  for (const p of Object.values(loadProducts())) {
    if (p.revisions.some((r) => r.runId === runId)) return p
  }
  return null
}

export function listProducts(email: string | null): Product[] {
  // Owned products are private; unowned are shared (same rule as runs).
  return Object.values(loadProducts())
    .filter((p) => !p.owner || (email && p.owner.toLowerCase() === email.toLowerCase()))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function readRunJson(runId: string, rel: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'public', 'runs', runId, rel), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Track a run into the product store. Idempotent. Lineage comes from the
 * run's own report (parentId), never from the caller:
 *  - run already tracked            → its product (no-op)
 *  - parent tracked in a product    → append as a revision of that product
 *  - otherwise                      → new product rooted at this run
 * Returns null when the run isn't a built product yet (no spec + board).
 */
export function trackRun(runId: string, ownerEmail: string | null): Product | null {
  const spec = readRunJson(runId, 'product-spec.json')
  const board = readRunJson(runId, 'electronics/chipscale-board.json')
  if (!spec?.product && !board?.boardMm) return null

  const all = loadProducts()
  for (const p of Object.values(all)) {
    if (p.revisions.some((r) => r.runId === runId)) return p
  }

  const report = readRunJson(runId, 'data/last-run.json')
  const parentId: string | null =
    typeof report?.parentId === 'string' && report.parentId ? report.parentId : null
  const note: string | undefined =
    typeof report?.revNote === 'string' && report.revNote ? report.revNote : undefined
  const now = new Date().toISOString()
  const rev: Revision = { runId, parentRunId: parentId, createdAt: now, note }

  if (parentId) {
    for (const p of Object.values(all)) {
      if (p.revisions.some((r) => r.runId === parentId)) {
        p.revisions.push(rev)
        p.activeRunId = runId
        p.updatedAt = now
        if (spec?.product) p.name = String(spec.product).slice(0, 80)
        saveProducts(all)
        return p
      }
    }
  }

  const product: Product = {
    productId: `prod-${randomUUID()}`,
    owner: ownerEmail ? ownerEmail.toLowerCase() : null,
    name: String(spec?.product ?? report?.prompt ?? runId).slice(0, 80),
    prompt: typeof report?.prompt === 'string' ? report.prompt : undefined,
    decisions: [],
    pins: [],
    revisions: [rev],
    activeRunId: runId,
    createdAt: now,
    updatedAt: now,
  }
  all[product.productId] = product
  saveProducts(all)
  return product
}

export function updateProduct(
  productId: string,
  fn: (p: Product) => void,
): Product | null {
  const all = loadProducts()
  const p = all[productId]
  if (!p) return null
  fn(p)
  p.updatedAt = new Date().toISOString()
  saveProducts(all)
  return p
}
