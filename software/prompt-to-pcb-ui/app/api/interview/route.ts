/**
 * Design Interview — Layer 1. Turns a vague natural-language board request into
 * a complete, structured design spec through a clarifying dialogue. Driven by
 * NVIDIA Nemotron (frontier-grade reasoning, hosted API). Stateless: the client
 * sends the request + the answers so far each turn; the model returns either the
 * next question or a finalized spec.
 */
export const dynamic = 'force-dynamic'

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions'
const MAX_QUESTIONS = 4

interface Answer {
  question: string
  answer: string
}

// board classes the pipeline can actually generate today (Layer 2 archetypes)
function isBuildable(boardClass: string, blocks: string[]): boolean {
  const hay = (boardClass + ' ' + blocks.join(' ')).toLowerCase()
  return /relay|probe|matrix|crosspoint|switch ?matrix/.test(hay)
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

/** OpenAI GPT-5.1 (preferred — frontier reasoning, fast). */
async function openaiCall(system: string, user: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY
  const model = process.env.OPENAI_MODEL || 'gpt-5.1'
  if (!key) throw new Error('no openai key')
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!r.ok) throw new Error(`openai HTTP ${r.status}`)
  const d = await r.json()
  const t = d.choices?.[0]?.message?.content
  if (!t) throw new Error('openai empty')
  return t
}

/** Gemini (frontier reasoning). Throws on quota/billing/auth so the caller
 *  falls back. */
async function geminiCall(system: string, user: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY
  const model = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview'
  if (!key) throw new Error('no gemini key')
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: user }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      }),
    },
  )
  if (!r.ok) throw new Error(`gemini HTTP ${r.status}`)
  const d = await r.json()
  const t = d.candidates?.[0]?.content?.parts?.[0]?.text
  if (!t) throw new Error('gemini empty')
  return t
}

/** Nemotron Super 49B (OpenAI-compatible, hosted) — the working fallback. */
async function nemotronCall(system: string, user: string): Promise<string> {
  const key = process.env.NVIDIA_API_KEY
  const model = process.env.NVIDIA_MODEL || 'nvidia/llama-3.3-nemotron-super-49b-v1'
  if (!key) throw new Error('NVIDIA_API_KEY not set')
  const r = await fetch(NVIDIA_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!r.ok) throw new Error(`Nemotron HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`)
  const d = await r.json()
  return d.choices?.[0]?.message?.content ?? ''
}

/** Try providers in order of preference, fall back to the next on any failure:
 *  OpenAI GPT-5.1 -> Gemini -> Nemotron. */
async function callLLM(userMsg: string, force: boolean) {
  const sys = force
    ? SYSTEM + '\nYou have asked enough questions — you MUST finalize now (enough:true).'
    : SYSTEM
  const chain: [string, (s: string, u: string) => Promise<string>][] = [
    ['openai', openaiCall],
    ['gemini', geminiCall],
    ['nemotron', nemotronCall],
  ]
  let lastErr: unknown
  for (const [provider, fn] of chain) {
    try {
      const text = await fn(sys, userMsg)
      return { out: JSON.parse(firstJsonObject(text)), provider }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('all providers failed')
}

/** Extract the first complete top-level {...} object, ignoring any trailing
 *  prose the model adds after it (string-aware brace matching). */
function firstJsonObject(text: string): string {
  const start = text.indexOf('{')
  if (start < 0) throw new Error('no JSON in model reply')
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  throw new Error('unbalanced JSON in model reply')
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
    const { out, provider } = await callLLM(userMsg, force)

    const blocks: string[] = Array.isArray(out.blocks) ? out.blocks : []
    const boardClass: string = out.board_class ?? 'custom board'

    if (out.enough) {
      return Response.json({
        type: 'spec',
        boardClass,
        blocks,
        spec: out.spec ?? {},
        summary: out.summary ?? '',
        buildable: isBuildable(boardClass, blocks),
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
