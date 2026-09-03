/**
 * GET /api/runs/scorecard?run=<id>              -> assemble + persist + return
 * GET /api/runs/scorecard?run=<id>&diagnose=1   -> also run the LLM root-cause
 *                                                  diagnostician over failures
 *
 * Stage B of the product-orchestrator roadmap: the run's requirement-level
 * scorecard WITH MARGINS, read from the REAL artifacts (KiCad DRC + repair
 * ladder, real-solver sim results vs limits, fidelity/consistency judge
 * verdicts, BOM cost vs budget), honestly confidence-labeled. Read-only over
 * the run: it never invents data — absent artifact = 'unverified'.
 *
 * Diagnosis: for EACH failing entry the diagnostician gets the entry, its
 * artifact excerpt, and the DECLARED dependency-graph slice, and must return
 * the SMALLEST corrective as strict JSON. alsoAffects is graph-validated
 * (⊆ affectedBy(target)) so Stage C can trust it. If no LLM is reachable the
 * scorecard still ships, with diagnosis {state:'unverified', reason} — the
 * honest degrade, never a fabricated corrective.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { sessionEmail } from '@/lib/auth'
import { overrideForRequest } from '@/lib/byok'
import { callLLMText, type LLMOverride } from '@/lib/llm'
import { MODEL } from '@/lib/model-tiers'
import { DEPENDENCY_EDGES, affectedBy, type ProductState } from '@/lib/product-state'
import {
  buildEntries,
  graphNodes,
  summarize,
  validateDiagnosis,
  type ArtifactBag,
  type Corrective,
  type Scorecard,
  type ScorecardEntry,
} from '@/lib/scorecard'

export const dynamic = 'force-dynamic'
// Diagnosis worst case: up to MAX_DIAGNOSES CLI calls; the dev-only Claude CLI
// wall is 300s per call but real calls run well under it. maxDuration is a
// serverless cap that does not bind a local dev server (mechanical/route.ts
// sets the precedent).
export const maxDuration = 600

// Same shape as lib/auth.ts isValidRunId: a leading alphanumeric rules out
// '.', '..' and dotfiles, so the id can never walk out of public/runs/.
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_DIAGNOSES = 6

/** Everything the scorecard drills into. Union of the Stage A section sources we grade. */
const ARTIFACTS = [
  'product-spec.json',
  'data/drc.json',
  'data/verification.json',
  'data/bom.json',
  'electronics/chipscale-board.json',
  'disciplines/simulation.json',
  'disciplines/mech-fidelity.json',
  'id/consistency.json',
  'disciplines/firmware.json',
  'disciplines/manufacturing.json',
  'disciplines/supplyChain.json',
  'disciplines/validation.json',
] as const

async function readBag(runDir: string): Promise<ArtifactBag> {
  const bag: ArtifactBag = {}
  for (const rel of ARTIFACTS) {
    try {
      bag[rel] = JSON.parse(await fs.readFile(path.join(runDir, rel), 'utf8'))
    } catch { /* absent or non-JSON — the builders treat it as unverified, never faked */ }
  }
  return bag
}

/**
 * Read the run's product-state.json; if Stage A hasn't assembled it yet, ask
 * the product-state route to (internal fetch forwarding THIS request's cookie
 * — the route persists the file as a side effect and returns the state).
 */
async function productState(req: Request, runDir: string, runId: string): Promise<ProductState | null> {
  const statePath = path.join(runDir, 'product-state.json')
  try {
    return JSON.parse(await fs.readFile(statePath, 'utf8'))
  } catch { /* not assembled yet */ }
  try {
    const origin = new URL(req.url).origin
    const r = await fetch(`${origin}/api/runs/product-state?run=${encodeURIComponent(runId)}`, {
      headers: { cookie: req.headers.get('cookie') ?? '' },
    })
    if (r.ok) return (await r.json()) as ProductState
  } catch { /* state assembly is best-effort; the scorecard grades artifacts directly */ }
  return null
}

// ---- diagnostician ------------------------------------------------------------

const DIAG_SYSTEM = `detailed thinking off.
You are the root-cause diagnostician for an autonomous product-engineering
platform. You receive ONE failing requirement from a product scorecard: the
check's margin, an excerpt of the real artifact behind it, and the product's
DECLARED dependency graph (edges: changing KEY invalidates the listed
dependents; affectedBy(t) is the transitive closure).

SMALLEST-CHANGE PRINCIPLE (non-negotiable): propose the single smallest change
that plausibly clears THIS failure. Prefer parameter/value changes over
topology changes, one-subsystem changes over cross-cutting ones, and soft
tradeoffs over dropping required capability. Never propose "re-run the stage"
— name what to CHANGE and why it clears the margin.

Reply with STRICT JSON only — one object, no prose, no markdown fences:
{
 "target": <EXACTLY one node from VALID TARGETS below — the state field/subsystem to change>,
 "change": <the concrete smallest change, with values where possible>,
 "expectedEffect": <why this clears the failing margin, quantified when the excerpt allows>,
 "alsoAffects": <array — MUST be a subset of the given affectedBy(target) list; [] if nothing else is impacted>,
 "penaltyEstimate": <the honest cost of the change: capability, cost, size, schedule>,
 "confidence": <"high"|"medium"|"low">
}
Ground every claim in the provided excerpt — do not invent measurements.`

