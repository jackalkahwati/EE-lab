/**
 * Product scorecard — Stage B of the product-orchestrator roadmap.
 *
 * Aggregates what the run's REAL artifacts already say into requirement-level
 * pass/fail entries WITH MARGINS, honestly labeled by confidence:
 *   - 'measured'      — hardware-measured data (FL-1 bring-up; none yet)
 *   - 'real-sim'      — a real solver ran (FEM/CFD/modal — simulation.json fidelity fem*)
 *   - 'real-check'    — a mechanical/deterministic check over real artifacts
 *                       (KiCad DRC, converge() verification, BOM arithmetic,
 *                       the fidelity/consistency judges scoring REAL renders)
 *   - 'surrogate'     — analytic/surrogate model (link budget, energy balance)
 *   - 'llm-advisory'  — LLM-generated claims never verified against anything
 *                       (the four discipline docs)
 *
 * This module is pure and client-safe: it takes PARSED artifacts and returns
 * entries. All fs/LLM work lives in app/api/runs/scorecard/route.ts. It never
 * invents data — an absent artifact yields status 'unverified', never a pass.
 *
 * Diagnosis (Stage B's second half): validateDiagnosis() normalizes the LLM
 * diagnostician's corrective and GRAPH-VALIDATES alsoAffects against
 * affectedBy(target) so Stage C can trust the propagation list.
 */
import { DEPENDENCY_EDGES, affectedBy } from '@/lib/product-state'

export type ScorecardStatus = 'pass' | 'fail' | 'warn' | 'unverified'
export type ScorecardConfidence = 'measured' | 'real-sim' | 'real-check' | 'surrogate' | 'llm-advisory'

export interface ScorecardEntry {
  /** the requirement being checked, human-readable */
  requirement: string
  /** run-relative artifact path the verdict was read from */
  source: string
  status: ScorecardStatus
  /** the margin, e.g. "54.3C vs 43C limit" — absent when unverified */
  margin?: string
  confidence: ScorecardConfidence
  /** small excerpt for the diagnostician — NEVER the whole artifact */
  detail?: Record<string, unknown>
}

/** One corrective from the LLM diagnostician, graph-validated. */
export interface Corrective {
  /** the failing requirement this corrective addresses */
  requirement: string
  /** state field / subsystem to change — a dependency-graph node */
  target: string
  change: string
  expectedEffect: string
  /** graph-validated: always ⊆ affectedBy(target) */
  alsoAffects: string[]
  penaltyEstimate: string
  confidence: string
  provider?: string
  /** honesty trail: anything the LLM claimed that the graph rejected */
  graphRejected?: string[]
  /** set when the LLM's target is not a known graph node */
  targetInGraph: boolean
}

export interface DiagnosisBlock {
  state: 'diagnosed' | 'not-needed' | 'unverified'
  reason?: string
  correctives?: Corrective[]
  /** per-failure diagnostician errors (partial success is reported, not hidden) */
  errors?: string[]
}

export interface Scorecard {
  runId: string
  generatedAt: string
  entries: ScorecardEntry[]
  /** the failing entries, duplicated for the front page / Stage C */
  failures: ScorecardEntry[]
  summary: string
  diagnosis?: DiagnosisBlock
}

/** Parsed artifacts keyed by run-relative path (only JSON files, only present ones). */
export type ArtifactBag = Record<string, any>

const clip = (s: unknown, n = 240) => String(s ?? '').slice(0, n)
/** "°C" -> "C" so margins read like the roadmap examples ("54.3C vs 43C limit"). */
const cleanUnit = (u: unknown) => String(u ?? '').replace(/°/g, '')

// ---- entry builders (one per artifact family) --------------------------------

