/**
 * Design Interview, Layer 1. Turns a vague natural-language board request into
 * a complete, structured design spec through a clarifying dialogue. Driven by
 * NVIDIA Nemotron (frontier-grade reasoning, hosted API). Stateless: the client
 * sends the request + the answers so far each turn; the model returns either the
 * next question or a finalized spec.
 */
import { callLLMText, overrideFromHeaders, type LLMOverride } from '@/lib/llm'
import { MODEL } from '@/lib/model-tiers'
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

// Each clarifying turn is a full model round-trip (~50s) plus the user's own
// think time, so questions are expensive. Three well-chosen ones (the SYSTEM
// prompt orders them highest-impact first) pin down the board; the fourth was
// mostly confirming defaults the finalize step picks anyway.
const MAX_QUESTIONS = 3

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

/**
 * Honest substitution report. The block library (block-capabilities.json) can
 * only build an RP2040 MCU and has no display block, so when a request names a
 * different MCU family or an OLED/screen the builder silently swaps it. That
 * used to leave the architect's disciplines promising e.g. "STM32L0 + OLED"
 * while the built board is an RP2040 with the panel broken out to a header —
 * with no disclosure. Compute the swap here so the UI can SHOW it (never fake a
 * capability, never hide a substitution). Deterministic, from the raw request.
 */
