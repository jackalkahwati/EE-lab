/**
 * Edit intent classifier (Phase 3) — the cmd-K router. A revise message is
 * classified (cheap model tier) into the stages it actually touches plus an
 * optional spec-budget patch, so a small change becomes a targeted fork +
 * incremental rebuild instead of a full redesign. Anything electronics-level
 * or ambiguous falls back to the full architect revise path — the router
 * must never silently narrow a change that needs the whole pipeline.
 */
import { callLLMText, type LLMOverride } from '@/lib/llm'
import { MODEL } from '@/lib/model-tiers'

export type EditScope = 'electronics' | 'mechanical' | 'simulation' | 'firmware' | 'manufacturing' | 'supplyChain' | 'validation'

export type EditIntent = {
  scope: EditScope[]
  /** partial budgets patch (only budget-level edits), applied to product-spec */
  specPatch?: { budgets?: Record<string, unknown> }
  note: string
  /** false → the chat should use the full architect revise path */
  targetable: boolean
}

const SYSTEM = `detailed thinking off.
You route an engineer's change request on an ALREADY-BUILT hardware product to
the pipeline stages it invalidates. Stages: electronics (PCB parts/nets/board),
mechanical (enclosure CAD), simulation (thermal/structural physics), firmware,
manufacturing, supplyChain, validation (docs).

Rules:
- Any change to parts, circuits, connectors, sensors, the board itself, or
  product FUNCTION → include "electronics" (downstream stages follow it
  automatically; do not list them).
- Enclosure form/wall/height/finish/material changes → "mechanical" +
  "simulation" (+ validation if testability changes).
- Pure budget changes (cost, mass, power, battery, volume) → the stages that
  consume that budget, plus a specPatch with ONLY the changed budget fields
  matching this shape: {"budgets":{"unitCostUsd":n,"massG":n,"volumeUnits":n,
  "sizeMm":{"x":n,"y":n,"z":n},"power":{"activeMw":n,"sleepUw":n,"batteryMah":n,
  "runtimeHours":n}}} (subset only).
- Doc-only asks (regenerate/expand a plan) → just that stage.
- When unsure, include "electronics" — over-scoping is safe, under-scoping
  ships a stale design.

Output ONLY one JSON object:
{"scope":["..."],"specPatch":{...}|null,"note":"<one line: what changes>"}`

const SCOPES: EditScope[] = ['electronics', 'mechanical', 'simulation', 'firmware', 'manufacturing', 'supplyChain', 'validation']

export async function classifyEdit(
  message: string,
  productSummary: string,
  override?: LLMOverride,
): Promise<EditIntent> {
  const { text } = await callLLMText(
    SYSTEM,
    `PRODUCT: ${productSummary}\n\nCHANGE REQUEST: ${message}\n\nRoute it.`,
    { model: MODEL.interviewQuestion, ...override },
  )
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('edit router returned no JSON')
  const out = JSON.parse(m[0])
  const scope = (Array.isArray(out.scope) ? out.scope : [])
    .filter((s: string): s is EditScope => SCOPES.includes(s as EditScope))
  if (!scope.length) scope.push('electronics') // unroutable → widest honest scope
  const specPatch = out.specPatch && typeof out.specPatch === 'object' && out.specPatch.budgets
    ? { budgets: out.specPatch.budgets as Record<string, unknown> }
    : undefined
  return {
    scope,
    specPatch,
    note: String(out.note ?? message).slice(0, 200),
    // electronics-level changes rebuild the product through the architect —
    // the targeted path only handles downstream-scoped edits.
    targetable: !scope.includes('electronics'),
  }
}