function drcEntries(bag: ArtifactBag): ScorecardEntry[] {
  const out: ScorecardEntry[] = []
  const drc = bag['data/drc.json']
  const cs = bag['electronics/chipscale-board.json']
  if (drc && Array.isArray(drc.violations)) {
    const errs = drc.violations.filter((v: any) => v?.severity === 'error').length
    const unc = Array.isArray(drc.unconnected_items) ? drc.unconnected_items.length : 0
    out.push({
      requirement: 'PCB passes design-rule check (DRC)',
      source: 'data/drc.json',
      status: errs === 0 && unc === 0 ? 'pass' : 'fail',
      margin: `${errs} DRC errors, ${unc} unconnected`,
      confidence: 'real-check',
      detail: { errors: errs, unconnected: unc, kicad: drc.$schema ? 'kicad drc report' : undefined },
    })
  } else if (cs?.drc?.available) {
    const d = cs.drc
    const rep = cs.drcRepair
    const types = d.errorTypes && typeof d.errorTypes === 'object'
      ? Object.entries(d.errorTypes).map(([k, v]) => `${k}:${v}`).join(', ')
      : undefined
    const ladder = rep
      ? `${rep.errorsFirst}->${rep.errorsBest} over ${rep.iterations?.length ?? '?'} strategies (won: ${rep.winningStrategy ?? '?'})`
      : undefined
    const errs = typeof d.errors === 'number' ? d.errors : undefined
    out.push({
      requirement: 'PCB passes design-rule check (DRC, chip-scale)',
      source: 'electronics/chipscale-board.json',
      status: errs === 0 ? 'pass' : errs == null ? 'unverified' : 'fail',
      margin: errs == null
        ? undefined
        : `${errs} DRC errors${types ? ` (${types})` : ''}${ladder ? ` after repair ladder ${ladder}` : ''} under ${clip(d.ruleProfile, 80)}`,
      confidence: 'real-check',
      detail: {
        errors: errs,
        errorTypes: d.errorTypes,
        repairLadder: ladder,
        unrouted: rep?.unrouted,
        verdict: clip(rep?.verdict, 400),
        fixesTried: Array.isArray(rep?.fixes) ? rep.fixes.map((f: string) => clip(f, 160)) : undefined,
        gapLadder: rep?.gapConvergence?.ladder,
        groundPlane: rep?.groundPlane,
      },
    })
  } else {
    out.push({
      requirement: 'PCB passes design-rule check (DRC)',
      source: 'data/drc.json',
      status: 'unverified',
      confidence: 'real-check',
      detail: { note: 'no DRC artifact present' },
    })
  }

  // Capability coverage through density re-planning: the replan loop records
  // exactly what it traded away — a recorded fact, surfaced not buried.
  const conv = cs?.designConvergence
  if (conv) {
    const dropped: string[] = Array.isArray(conv.droppedCapabilities) ? conv.droppedCapabilities : []
    out.push({
      requirement: 'requested capabilities preserved through board density re-planning',
      source: 'electronics/chipscale-board.json',
      status: dropped.length ? 'warn' : 'pass',
      margin: dropped.length
        ? `${dropped.length} capability(ies) dropped: ${dropped.map((c) => clip(c, 120)).join('; ')}`
        : `no capabilities dropped across ${conv.replans ?? 0} replan(s)`,
      confidence: 'real-check',
      detail: {
        replans: conv.replans,
        converged: conv.converged,
        reason: clip(conv.reason, 200),
        keptChange: clip(conv.change, 160),
        droppedCapabilities: dropped,
      },
    })
  }
  return out
}

function verificationEntry(bag: ArtifactBag): ScorecardEntry[] {
  const ver = bag['data/verification.json']
  if (!ver) return []
  const checks: any[] = Array.isArray(ver.checks) ? ver.checks : []
  const failed = checks.filter((c) => c?.passed === false)
  return [{
    requirement: 'electronics design verification converged (fit / rails / coverage)',
    source: 'data/verification.json',
    status: ver.converged === true && !failed.length ? 'pass' : 'fail',
    margin: `${checks.length - failed.length}/${checks.length} checks passed, converged=${ver.converged === true}`,
    confidence: 'real-check',
    detail: failed.length ? { failedChecks: failed.map((c) => `${c.name}: ${clip(c.detail, 140)}`) } : undefined,
  }]
}

const SIM_CONFIDENCE: Record<string, ScorecardConfidence> = {
  measured: 'measured',
  fem: 'real-sim',
  fem3d: 'real-sim',
  cfd: 'real-sim',
  'fem-acoustic': 'real-sim',
  surrogate: 'surrogate',
  analytic: 'surrogate',
}