type Substitution = { requested: string; built: string; note: string }
function detectSubstitutions(request: string, blocks: string[]): Substitution[] {
  const subs: Substitution[] = []
  const blocksL = blocks.join(' ').toLowerCase()
  // MCU: the library builds only the RP2040. If the request names a different
  // MCU family and the board came out RP2040, that is a real substitution.
  const OTHER_MCU =
    /\b(stm32[a-z]?\d*|esp32(?:-\w+)?|esp8266|nrf5\d\w*|nrf9\d\w*|at(?:mega|tiny)\d*\w*|\bavr\b|samd\d*\w*|\bpic(?:16|18|24|32)\w*|msp430\w*|gd32\w*|ch32\w*|rp2350|efm32\w*|efr32\w*|max32\d*\w*|apollo\d\w*|\brenesas\b|kinetis\w*|lpc\d\w*|\bimxrt\w*)\b/i
  const mcu = request.match(OTHER_MCU)
  // Fire whenever an MCU block is present — whether the interview labeled it
  // "Bare RP2040" or preserved the requested name ("STM32L0 MCU"); compose.py
  // builds the only MCU block it has (RP2040) either way.
  const mcuBlock = /\b(rp2040|pico|mcu|microcontroller|\bsoc\b)\b/i.test(blocksL)
  if (mcu && mcuBlock) {
    subs.push({
      requested: mcu[0],
      built: 'RP2040 (bare QFN-56)',
      note: 'the block library builds only the RP2040 MCU today — firmware target and pin map are RP2040, not ' +
        mcu[0],
    })
  }
  // Display: there is no display block in the library. If a screen was asked for
  // and no display block landed, the panel is not on the board (bus on a header).
  // A named panel (OLED/SSD1306/e-paper…) is an unambiguous positive; the generic
  // words (display/screen/lcd) only count when not negated ("no display",
  // "headless") so we never falsely claim we dropped a screen nobody wanted.
  const namedDisplay = /\b(oled|ssd1306|sh1106|st77\d\d|epd|e-?paper|e-?ink)\b/i.test(request)
  const genericDisplay =
    /\b(display|screen|\blcd\b|tft)\b/i.test(request) &&
    !/\b(no|without|not|headless|sans|zero)\b/i.test(request)
  const builtDisplay = /\b(oled|display|screen|lcd|epaper|tft)\b/.test(blocksL)
  if ((namedDisplay || genericDisplay) && !builtDisplay) {
    subs.push({
      requested: 'display / OLED panel',
      built: 'omitted — bus broken out to a header',
      note: 'no display block in the library yet; the screen is not placed on the board, its I2C/SPI bus is exposed on a header',
    })
  }
  return subs
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

LAYER COUNT: if the user asks for a specific PCB layer count, include it as a
top-level integer "layers" field in the final JSON. Only 2, 4, and 8 are built;
map anything else to the nearest of those. Default is 4 (omit the field).

Output ONLY one JSON object, no prose, no markdown fences.
To ask the next question:
{"enough":false,"board_class":"<short name>","blocks":["..."],"question":"...","options":["...","..."],"default":"..."}
When the key blocks and their main parameters are pinned down (or you have asked
enough), finalize:
{"enough":true,"board_class":"<short name>","blocks":["..."],"spec":{"<param>":"<value>"},"summary":"<one sentence>"}`

/** Shared provider chain (lib/llm): OpenAI -> Anthropic -> Gemini -> Nemotron,
 *  or the caller's own key/provider via x-llm-provider / x-llm-key headers.
 *
 *  This endpoint does two jobs with very different cost profiles, so it picks
 *  the model per job: asking the next clarifying question is a one-sentence
 *  output that Haiku handles fine (and it is on the interactive path, up to
 *  MAX_QUESTIONS round-trips deep), while FINALIZE MODE emits the product spec
 *  the whole downstream pipeline builds from — quality-critical, stays Sonnet.
 *  Either default yields to an explicit caller override (BYOK header model). */
async function callLLM(userMsg: string, force: boolean, override?: LLMOverride) {
  const model = force ? MODEL.interviewSpec : MODEL.interviewQuestion
  const sys = force
    ? SYSTEM +
      '\n\nFINALIZE MODE: the design has already been specified upstream. Do NOT ' +
      'ask any question. Reply with a finalized spec ("enough":true) NOW, choosing ' +
      'sensible defaults for anything unspecified (USB-C 5V power, 4 layers, standard ' +
      'in-stock parts). "enough" MUST be true.'
    : SYSTEM
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text, provider } = await callLLMText(
        sys,
        attempt === 0
          ? userMsg
          : userMsg + '\n\nYOUR PREVIOUS REPLY WAS NOT VALID JSON. Reply with ONLY the JSON object.',
        { model, ...override },
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

    // `force` skips clarifying questions and finalizes immediately. The Product
    // Architect sets it on the electronics hand-off: it already interviewed at
    // the product tier, so the board request is complete and needs no re-asking.
    const force = body.force === true || answers.length >= MAX_QUESTIONS
    const override = overrideFromHeaders(req.headers)
    let { out, provider } = await callLLM(userMsg, force, override)

    // Early-finalize tier guard: a non-forced turn runs on the cheap question
    // tier (MODEL.interviewQuestion), but the model may decide "enough" on a
    // fully-specified first request — which would ship a Haiku-written SPEC, the
    // quality-critical artifact the whole downstream pipeline builds from. In
    // that rare case RE-RUN the finalize on the strong spec tier (one extra
    // call) and use ITS output. The normal question path is unchanged, and the
    // re-run is skipped when the two tiers are configured identically.
    let finalized = force
    if (!force && out.enough && MODEL.interviewQuestion !== MODEL.interviewSpec) {
      const rerun = await callLLM(userMsg, true, override)
      out = rerun.out
      provider = rerun.provider
      finalized = true
    }

    const blocks: string[] = Array.isArray(out.blocks) ? out.blocks : []
    const boardClass: string = out.board_class ?? 'custom board'
    // layer count: prefer the model's structured field, but the model often
    // mentions "8-layer" in prose without setting it — so fall back to parsing
    // the request. Only 2/4/8 are built; map others to the nearest.
    const rawLayers = Number(out.layers)
    let layers = [2, 4, 8].includes(rawLayers) ? rawLayers : 4
    if (![2, 4, 8].includes(rawLayers)) {
      const m = request.match(/(\d+)\s*-?\s*layers?\b/i)
      if (m) {
        const n = Number(m[1])
        layers = n <= 2 ? 2 : n <= 5 ? 4 : 8
      }
    }

    // On the forced electronics hand-off (and on the strong-tier finalize
    // re-run above), finalize even if the model tried to ask one more thing —
    // as long as it has already proposed blocks. This keeps the Architect flow
    // from stalling on a board-level question the product interview already
    // covered.
    if (out.enough || (finalized && blocks.length > 0)) {
      return Response.json({
        type: 'spec',
        boardClass,
        blocks,
        layers,
        spec: out.spec ?? {},
        summary: out.summary ?? '',
        method: generatorFor(boardClass, blocks),
        substitutions: detectSubstitutions(request, blocks),
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
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