function diagUser(
  entry: ScorecardEntry,
  bag: ArtifactBag,
  graph: Record<string, string[]>,
): string {
  const spec = bag['product-spec.json']
  const nodes = graphNodes(graph)
  const slice = nodes.map((n) => `${n} -> affectedBy: [${affectedBy(n, graph).join(', ')}]`).join('\n')
  return [
    `PRODUCT: ${spec?.product ?? 'unknown'} — budgets: ${JSON.stringify(spec?.budgets ?? {})}`,
    '',
    'FAILING SCORECARD ENTRY:',
    JSON.stringify({ requirement: entry.requirement, source: entry.source, margin: entry.margin, confidence: entry.confidence }, null, 1),
    '',
    'ARTIFACT EXCERPT (real data behind the failure):',
    JSON.stringify(entry.detail ?? {}, null, 1).slice(0, 4000),
    '',
    'DECLARED DEPENDENCY EDGES (change KEY -> invalidates):',
    JSON.stringify(graph, null, 1),
    '',
    `VALID TARGETS: ${nodes.join(', ')}`,
    '',
    'TRANSITIVE affectedBy PER TARGET (alsoAffects MUST be a subset of your target\'s list):',
    slice,
  ].join('\n')
}

/** First balanced JSON object in the reply that has a "target" key. */
function firstDiagnosisJson(text: string): any {
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  let idx = t.indexOf('{')
  let n = 0
  while (idx >= 0 && n < 60) {
    let depth = 0, inStr = false, esc = false
    for (let i = idx; i < t.length; i++) {
      const ch = t[i]
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false }
      else if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) {
        const cand = t.slice(idx, i + 1)
        try { const o = JSON.parse(cand); if (o && typeof o === 'object' && 'target' in o) return o } catch { /* next */ }
        break
      } }
    }
    idx = t.indexOf('{', idx + 1); n++
  }
  throw new Error('no valid diagnosis JSON in model reply')
}

async function diagnoseOne(
  entry: ScorecardEntry,
  bag: ArtifactBag,
  graph: Record<string, string[]>,
  override?: LLMOverride,
): Promise<Corrective> {
  const userMsg = diagUser(entry, bag, graph)
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const antKey = process.env.ANTHROPIC_API_KEY
      // Same composition as mechanical/route.ts: platform key as the default
      // override (lib/llm treats a key matching the env as "platform" and
      // prefers the Claude CLI when USE_CLAUDE_CODE_CLI is set — the CLI child
      // env is stripped of ANTHROPIC_API_KEY inside claudeCodeCall), while a
      // real BYOK caller still wins via the spread.
      const opts: LLMOverride = {
        ...(antKey ? { apiKey: antKey, provider: 'anthropic' as const } : {}),
        model: MODEL.design,
        ...override,
      }
      const { text, provider } = await callLLMText(
        DIAG_SYSTEM,
        attempt === 0 ? userMsg : userMsg + '\n\nYOUR PREVIOUS REPLY WAS NOT VALID JSON. Reply with ONLY the JSON object.',
        opts,
      )
      return validateDiagnosis(firstDiagnosisJson(text), entry.requirement, provider)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('diagnostician failed')
}

// ---- route ----------------------------------------------------------------------

export async function GET(req: Request) {
  if (!sessionEmail(req)) return Response.json({ error: 'sign in required' }, { status: 401 })
  const url = new URL(req.url)
  const runId = url.searchParams.get('run') ?? ''
  if (!RUN_ID.test(runId)) return Response.json({ error: 'bad run id' }, { status: 400 })
  const runDir = path.join(process.cwd(), 'public', 'runs', runId)
  try {
    await fs.access(runDir)
  } catch {
    return Response.json({ error: 'unknown run' }, { status: 404 })
  }

  // Stage A state: assemble if absent (also gives us the run's declared graph).
  const state = await productState(req, runDir, runId)
  const graph = state?.graph ?? DEPENDENCY_EDGES

  const bag = await readBag(runDir)
  const entries = buildEntries(bag)
  const failures = entries.filter((e) => e.status === 'fail')

  const scorecard: Scorecard = {
    runId,
    generatedAt: new Date().toISOString(),
    entries,
    failures,
    summary: summarize(entries),
  }

  if (url.searchParams.get('diagnose') === '1') {
    if (!failures.length) {
      scorecard.diagnosis = { state: 'not-needed', reason: 'no failing requirements' }
    } else {
      const override = overrideForRequest(req)
      const correctives: Corrective[] = []
      const errors: string[] = []
      for (const f of failures.slice(0, MAX_DIAGNOSES)) {
        try {
          correctives.push(await diagnoseOne(f, bag, graph, override))
        } catch (e) {
          errors.push(`${f.requirement}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (failures.length > MAX_DIAGNOSES) {
        errors.push(`${failures.length - MAX_DIAGNOSES} failure(s) beyond the ${MAX_DIAGNOSES}-diagnosis cap were not diagnosed`)
      }
      scorecard.diagnosis = correctives.length
        ? { state: 'diagnosed', correctives, ...(errors.length ? { errors } : {}) }
        : { state: 'unverified', reason: `diagnostician unavailable: ${errors[0] ?? 'unknown'}`, ...(errors.length ? { errors } : {}) }
    }
  }

  try {
    await fs.writeFile(path.join(runDir, 'scorecard.json'), JSON.stringify(scorecard, null, 1))
  } catch { /* persistence is best-effort; the response is authoritative */ }

  return Response.json(scorecard)
}
