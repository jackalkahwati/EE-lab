/**
 * Product Architect — the top of the engineering hierarchy. Turns a natural-
 * language PRODUCT intent ("invisible AI earbud, sub-$40 BOM, all-day battery")
 * into a Product Spec: product-level budgets + a per-discipline requirement
 * block (lib/product-spec). Stateless clarifying dialogue like the board
 * interview, one tier up: the client sends the intent + answers so far, the
 * model returns the next question or a finalized spec.
 *
 * The electronics block's `boardIntent` then feeds the existing board interview
 * / Compose pipeline; every other discipline is DECLARED honestly (status),
 * never fabricated. Same provider chain + JSON extraction as /api/interview.
 */
import { callLLMText, type LLMOverride } from '@/lib/llm'
import { overrideForRequest } from '@/lib/byok'
import { assertCanSpend } from '@/lib/spend-gate'
import { MODEL } from '@/lib/model-tiers'
import { PRODUCT_SPEC_SCHEMA, normalizeSpec } from '@/lib/product-spec'
import { idBriefSummary, normalizeIdBrief, type IdBrief } from '@/lib/id-brief'
import { withKeepalive } from '@/lib/keepalive'

export const dynamic = 'force-dynamic'

// Each clarifying turn is a full model round-trip (~50s) plus the user's own
// think time, and this interview sits at the very front of a Compose run, so
// questions are expensive. Three well-chosen ones (the SYSTEM prompt orders
// them highest-impact first) pin down the product; the fourth mostly confirmed
// defaults the finalize step picks anyway. Matches /api/interview and
// /api/industrial-design, which are both already at 3.
const MAX_QUESTIONS = 3

interface Answer {
  question: string
  answer: string
}

const SYSTEM = `detailed thinking off.
You are the Product Architect for an autonomous product-engineering platform.
Given any hardware INTENT, run a short clarifying interview, then decompose it
into a Product Spec: product-level budgets and a requirement block for each
engineering discipline (electronics, mechanical, firmware, manufacturing,
supply chain, validation).

GENERAL — this is NOT specific to any product category. The same decomposition
must work for a consumer device, an industrial instrument, a robotics
subsystem, a bare PCB, or a passive mechanical part. Never assume audio,
wearables, or any domain.

ROUTING (critical) — your per-discipline "status" tells the platform which
specialist modules to invoke. Scope honestly:
- "defined": the intent genuinely REQUIRES this discipline. The platform will
  invoke that module (or hold it pending until the module exists).
- "not_applicable": the intent does NOT need this discipline; the platform skips
  it. A bare breakout PCB needs no mechanical/firmware. A passive bracket or
  enclosure needs no electronics/firmware. A firmware-only ask needs no new
  mechanical. Only mark a discipline "defined" when real engineering work in it
  is actually needed. NEVER mark a discipline "built".

PRINCIPLES:
- You own intent and budgets, not implementation. Do NOT design the PCB or the
  enclosure. State WHAT each required discipline must deliver and its slice of
  the cost / size / mass / power budgets. Omit budgets that do not apply.
- If (and only if) electronics is "defined", its block MUST include a
  "boardIntent": one concrete, buildable natural-language board request (real
  parts + function + rough size/layers) handed to the board designer. Real parts
  only, no invented ones.
- Ask about the highest-impact unknowns first, ONE at a time (what/who, target
  unit cost, size envelope, battery/runtime, production volume). Give 2-4
  concrete options and a sensible default. Keep questions short. If the intent is
  already a clear, single-discipline request (e.g. a specific breakout board),
  do not pad it — finalize quickly with the other disciplines "not_applicable".

Output ONLY one JSON object, no prose, no markdown fences.
To ask the next question:
{"enough":false,"product":"<short name>","question":"...","options":["...","..."],"default":"..."}
When product intent and budgets are pinned down (or you have asked enough),
finalize with EXACTLY this shape:
{"enough":true,"spec":${PRODUCT_SPEC_SCHEMA}}`

/** An Industrial Design brief, when present, is a HARD upstream constraint:
 *  its envelope becomes the size budget and its POV the product philosophy. */
const ID_CONSTRAINT = `\n\nAn INDUSTRIAL DESIGN brief has already been established for this product and is a HARD constraint. Respect it: its envelope IS the product size budget (budgets.sizeMm must fit within it), its aesthetic IS the product philosophy, and every discipline (electronics maxBoardMm, mechanical, etc.) must fit the given form and CMF. Do not contradict or re-open the form; design the internals to serve it.\nINDUSTRIAL DESIGN BRIEF:\n`

