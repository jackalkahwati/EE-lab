/**
 * Work queue harvester (Phase 3) — turns the honest flags the pipeline
 * already produces into an actionable list. Every item traces to a real
 * artifact field; nothing is invented, and resolving an item routes back
 * through the normal engineering flow (chat → targeted re-run).
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export type WorkItem = {
  id: string
  area: 'electronics' | 'mechanical' | 'simulation' | 'firmware' | 'manufacturing' | 'supplyChain' | 'validation' | 'design'
  text: string
  severity: 'blocking' | 'advisory'
  source: string // artifact path + field the item traces to
}

const GAP_RX = /\bunspecified|not specified|not defined|undefined|incomplete|unaddressed|unknown|unnamed|missing|verify manually|establish baseline|TBD\b/i

function itemId(area: string, text: string): string {
  return 'wi-' + createHash('sha256').update(`${area}|${text}`).digest('hex').slice(0, 10)
}

async function readJson(runId: string, rel: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(
      path.join(process.cwd(), 'public', 'runs', runId, rel), 'utf8'))
  } catch {
    return null
  }
}

export async function harvestWorkItems(runId: string): Promise<WorkItem[]> {
  const items: WorkItem[] = []
  const push = (area: WorkItem['area'], text: string, severity: WorkItem['severity'], source: string) => {
    const t = text.trim().slice(0, 240)
    if (!t) return
    const id = itemId(area, t)
    if (!items.some((x) => x.id === id)) items.push({ id, area, text: t, severity, source })
  }

  // Electronics: the shipped board's real DRC state
  const board = await readJson(runId, 'electronics/chipscale-board.json')
  if (board) {
    const errs = board.drc?.errors ?? null
    if (typeof errs === 'number' && errs > 0) {
      push('electronics', `${errs} DRC error(s) on the shipped board`, 'blocking', 'electronics/chipscale-board.json:drc.errors')
    }
    const unrouted = board.drcRepair?.unrouted ?? 0
    if (unrouted > 0) {
      push('electronics', `${unrouted} net(s) unrouted`, 'blocking', 'electronics/chipscale-board.json:drcRepair.unrouted')
    }
  }

  // Mechanical: fit + skipped ops
  const mech = await readJson(runId, 'mechanical/mechanical.json')
  if (mech) {
    if (mech.fitCheck && mech.fitCheck.fits === false) {
      // Report the CAVITY the board was tested against, never the outer body
      // (the old message printed enclosureMm, which misled the redesign loop).
      const fc = mech.fitCheck
      const cav = fc.cavityMm ?? fc.enclosureMm
      const first = Array.isArray(fc.problems) && fc.problems.length ? fc.problems[0] : null
      push('mechanical', first ?? `PCB does not fit the enclosure cavity (${fc.pcbMm?.w}×${fc.pcbMm?.h} vs cavity ${cav?.w}×${cav?.h} mm)`, 'blocking', 'mechanical/mechanical.json:fitCheck')
    } else if (mech.fitCheck && mech.fitCheck.verdict === 'unknown') {
      push('mechanical', mech.fitCheck.problems?.[0] ?? 'PCB fit not verified: no board cavity identified in the plan', 'advisory', 'mechanical/mechanical.json:fitCheck')
    }
    for (const f of mech.opsFailed ?? []) {
      push('mechanical', `CAD op skipped: ${f.op} (${f.error})`, 'advisory', 'mechanical/mechanical.json:opsFailed')
    }
    if (mech.fastening?.mode === 'snap-fit') {
      push('mechanical', 'Snap-fit rendered as plain posts — verify engagement manually', 'advisory', 'mechanical/mechanical.json:fastening')
    }
  }

  // Simulation: failures, gated domains, assumptions
  const sim = await readJson(runId, 'disciplines/simulation.json')
  for (const r of sim?.results ?? []) {
    if (r.error) continue
    if (r.pass === false) {
      push('simulation', `${r.sim}: ${r.value} ${r.unit ?? ''} exceeds limit ${r.limit}`, 'blocking', 'disciplines/simulation.json:pass')
    }
    if (r.fidelity === 'gated') {
      push('simulation', `${r.sim} is install-gated (${r.tool})`, 'advisory', 'disciplines/simulation.json:fidelity')
    }
    for (const a of r.assumptions ?? []) {
      push('simulation', `${r.sim}: assumption — ${a}`, 'advisory', 'disciplines/simulation.json:assumptions')
    }
  }

  // Redesign loop: capability gaps are first-class engineering work
  const redesign = await readJson(runId, 'disciplines/redesign.json')
  for (const g of redesign?.capabilityGaps ?? []) {
    push('design', `capability gap (${g.module ?? 'module'}): ${g.gap ?? g.violation ?? ''}`, 'blocking', 'disciplines/redesign.json:capabilityGaps')
  }

  // FL-1 measured results (Phase 6): a failed test is blocking, full stop —
  // it's physical evidence, the strongest signal in the whole queue.
  const vres = await readJson(runId, 'disciplines/validation-results.json')
  for (const r of vres?.results ?? []) {
    if (r.outcome === 'fail') {
      push('validation',
        `MEASURED FAIL: ${r.test}${r.measured ? ` (${r.measured})` : ''}${r.notes ? ` — ${r.notes}` : ''}`,
        'blocking', 'disciplines/validation-results.json')
    }
  }

  // Docs: structured gaps[] when present (new contract), else honest-flag text
  for (const disc of ['firmware', 'manufacturing', 'supplyChain', 'validation'] as const) {
    const doc = await readJson(runId, `disciplines/${disc}.json`)
    if (!doc) continue
    if (Array.isArray(doc.gaps) && doc.gaps.length) {
      for (const g of doc.gaps.slice(0, 8)) {
        push(disc, String(g.text ?? g), g.blocking ? 'blocking' : 'advisory', `disciplines/${disc}.json:gaps`)
      }
      continue
    }
    let n = 0
    for (const sec of doc.sections ?? []) {
      for (const it of sec.items ?? []) {
        if (typeof it === 'string' && GAP_RX.test(it) && n < 5) {
          push(disc, it, 'advisory', `disciplines/${disc}.json:sections`)
          n++
        }
      }
    }
  }

  return items
}

/** Harvest + persist. Called at pipeline end and on demand. */
export async function writeWorkItems(runId: string): Promise<WorkItem[]> {
  const items = await harvestWorkItems(runId)
  const dir = path.join(process.cwd(), 'public', 'runs', runId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'work-items.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), items }, null, 1))
  return items
}