function simulationEntries(bag: ArtifactBag): ScorecardEntry[] {
  const sim = bag['disciplines/simulation.json']
  if (!sim || !Array.isArray(sim.results)) {
    return [{
      requirement: 'multiphysics simulation gates',
      source: 'disciplines/simulation.json',
      status: 'unverified',
      confidence: 'real-sim',
      detail: { note: 'no simulation artifact present' },
    }]
  }
  return sim.results.map((r: any): ScorecardEntry => {
    const conf = SIM_CONFIDENCE[String(r.fidelity)] ?? 'surrogate'
    const u = cleanUnit(r.unit)
    const gated = r.limit != null && typeof r.pass === 'boolean'
    const assumed = Array.isArray(r.assumptions) && r.assumptions.length > 0
    const status: ScorecardStatus = !gated ? 'unverified' : r.pass ? (assumed ? 'warn' : 'pass') : 'fail'
    return {
      requirement: `simulation: ${r.sim} — ${r.metric} within limit`,
      source: 'disciplines/simulation.json',
      status,
      margin: gated
        ? `${r.value}${u} vs ${r.limit}${u} limit${assumed ? ` (hinges on: ${r.assumptions.map((a: string) => clip(a, 80)).join('; ')})` : ''}`
        : `${r.value}${u} (no limit declared — informational)`,
      confidence: conf,
      detail: { physics: r.physics, tool: r.tool, fidelity: r.fidelity, value: r.value, unit: r.unit, limit: r.limit, ...(r.detail && typeof r.detail === 'object' ? { solverDetail: r.detail } : {}), note: clip(r.note, 300) },
    }
  })
}

/** Shared shape of the two judge loops (mech fidelity, ID consistency). */
function judgeEntry(
  doc: any,
  requirement: string,
  source: string,
  absentNote: string,
): ScorecardEntry {
  if (!doc) {
    return { requirement, source, status: 'unverified', confidence: 'real-check', detail: { note: absentNote } }
  }
  const rounds: any[] = Array.isArray(doc.rounds) ? doc.rounds : []
  const scores = rounds.map((r) => r?.verdict?.score).filter((s) => typeof s === 'number')
  const last = rounds[rounds.length - 1]?.verdict
  const status: ScorecardStatus =
    doc.state === 'verified' ? 'pass' : doc.state === 'failed-threshold' ? 'fail' : 'unverified'
  return {
    requirement,
    source,
    status,
    margin: scores.length
      ? `score ${scores.join('->')} across ${rounds.length} round(s) vs threshold ${doc.threshold ?? '?'}`
      : doc.state ? `state=${doc.state}` : undefined,
    confidence: 'real-check', // deterministic loop scoring REAL renders of the real CAD; the scorer is an LLM vision judge (noted here, not hidden)
    detail: {
      state: doc.state,
      threshold: doc.threshold,
      scores,
      judge: 'LLM vision judge over real render artifacts',
      openViolations: Array.isArray(last?.violations)
        ? last.violations.slice(0, 6).map((v: any) => ({ aspect: v.aspect, expected: clip(v.expected, 160), observed: clip(v.observed, 160) }))
        : undefined,
    },
  }
}

function bomEntry(bag: ArtifactBag): ScorecardEntry[] {
  const bom = bag['data/bom.json']
  const budget = bag['product-spec.json']?.budgets?.unitCostUsd
  if (!bom) {
    return [{
      requirement: 'BOM cost within unit-cost budget',
      source: 'data/bom.json',
      status: 'unverified',
      confidence: 'real-check',
      detail: { note: 'no BOM artifact present', budgetUsd: budget ?? null },
    }]
  }
  const rows: any[] = Array.isArray(bom) ? bom : Array.isArray(bom?.rows) ? bom.rows : []
  const cost = Math.round(rows.reduce(
    (a, r) => (typeof r?.lineTotal === 'number' && isFinite(r.lineTotal) ? a + r.lineTotal : a), 0) * 100) / 100
  const gated = typeof budget === 'number'
  return [{
    requirement: 'BOM cost within unit-cost budget',
    source: 'data/bom.json',
    status: !gated ? 'unverified' : cost <= budget ? 'pass' : 'fail',
    margin: gated ? `$${cost} BOM vs $${budget} unit-cost budget` : `$${cost} BOM (no unit-cost budget in spec)`,
    confidence: 'real-check',
    detail: { lineItems: rows.length, costUsd: cost, budgetUsd: budget ?? null },
  }]
}

