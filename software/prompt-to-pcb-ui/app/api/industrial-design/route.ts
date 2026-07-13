/**
 * Industrial Design — the FIRST stage of the pipeline, one tier above the
 * Product Architect. Turns a natural-language product INTENT into a structured
 * ID brief (lib/id-brief): form factor, ergonomics, CMF, rough envelope, and an
 * aesthetic point of view. Stateless clarifying dialogue like the board
 * interview and the architect: the client sends the intent + answers so far, the
 * model returns the next question or a finalized brief.
 *
 * The brief then constrains the Product Architect (envelope -> size budget, POV
 * -> product philosophy), so every downstream discipline inherits one coherent
 * form. Pure LLM — no geometry yet. Same provider chain + JSON extraction as
 * /api/architect.
 */
import { callLLMText, overrideFromHeaders, type LLMOverride } from '@/lib/llm'
import { ID_BRIEF_SCHEMA, normalizeIdBrief } from '@/lib/id-brief'
import { loadGroundBoard } from '@/lib/ground-board'

export const dynamic = 'force-dynamic'

const MAX_QUESTIONS = 3

interface Answer {
  question: string
  answer: string
}

const SYSTEM = `detailed thinking off.
You are the Industrial Designer for an autonomous product-engineering platform —
the FIRST stage, above the Product Architect. Given any hardware INTENT, run a
short clarifying interview, then decompose it into an Industrial Design brief:
form factor, ergonomics, CMF (color/material/finish), a rough outer envelope in
millimetres, and an aesthetic point of view.

GENERAL — this is NOT specific to any product category. The same reasoning must
work for a consumer wearable, an industrial instrument, a robotics subsystem, a
bare PCB in a case, or a passive mechanical part. Never assume audio, wearables,
or any domain.

YOU OWN FORM, NOT INTERNALS. Decide how the product looks, feels, is held/worn/
mounted, its material and finish, and its outer size envelope. Do NOT design the
PCB, the firmware, or internal mechanisms — that is the Architect and the
specialists downstream. Your envelope and constraints become HARD inputs for
them, so make the envelope physically plausible for what the intent implies
(leave room for the electronics, battery, and walls you would expect).

If the intent is a bare board or a purely functional module with no meaningful
industrial design (no housing, no human touchpoints), say so: return a minimal
brief with formFactor like "bare PCB, no enclosure" and an envelope matching the
board — do not invent an aesthetic it does not need.

Ask about the highest-impact unknowns first, ONE at a time (who/where it is used,
how it is held/worn/mounted, size or pocketability, environment/ruggedness).
Give 2-4 concrete options and a sensible default. Keep questions short. If the
intent already implies a clear form, do not pad it — finalize quickly.

Output ONLY one JSON object, no prose, no markdown fences.
To ask the next question:
{"enough":false,"product":"<short name>","question":"...","options":["...","..."],"default":"..."}
When the form is pinned down (or you have asked enough), finalize with EXACTLY:
{"enough":true,"brief":${ID_BRIEF_SCHEMA}}`

/** When the electronics board is already built, its real footprint is a HARD
 *  floor on the envelope — the form must physically contain the achievable
 *  geometry, never promise something smaller than the board. */
function boardGround(rb: { wMm?: number; hMm?: number; layers?: number; components?: number } | undefined): string {
  if (!rb || !rb.wMm || !rb.hMm) return ''
  const w = Math.round(rb.wMm)
  const h = Math.round(rb.hMm)
  return (
    `\n\nGROUNDING — the electronics board for this product is ALREADY BUILT and FIXED at these REAL dimensions: ${w} × ${h} mm` +
    (rb.layers ? `, ${rb.layers}-layer` : '') +
    (rb.components ? `, ${rb.components} components` : '') +
    `. Your envelope MUST physically contain this board plus enclosure walls, a battery, and clearances: envelopeMm.x must be >= ${w + 4}, envelopeMm.y >= ${h + 4}, and envelopeMm.z must leave room for the board + component + battery stack (typically >= 10). NEVER propose an envelope smaller than the board footprint — design the form AROUND this achievable geometry. If the board is larger than the intent implied, say so honestly in the rationale.`
  )
}

/** Shared provider chain (lib/llm), or the caller's own key/provider header.
 *  Forces Anthropic like the architect — the structured brief is emitted
 *  unreliably by the default nemotron fallback. */
async function callLLM(userMsg: string, force: boolean, override?: LLMOverride, ground?: string) {
  let sys = force
    ? SYSTEM + '\nYou have asked enough questions, you MUST finalize now (enough:true).'
    : SYSTEM
  if (ground) sys += ground
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const antKey = process.env.ANTHROPIC_API_KEY
      const opts = override?.apiKey
        ? override
        : antKey
          ? { apiKey: antKey, provider: 'anthropic' as const, model: 'claude-sonnet-5' }
          : { model: 'claude-sonnet-5' }
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
  throw lastErr ?? new Error('industrial-design model failed')
}

/** Find the brief/question object anywhere in the reply: strips reasoning tags,
 *  tries every '{' until one balances and looks like an ID turn. */
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
            if (o && typeof o === 'object' && ('enough' in o || 'question' in o || 'brief' in o)) {
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
  throw new Error('no valid industrial-design JSON in model reply')
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const request: string = body.request ?? ''
    const answers: Answer[] = Array.isArray(body.answers) ? body.answers : []
    if (!request.trim()) {
      return Response.json({ error: 'empty product intent' }, { status: 400 })
    }

    const qa = answers
      .map((a, i) => `${i + 1}. Q: ${a.question}\n   A: ${a.answer}`)
      .join('\n')
    const userMsg =
      `Product intent: ${request}\n\n` +
      (qa ? `Clarifications so far:\n${qa}\n\n` : 'No clarifications yet.\n\n') +
      `Questions already asked: ${answers.length} of max ${MAX_QUESTIONS}.`

    // force:true lets the Design tab finalize a brief in ONE click (no interview),
    // the same one-click behaviour every other discipline has.
    const force = body.force === true || answers.length >= MAX_QUESTIONS
    // Ground on the chip-scale board (like every discipline) when a runId is given,
    // else fall back to whatever realBoard the caller passed.
    let ground = boardGround(body.realBoard)
    if (typeof body.runId === 'string' && /^run-[A-Za-z0-9._-]{1,128}$/.test(body.runId)) {
      const gb = await loadGroundBoard(body.runId)
      if (gb) ground = boardGround({ wMm: gb.wMm, hMm: gb.hMm, layers: gb.layers, components: gb.components })
    }
    const { out, provider } = await callLLM(userMsg, force, overrideFromHeaders(req.headers), ground)

    if (out.enough) {
      const brief = normalizeIdBrief(out.brief)
      return Response.json({ type: 'brief', brief, request, provider })
    }
    return Response.json({
      type: 'question',
      product: out.product ?? 'product',
      question: out.question ?? 'Any other form or ergonomics requirements?',
      options: Array.isArray(out.options) ? out.options : [],
      default: out.default ?? '',
      provider,
    })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 })
  }
}
