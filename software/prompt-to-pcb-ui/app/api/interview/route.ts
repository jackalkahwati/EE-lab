/**
 * Design Interview, Layer 1. Turns a vague natural-language board request into
 * a complete, structured design spec through a clarifying dialogue. Driven by
 * NVIDIA Nemotron (frontier-grade reasoning, hosted API). Stateless: the client
 * sends the request + the answers so far each turn; the model returns either the
 * next question or a finalized spec.
 */
import { callLLMText, overrideFromHeaders, type LLMOverride } from '@/lib/llm'

export const dynamic = 'force-dynamic'

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
Given a board request, identify the functional blocks the board needs (power,
compute/MCU, radio, sensors, actuators/drivers, connectors, protection) and run
a short clarifying interview to pin down the critical unknowns.

Ask about the highest-impact unknowns first, ONE at a time, e.g.: MCU family,
radio band + module, power source/voltage, motor/actuator count + interface,
which sensors, connectors. Always give 2-4 concrete options and a sensible
default. Keep questions short.

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
