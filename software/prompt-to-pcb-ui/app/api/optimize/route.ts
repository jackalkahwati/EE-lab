/**
 * Optimize — the generic "explore many designs, pick the best" step. The product
 * engine turns the finalized Product Spec into a Design Problem (variables +
 * objectives + constraints), then the domain-blind optimizer generates
 * candidates, scores them with the evaluator registry, and returns the Pareto
 * frontier + selected design. Objectives with no evaluator are carried through
 * as honest "unscored" gaps — never fabricated.
 *
 * This works for ANY product: the LLM output is just data the generic kernel
 * consumes. Same provider chain + JSON extraction as /api/architect.
 */
import { callLLMText, overrideFromHeaders, type LLMOverride } from '@/lib/llm'
import { DESIGN_PROBLEM_SCHEMA, normalizeDesignProblem, type DesignProblem } from '@/lib/design-problem'
import { optimize } from '@/lib/optimizer'
import { scorableObjectiveNames } from '@/lib/evaluators'
import type { ProductSpec } from '@/lib/product-spec'

export const dynamic = 'force-dynamic'

const SYSTEM = `detailed thinking off.
You are the design-space definer for an autonomous product-engineering platform.
Given a PRODUCT SPEC, emit a Design Problem the optimizer can search: the real
knobs to vary (variables), what to optimize (objectives), and hard requirements
(constraints). GENERAL across product categories — never assume a domain.

SCORING — the platform has these evaluators. To make an objective actually
scored, name it EXACTLY as shown and set its "evaluator" id:
- "unitCostUsd"          (min) -> "cost-analytic"      [analytic]
- "batteryHours"         (max) -> "battery-analytic"   [analytic]
- "boardAreaMm2"         (min) -> "size-analytic"      [analytic]
- "massG"                (min) -> "mass-analytic"      [analytic]
- "wearComfort"          (max) -> "comfort-surrogate"  [surrogate proxy]
- "bluetoothReliability" (max) -> "rf-surrogate"       [surrogate proxy]
- "audioQuality"         (max) -> "audio-surrogate"    [surrogate proxy]

These evaluators read canonical VARIABLES — INCLUDE the ones that apply to this
product, with realistic ranges/options so scores actually differentiate:
batteryMah (range), layers (enum e.g. [2,4,6,8]), boardAreaMm2 (range), activeMw
(enum/range), componentCount (range/enum), enclosureMaterial (enum e.g.
["ABS","PC","aluminum","silicone"]), antennaPlacement (enum e.g.
["external","edge","in-ear-tip","deep-canal"]), enclosureWallThicknessMm (range).
Add other product-specific variables too.

You MAY also list objectives with NO evaluator (e.g. thermalRise, ingressRating,
serviceability) — omit their "evaluator" field. The platform marks those
"unscored" honestly; do NOT invent a way to score them.

Emit 4-8 variables and 3-7 objectives. Output ONLY one JSON object, no prose,
no markdown fences, EXACTLY this shape:
${DESIGN_PROBLEM_SCHEMA}`

async function callLLM(userMsg: string, override?: LLMOverride): Promise<DesignProblem> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const antKey = process.env.ANTHROPIC_API_KEY
      const opts = override?.apiKey
        ? override
        : antKey
          ? { apiKey: antKey, provider: 'anthropic' as const, model: 'claude-sonnet-5' }
          : { model: 'claude-sonnet-5' }
      const { text } = await callLLMText(
        SYSTEM,
        attempt === 0 ? userMsg : userMsg + '\n\nYOUR PREVIOUS REPLY WAS NOT VALID JSON. Reply with ONLY the JSON object.',
        opts,
      )
      return normalizeDesignProblem(JSON.parse(firstJsonObject(text)))
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('design-problem model failed')
}

/** Balanced-brace extraction of the first object that looks like a design problem. */
function firstJsonObject(text: string): string {
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  let idx = t.indexOf('{')
  let n = 0
  while (idx >= 0 && n < 60) {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = idx; i < t.length; i++) {
      const ch = t[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
      } else if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          const cand = t.slice(idx, i + 1)
          try {
            const o = JSON.parse(cand)
            if (o && typeof o === 'object' && ('variables' in o || 'objectives' in o)) return cand
          } catch {
            /* try next */
          }
          break
        }
      }
    }
    idx = t.indexOf('{', idx + 1)
    n++
  }
  throw new Error('no valid design-problem JSON in model reply')
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const spec = body.spec as ProductSpec | undefined
    if (!spec?.product) return Response.json({ error: 'missing product spec' }, { status: 400 })

    const b = spec.budgets ?? {}
    const disc = Object.entries(spec.disciplines ?? {})
      .filter(([, d]) => (d as { status?: string })?.status === 'defined')
      .map(([k]) => k)
      .join(', ')
    const userMsg =
      `PRODUCT: ${spec.product}\n${spec.description || ''}\n` +
      `philosophy: ${spec.philosophy || '-'}\n` +
      `budgets: ${JSON.stringify(b)}\n` +
      `active disciplines: ${disc || '-'}\n` +
      `Define the Design Problem to explore.`

    const problem = await callLLM(userMsg, overrideFromHeaders(req.headers))
    const result = optimize(problem, { problem, spec }, 500)

    // compact payload: the frontier, the pick, and all points for a scatter
    const paretoIds = new Set(result.pareto.map((e) => e.candidate.id))
    return Response.json({
      problem,
      scoredObjectives: result.scoredObjectives,
      unscoredObjectives: result.unscoredObjectives,
      totalCombinations: result.totalCombinations,
      sampledCount: result.sampledCount,
      paretoCount: result.pareto.length,
      selected: result.selected
        ? { values: result.selected.candidate.values, scores: result.selected.scoreMap, detail: result.selected.scores }
        : null,
      points: result.evaluated.map((e) => ({
        id: e.candidate.id,
        values: e.candidate.values,
        scores: e.scoreMap,
        pareto: paretoIds.has(e.candidate.id),
        selected: e.candidate.id === result.selected?.candidate.id,
      })),
      evaluatorObjectives: Array.from(scorableObjectiveNames()),
    })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