/** Shared provider chain (lib/llm), or the caller's own key/provider header.
 *
 *  NOTE — deliberately NOT model-split the way /api/interview is. There, `force`
 *  cleanly partitions the two jobs: the live Compose path always calls it with
 *  body.force=true (the architect's electronics hand-off), so the spec turn is
 *  always the strong tier and only the standalone board interview asks on Haiku.
 *  Here `force` means ONLY "you have used up your questions" — there is no
 *  body.force, and the SYSTEM prompt explicitly tells the model to finalize
 *  EARLY on a clear single-discipline intent. So the Product Spec is routinely
 *  emitted on a force=false turn. Putting force=false on MODEL.interviewQuestion
 *  would silently drop the quality-critical spec — which the entire downstream
 *  pipeline inherits — onto the cheap tier, precisely on the clearest intents.
 *  Splitting this safely needs the ask/finalize decision separated from artifact
 *  generation, not a `force ? strong : cheap` ternary. */
async function callLLM(userMsg: string, force: boolean, override?: LLMOverride, idConstraint?: string) {
  let sys = force
    ? SYSTEM + '\nYou have asked enough questions, you MUST finalize now (enough:true).'
    : SYSTEM
  if (idConstraint) sys += ID_CONSTRAINT + idConstraint
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Architect gates the whole flow and must emit a large structured spec,
      // which nemotron does unreliably. Anthropic handles it well, so force it
      // via the key path (the default chain falls through to nemotron in this
      // server even with a valid key). The caller's own x-llm-* override wins.
      const antKey = process.env.ANTHROPIC_API_KEY
      // Compose, don't switch: tier default first, caller override spread LAST —
      // a BYOK caller (provider+apiKey, no model) keeps the design tier, while
      // an explicit caller model still wins over it.
      const opts: LLMOverride = {
        ...(antKey ? { apiKey: antKey, provider: 'anthropic' as const } : {}),
        model: MODEL.design,
        ...override,
      }
      const { text, provider } = await callLLMText(
        sys,
        attempt === 0
          ? userMsg
          : userMsg + '\n\nYOUR PREVIOUS REPLY WAS NOT VALID JSON. Reply with ONLY the JSON object.',
        opts,
      )
      return { out: JSON.parse(firstJsonObject(text)), provider }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('architect model failed')
}

/** Find the architect object anywhere in the reply: strips reasoning tags,
 *  tries every '{' until one balances and looks like an architect turn. */
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
            if (o && typeof o === 'object' && ('enough' in o || 'question' in o || 'spec' in o)) {
              return cand
            }
          } catch {
            /* try the next start */
          }
          break
        }
      }
    }
    idx = t.indexOf('{', idx + 1)
    n++
  }
  throw new Error('no valid architect JSON in model reply')
}

/**
 * Model-backed and slow, so Cloudflare's ~100s no-bytes cap kills it over the
 * tunnel — /api/interview died there and took a whole build with it.
 * withKeepalive returns fast responses untouched. See lib/keepalive.ts.
 */
export async function POST(req: Request): Promise<Response> {
  return withKeepalive(handlePost(req))
}

async function handlePost(req: Request) {
  try {
    const body = await req.json()
    const request: string = body.request ?? ''
    const answers: Answer[] = Array.isArray(body.answers) ? body.answers : []
    if (!request.trim()) {
      return Response.json({ error: 'empty product intent' }, { status: 400 })
    }
    // Spend gate: no platform-funded inference for an account at 0 credits.
    {
      const gate = assertCanSpend(req)
      if (gate) return gate
    }
    // Optional upstream Industrial Design brief — constrains budgets + form.
    const idConstraint = body.idBrief
      ? idBriefSummary(normalizeIdBrief(body.idBrief as Partial<IdBrief>))
      : undefined

    const qa = answers
      .map((a, i) => `${i + 1}. Q: ${a.question}\n   A: ${a.answer}`)
      .join('\n')
    const userMsg =
      `Product intent: ${request}\n\n` +
      (qa ? `Clarifications so far:\n${qa}\n\n` : 'No clarifications yet.\n\n') +
      `Questions already asked: ${answers.length} of max ${MAX_QUESTIONS}.`

    const force = answers.length >= MAX_QUESTIONS
    const { out, provider } = await callLLM(userMsg, force, overrideForRequest(req), idConstraint)

    // Finalize rescue (interview's pattern): under force the model MUST
    // finalize, but it can keep replying enough:false — which used to loop the
    // client past MAX_QUESTIONS forever. Accept a structurally-valid spec even
    // when the model says enough:false; with no usable spec under force, error
    // out rather than asking question #4, #5, …
    const specOk =
      !!out.spec && typeof out.spec === 'object' &&
      typeof (out.spec as { product?: unknown }).product === 'string' &&
      (out.spec as { product: string }).product.trim().length > 0
    if (out.enough || (force && specOk)) {
      const spec = normalizeSpec(out.spec)
      return Response.json({ type: 'spec', spec, request, provider })
    }
    if (force) {
      return Response.json(
        { error: 'architect failed to finalize: max questions reached but the model returned no valid product spec' },
        { status: 500 },
      )
    }
    return Response.json({
      type: 'question',
      product: out.product ?? 'product',
      question: out.question ?? 'Any other product requirements?',
      options: Array.isArray(out.options) ? out.options : [],
      default: out.default ?? '',
      provider,
    })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
