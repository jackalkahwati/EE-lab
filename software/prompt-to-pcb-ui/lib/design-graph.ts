/**
 * Discipline dependency graph + content hashing — Phase 2 of the iteration
 * platform. Encodes what run-pipeline.ts implies today: every stage's REAL
 * inputs, hashed, so an unchanged stage can be skipped ("current") instead of
 * re-run. Recorded per run in public/runs/<id>/stage-hashes.json.
 *
 * Honesty rule: a stage is only reusable when its recorded TERMINAL status
 * was 'passed' AND its inputs hash matches — a failed stage is never
 * "current", and a hash mismatch always re-runs. The whole mechanism is
 * gated behind FL_INCREMENTAL=1 until trusted.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { productForRun, type Pin } from '@/lib/design-state'

export type PipeStageName =
  | 'electronics' | 'mechanical' | 'simulation'
  | 'firmware' | 'manufacturing' | 'supplyChain' | 'validation'

export const STAGE_NAMES: PipeStageName[] = [
  'electronics', 'mechanical', 'simulation',
  'firmware', 'manufacturing', 'supplyChain', 'validation',
]

export function incrementalEnabled(): boolean {
  return process.env.FL_INCREMENTAL === '1'
}

const runPath = (runId: string, rel: string) =>
  path.join(process.cwd(), 'public', 'runs', runId, rel)

function readJson(runId: string, rel: string): any | null {
  try { return JSON.parse(fs.readFileSync(runPath(runId, rel), 'utf8')) } catch { return null }
}

function sha(v: unknown): string {
  return createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 24)
}

/** Engineer change-request text, an input to exactly the stages it targets
 *  (Phase 3 targeted edits): writing it flips those stages stale; everything
 *  else keeps its hash and skips. */
function changeRequestFor(runId: string, stage: string): unknown {
  const cr = readJson(runId, 'data/change-request.json')
  if (!cr || !Array.isArray(cr.areas)) return null
  return cr.areas.includes(stage) ? { message: cr.message, at: cr.createdAt } : null
}

/** Pins that constrain a stage (part of its input surface). */
function pinsFor(runId: string, areas: Pin['area'][]): unknown {
  const p = productForRun(runId)
  if (!p) return []
  return p.pins
    .filter((x) => areas.includes(x.area))
    .map((x) => ({ kind: x.kind, value: x.value }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

/** The SHIPPED board's identity as an input to downstream stages: geometry,
 *  part set and mounting — NOT volatile fields like timing or repair logs. */
function boardIdentity(runId: string): unknown {
  const b = readJson(runId, 'electronics/chipscale-board.json')
  if (!b) return null
  return {
    boardMm: b.boardMm, shape: b.boardShape, layers: b.layers,
    parts: (b.parts ?? []).map((p: any) => `${p.name}:${p.footprint}`).sort(),
    holes: b.mountingHoles ?? [],
    drcErrors: b.drc?.errors ?? null,
    unrouted: b.drcRepair?.unrouted ?? null,
  }
}

/**
 * Compute a stage's current inputs hash from artifacts on disk + product pins.
 * Every stage's list mirrors what its route ACTUALLY consumes.
 */
export function stageInputsHash(stage: PipeStageName, runId: string): string {
  const spec = readJson(runId, 'product-spec.json')
  switch (stage) {
    case 'electronics':
      return sha({
        elec: spec?.disciplines?.electronics ?? null,
        size: spec?.budgets?.sizeMm ?? null,
        pins: pinsFor(runId, ['electronics']),
        change: changeRequestFor(runId, 'electronics'),
      })
    case 'mechanical':
      return sha({
        board: boardIdentity(runId),
        idBrief: readJson(runId, 'disciplines/id-brief.json'),
        mech: spec?.disciplines?.mechanical ?? null,
        size: spec?.budgets?.sizeMm ?? null,
        pins: pinsFor(runId, ['mechanical']),
        change: changeRequestFor(runId, 'mechanical'),
      })
    case 'simulation':
      return sha({
        board: boardIdentity(runId),
        power: spec?.budgets?.power ?? null,
        mass: spec?.budgets?.massG ?? null,
        size: spec?.budgets?.sizeMm ?? null,
        enclosure: fs.existsSync(runPath(runId, 'mechanical/enclosure.step'))
          ? sha(fs.readFileSync(runPath(runId, 'mechanical/enclosure.step')).length)
          : null,
        change: changeRequestFor(runId, 'simulation'),
      })
    case 'firmware':
    case 'manufacturing':
    case 'supplyChain':
    case 'validation':
      return sha({
        board: boardIdentity(runId),
        spec: {
          product: spec?.product, description: spec?.description,
          budgets: spec?.budgets ?? null,
          disc: spec?.disciplines?.[stage] ?? null,
        },
        pins: pinsFor(runId, ['electronics', 'mechanical', 'budget']),
        change: changeRequestFor(runId, stage),
      })
  }
}

export type StageHashRecord = Record<string, { inputsHash: string; status: string; at: string }>

export function readStageHashes(runId: string): StageHashRecord {
  return readJson(runId, 'stage-hashes.json') ?? {}
}

export function recordStageHash(runId: string, stage: PipeStageName, status: string) {
  const all = readStageHashes(runId)
  all[stage] = { inputsHash: stageInputsHash(stage, runId), status, at: new Date().toISOString() }
  fs.writeFileSync(runPath(runId, 'stage-hashes.json'), JSON.stringify(all, null, 1))
}

/** Is a stage's persisted artifact current (inputs unchanged since it last
 *  PASSED)? Only ever true with FL_INCREMENTAL=1. */
export function stageCurrent(runId: string, stage: PipeStageName): { current: boolean; reason: string } {
  if (!incrementalEnabled()) return { current: false, reason: 'incremental disabled' }
  const rec = readStageHashes(runId)[stage]
  if (!rec) return { current: false, reason: 'no recorded build' }
  if (rec.status !== 'passed') return { current: false, reason: `last build ${rec.status}` }
  const now = stageInputsHash(stage, runId)
  if (now !== rec.inputsHash) return { current: false, reason: 'inputs changed' }
  return { current: true, reason: `unchanged since ${rec.at}` }
}
