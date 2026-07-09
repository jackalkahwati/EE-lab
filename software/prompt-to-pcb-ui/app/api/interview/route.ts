/**
 * Design Interview, Layer 1. Turns a vague natural-language board request into
 * a complete, structured design spec through a clarifying dialogue. Driven by
 * NVIDIA Nemotron (frontier-grade reasoning, hosted API). Stateless: the client
 * sends the request + the answers so far each turn; the model returns either the
 * next question or a finalized spec.
 */
import { callLLMText, overrideFromHeaders, type LLMOverride } from '@/lib/llm'
import capabilities from '@/lib/block-capabilities.json'

export const dynamic = 'force-dynamic'

// The builder's real block menu (generated from compose.py --capabilities). We
// show it to the interviewer so it proposes ONLY blocks the library can build,
// named with the actual part/function — instead of generic categories
// ("sensors", "connectors", "protection") or hallucinated blocks (imu, motors
// on a board with neither) that the composer then silently drops.
const BLOCK_MENU = (capabilities.blocks as { key: string; label: string }[])
  .map((b) => `- ${b.label}`)
  .join('\n')

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions'
const MAX_QUESTIONS = 4

interface Answer {
  question: string
  answer: string
}

// Which generator builds this spec. 'matrix' = the FL-1 relay/probe gen_board
// path; 'compose' = the Layer-2 block-composition engine (MCU + radio + power +
// sensor + ...). Every spec gets a generator, so the interview always ends with
// a Generate Board button.
function generatorFor(boardClass: string, blocks: string[]): 'matrix' | 'compose' {
  const hay = (boardClass + ' ' + blocks.join(' ')).toLowerCase()
  return /relay|probe|matrix|crosspoint|switch ?matrix/.test(hay) ? 'matrix' : 'compose'
}

const SYSTEM = `detailed thinking off.
You are an expert PCB design interviewer for an automated prompt-to-PCB tool.
Given a board request, run a short clarifying interview, then output the
functional blocks the board needs.

The downstream builder can ONLY build these blocks — this is the exact menu:
${BLOCK_MENU}

BLOCK RULES (critical — the builder silently drops anything it can't map):
- Every entry in "blocks" MUST correspond to something on the menu above.
- Name each block with the SPECIFIC part or measurand from the request, e.g.
  "BME280 environmental sensor", "RP2040 MCU", "USB-C power", "LoRa radio 915MHz"
  — NOT generic words like "sensors", "connectors", or "protection".
- Preserve any part number the user gave (BME280, MAX31855, INA219, RP2040…).
- Include ONLY blocks the request actually needs. Do NOT add IMU, motors, radio,
  GNSS, cellular, etc. unless the user asked for them.
- Do NOT emit "connectors" or "protection" as standalone blocks — connectors and
  protection are built into the power / bus / header blocks automatically.
- For any sensor not explicitly on the menu, name the specific I2C part or
  measurand (e.g. "SHT31 humidity sensor", "VL53L0X time-of-flight") — the
  builder synthesizes I2C sensors by name.

Ask about the highest-impact unknowns first, ONE at a time (MCU family, power
source/voltage, radio band, which specific sensors/parts). Always give 2-4
concrete options and a sensible default. Keep questions short.

Output ONLY one JSON object, no prose, no markdown fences.
To ask the next question:
{"enough":false,"board_class":"<short name>","blocks":["..."],"question":"...","options":["...","..."],"default":"..."}
When the key blocks and their main parameters are pinned down (or you have asked
enough), finalize:
{"enough":true,"board_class":"<short name>","blocks":["..."],"spec":{"<param>":"<value>"},"summary":"<one sentence>"}`

/** Shared provider chain (lib/llm): OpenAI -> Anthropic -> Gemini -> Nemotron,
 *  or the caller's own key/provider via x-llm-provider / x-llm-key headers. */
async function callLLM(userMsg: string, force: boolean, override?: LLMOverride) {
  const sys = force
    ? SYSTEM + '\nYou have asked enough questions, you MUST finalize now (enough:true).'
    : SYSTEM
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text, provider } = await callLLMText(
        sys,
        attempt === 0
          ? userMsg
          : userMsg + '\n\nYOUR PREVIOUS REPLY WAS NOT VALID JSON. Reply with ONLY the JSON object.',
        override,
      )
      return { out: JSON.parse(firstJsonObject(text)), provider }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('interview model failed')
}

/** Find the interview object anywhere in the reply: strips reasoning tags,
 *  tries every '{' until one balances, parses, and looks like an interview
 *  turn. Tolerates prose, fences, and truncated preambles. */
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
            if (o && typeof o === 'object' && ('enough' in o || 'question' in o || 'blocks' in o)) {
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
  throw new Error('no valid interview JSON in model reply')
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const request: string = body.request ?? ''
    const answers: Answer[] = Array.isArray(body.answers) ? body.answers : []
    if (!request.trim()) {
      return Response.json({ error: 'empty request' }, { status: 400 })
    }

    const qa = answers
      .map((a, i) => `${i + 1}. Q: ${a.question}\n   A: ${a.answer}`)
      .join('\n')
    const userMsg =
      `Board request: ${request}\n\n` +
      (qa ? `Clarifications so far:\n${qa}\n\n` : 'No clarifications yet.\n\n') +
      `Questions already asked: ${answers.length} of max ${MAX_QUESTIONS}.`

    const force = answers.length >= MAX_QUESTIONS
    const { out, provider } = await callLLM(userMsg, force, overrideFromHeaders(req.headers))

    const blocks: string[] = Array.isArray(out.blocks) ? out.blocks : []
    const boardClass: string = out.board_class ?? 'custom board'

    if (out.enough) {
      return Response.json({
        type: 'spec',
        boardClass,
        blocks,
        spec: out.spec ?? {},
        summary: out.summary ?? '',
        method: generatorFor(boardClass, blocks),
        request,
        provider,
      })
    }
    return Response.json({
      type: 'question',
      boardClass,
      blocks,
      question: out.question ?? 'Any other requirements?',
      options: Array.isArray(out.options) ? out.options : [],
      default: out.default ?? '',
      provider,
    })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 })
  }
}