const DOC_DISCIPLINES = ['firmware', 'manufacturing', 'supplyChain', 'validation'] as const

function disciplineDocEntries(bag: ArtifactBag): ScorecardEntry[] {
  const out: ScorecardEntry[] = []
  for (const d of DOC_DISCIPLINES) {
    const doc = bag[`disciplines/${d}.json`]
    if (!doc) continue // a missing doc is a pipeline gap, not a requirement this scorecard can grade
    out.push({
      requirement: `${d} discipline plan documented`,
      source: `disciplines/${d}.json`,
      // present but its CLAIMS are generated, not verified against anything —
      // honest label per the roadmap: llm-advisory, never a real pass.
      status: 'unverified',
      margin: doc.fidelity ? clip(doc.fidelity, 160) : 'generated document — claims not independently verified',
      confidence: 'llm-advisory',
      detail: { title: clip(doc.title, 120), summary: clip(doc.summary, 240) },
    })
  }
  return out
}

// ---- assembly -----------------------------------------------------------------

/** Build all scorecard entries from the parsed artifact bag. Pure, honest, read-only. */
export function buildEntries(bag: ArtifactBag): ScorecardEntry[] {
  return [
    ...drcEntries(bag),
    ...verificationEntry(bag),
    ...simulationEntries(bag),
    judgeEntry(bag['disciplines/mech-fidelity.json'],
      'mechanical CAD realizes the industrial-design brief (fidelity)',
      'disciplines/mech-fidelity.json', 'no mech fidelity report'),
    judgeEntry(bag['id/consistency.json'],
      'industrial-design render consistent with the brief',
      'id/consistency.json', 'no ID consistency report'),
    ...bomEntry(bag),
    ...disciplineDocEntries(bag),
  ]
}

export function summarize(entries: ScorecardEntry[]): string {
  const n = (s: ScorecardStatus) => entries.filter((e) => e.status === s).length
  const fails = entries.filter((e) => e.status === 'fail')
  const head = `${n('pass')} pass, ${n('fail')} fail, ${n('warn')} warn, ${n('unverified')} unverified of ${entries.length} checks`
  return fails.length
    ? `${head}. FAILING: ${fails.map((f) => `${f.requirement}${f.margin ? ` (${f.margin})` : ''}`).join(' | ')}`
    : `${head}. No failing requirements.`
}

// ---- diagnosis validation -------------------------------------------------------

/** Every node the dependency graph knows: edge keys + every dependent. */
export function graphNodes(edges: Record<string, string[]> = DEPENDENCY_EDGES): string[] {
  const s = new Set<string>(Object.keys(edges))
  for (const deps of Object.values(edges)) for (const d of deps) s.add(d)
  return [...s].sort()
}

/**
 * Normalize + graph-validate one raw diagnostician reply. alsoAffects is
 * FILTERED to affectedBy(target) — anything the LLM claimed beyond the declared
 * graph is recorded in graphRejected, never silently kept (Stage C must be able
 * to trust alsoAffects blindly).
 */
export function validateDiagnosis(raw: any, requirement: string, provider?: string): Corrective {
  const target = String(raw?.target ?? '').trim()
  const targetInGraph = graphNodes().includes(target)
  const allowed = new Set(targetInGraph ? affectedBy(target) : [])
  const claimed: string[] = Array.isArray(raw?.alsoAffects) ? raw.alsoAffects.map((a: unknown) => String(a)) : []
  const kept = claimed.filter((a) => allowed.has(a))
  const rejected = claimed.filter((a) => !allowed.has(a))
  return {
    requirement,
    target,
    change: clip(raw?.change, 500),
    expectedEffect: clip(raw?.expectedEffect, 500),
    alsoAffects: kept,
    penaltyEstimate: clip(raw?.penaltyEstimate, 300),
    confidence: clip(raw?.confidence, 40),
    provider,
    ...(rejected.length ? { graphRejected: rejected } : {}),
    targetInGraph,
  }
}
