/**
 * Discipline module — the generic engine behind the separate Firmware /
 * Manufacturing / Supply chain / Validation modules. The product engine emits a
 * structured artifact (lib/discipline-artifact) grounded in the real spec +
 * built board (+ BOM for supply chain), at the discipline's honest fidelity.
 * One mechanism, four separate modules; specialization is the per-discipline
 * guidance (data), not code.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { callLLMText, type LLMOverride } from '@/lib/llm'
import { overrideForRequest } from '@/lib/byok'
import { sourcingPromptBlock } from '@/lib/sourcing'
import { MODEL } from '@/lib/model-tiers'
import { DISCIPLINE_MODULES, DISCIPLINE_ARTIFACT_SCHEMA, normalizeDisciplineArtifact } from '@/lib/discipline-artifact'
import { loadGroundBoard } from '@/lib/ground-board'
import type { ProductSpec } from '@/lib/product-spec'

export const dynamic = 'force-dynamic'

const RUN_ID = /^run-[A-Za-z0-9._-]{1,128}$/

/** Real part names from the run's BOM, for live sourcing lookups. */
async function bomMpns(runId: string | undefined): Promise<string[]> {
  if (!runId) return []
  try {
    const bom = JSON.parse(await fs.readFile(
      path.join(process.cwd(), 'public', 'runs', runId, 'data', 'bom.json'), 'utf8'))
    return (Array.isArray(bom) ? bom : [])
      .map((r: any) => String(r.part ?? ''))
      .filter((p: string) => p && !/generic|unknown|fiducial|—/i.test(p))
  } catch { return [] }
}

/** Engineer change request scoped to this discipline (Phase 3 targeted edits). */
async function changeRequestBlock(runId: string | undefined, stage: string): Promise<string> {
  if (!runId) return ''
  try {
    const cr = JSON.parse(await fs.readFile(
      path.join(process.cwd(), 'public', 'runs', runId, 'data', 'change-request.json'), 'utf8'))
    if (Array.isArray(cr.areas) && cr.areas.includes(stage) && cr.message) {
      return `\n\nENGINEER CHANGE REQUEST (this revision — apply it): ${String(cr.message).slice(0, 400)}`
    }
  } catch { /* no change request — normal build */ }
  return ''
}

async function callLLM(sys: string, userMsg: string, override?: LLMOverride) {
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const antKey = process.env.ANTHROPIC_API_KEY
      // Haiku: these four modules do structured SUMMARIZATION of facts already
      // decided by the spec + built board — they make no design decisions (those
      // live in architect/electronics/industrial-design/mechanical). Haiku is much
      // faster on long structured output, and this branch is the pipeline's
      // slowest (~40-117s each, parallel, so branch cost = the slowest).
      // NB: lib/llm claudeCodeCall maps the model string to a CLI alias by regex
      // (/haiku/i -> 'haiku'), so the string must keep "haiku" in it.
      // Compose, don't switch: tier default first, caller override spread LAST —
      // a BYOK caller (provider+apiKey, no model) keeps the docs tier, while an
      // explicit caller model still wins over it.
      const opts: LLMOverride = {
        ...(antKey ? { apiKey: antKey, provider: 'anthropic' as const } : {}),
        model: MODEL.docs,
        ...override,
      }
      const { text } = await callLLMText(
        sys,
        attempt === 0 ? userMsg : userMsg + '\n\nYOUR PREVIOUS REPLY WAS NOT VALID JSON. Reply with ONLY the JSON object.',
        opts,
      )
      return JSON.parse(firstJson(text))
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('discipline model failed')
}

function firstJson(text: string): string {
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const i = t.indexOf('{')
  if (i < 0) throw new Error('no json')
  let depth = 0, inStr = false, esc = false
  for (let k = i; k < t.length; k++) {
    const ch = t[k]
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false }
    else if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return t.slice(i, k + 1) }
  }
  throw new Error('unbalanced json')
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const spec = body.spec as ProductSpec | undefined
    const discipline = String(body.discipline ?? '')
    const runId = typeof body.runId === 'string' ? body.runId : undefined
    const mod = DISCIPLINE_MODULES[discipline]
    if (!spec?.product) return Response.json({ error: 'missing product spec' }, { status: 400 })
    if (!mod) return Response.json({ error: `unknown discipline: ${discipline}` }, { status: 400 })

    // Ground in the REAL board — prefer the bespoke chip-scale board so every
    // discipline references the actual product board, not the flroute placeholder.
    let boardCtx = ''
    if (runId && RUN_ID.test(runId)) {
      const gb = await loadGroundBoard(runId)
      if (gb) {
        const kind = gb.source === 'chipscale' ? 'chip-scale board' : 'board'
        boardCtx = `\nREAL BOARD (${kind}): ${Math.round(gb.wMm)}×${Math.round(gb.hMm)}mm${gb.layers ? ` · ${gb.layers}-layer` : ''}${gb.components ? ` · ${gb.components} components` : ''}`
        // Supply chain BOM: use the chip-scale part set (the real BLE SoC + mics +
        // PMIC) when present; fall back to the flroute BOM only if there's no
        // chip-scale board.
        if (discipline === 'supplyChain') {
          const csParts = (gb.parts || []).map((p) => p.lcsc ? `${p.name} (${p.footprint}, LCSC ${p.lcsc})` : `${p.name} (${p.footprint})`)
          if (csParts.length) {
            boardCtx += `\nBOM PARTS (chip-scale): ${csParts.join(', ')}`
          } else {
            try {
              const bom = JSON.parse(await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, 'data', 'bom.json'), 'utf8'))
              const lines = Array.isArray(bom) ? bom.slice(0, 30).map((l: any) => l?.mpn || l?.part || l?.value || l?.ref).filter(Boolean) : []
              if (lines.length) boardCtx += `\nBOM PARTS: ${lines.join(', ')}`
            } catch { /* none */ }
          }
        }
      }
      // Stage 4: ground on the CANONICAL design object — the real parts + MCU the
      // planner/synth ACTUALLY built (design.json) — so every discipline
      // describes what is truly on the board, not the architect's aspirational
      // spec. This is what keeps board = design = BOM = discipline text coherent.
      try {
        const design = JSON.parse(await fs.readFile(
          path.join(process.cwd(), 'public', 'runs', runId, 'data', 'design.json'), 'utf8'))
        const parts: string[] = Array.isArray(design.parts)
          ? design.parts.map((p: { mpn?: string }) => p.mpn).filter(Boolean) : []
        if (design.mcu || parts.length) {
          boardCtx += `\nCANONICAL DESIGN — the parts ACTUALLY on the board (describe THESE, not aspirational parts):`
          if (design.mcu) boardCtx += `\n  MCU: ${design.mcu}`
          if (parts.length) boardCtx += `\n  parts: ${parts.join(', ')}`
          const subs = Array.isArray(design.substitutions) ? design.substitutions : []
          if (subs.length) boardCtx += `\n  substitutions (requested → built): ${subs.map((s: { request?: string; mpn?: string }) => `${s.request} → ${s.mpn || '?'}`).join('; ')}`
          if (Array.isArray(design.unsupported) && design.unsupported.length)
            boardCtx += `\n  NOT on the board (unsupported, do not describe as present): ${design.unsupported.join(', ')}`
          if (design.verification)
            boardCtx += `\n  design verification: ${design.verification.converged ? 'converged (real checks pass)' : 'not converged'}`
        }
      } catch { /* no canonical design (non-plan run) — ground on the board/BOM above */ }
    }

    const sys = `detailed thinking off.
You are the ${mod.label} specialist for an autonomous product-engineering platform.
${mod.guidance}
GENERAL across product categories. Ground everything in the given product + board.
When a CANONICAL DESIGN is given, describe the EXACT parts it lists (the real MCU
and components actually placed) — never substitute the product spec's aspirational
parts for what was really built, and never present an unsupported part as present.

HONESTY — never trim any of this; it is the artifact's whole value:
- This artifact's fidelity is "${mod.fidelity}" — carry that label and do not
  overclaim. It is generated/advisory: not validated, not compiled, not
  live-sourced, not executed against hardware.
- Never invent hardware, suppliers, measurements or results the given product +
  board do not support — no made-up part numbers, prices, lead times, pass/fail data.
- Where the spec asks for something the board does not deliver, say so as an
  explicit GAP. Never paper over it, never fake coverage.

LENGTH — the reader is an engineer skimming; bloat is a defect. Be dense:
- At most 5 sections; at most 5 items per section.
- One tight bullet per item, ONE line (<= 20 words). Never a prose paragraph.
- summary: one sentence.
- Keep only high-signal content: real parts, numbers, risks, gaps, decisions.
- Cut all padding: no preamble, no restating the product/spec/board back, no
  overview / conclusion / next-steps filler sections, no hedging, no repeating a
  point in two sections, no generic best-practice everyone already knows.
- Shorten by dropping PADDING, never by dropping a real finding: every gap,
  unmet requirement, traceability hole, single-source risk and missing-part
  callout stays. Say it shorter, do not drop it.
Output ONLY one JSON object, no prose, no markdown fences, EXACTLY this shape:
${DISCIPLINE_ARTIFACT_SCHEMA}
ADDITIONALLY include a top-level "gaps" array (may be empty): every explicit
GAP from the sections, structured as {"text":"<the gap, one line>","blocking":
true|false} — blocking=true when shipping without resolving it would be wrong.`

    const b = spec.budgets ?? {}
    const userMsg =
      `PRODUCT: ${spec.product}\n${spec.description || ''}\nphilosophy: ${spec.philosophy || '-'}\n` +
      `budgets: ${JSON.stringify(b)}${boardCtx}\n\nEmit the ${mod.label} artifact.` +
      // Phase 3: a targeted edit rides in as an explicit engineer instruction
      (await changeRequestBlock(runId, discipline)) +
      // Phase 4: real distributor quotes when a provider is configured ('' when
      // gated — the doc then keeps its honest "not live-sourced" caveat)
      (discipline === 'supplyChain' ? await sourcingPromptBlock(await bomMpns(runId)) : '')

    const out = await callLLM(sys, userMsg, overrideForRequest(req))
    const artifact = normalizeDisciplineArtifact(out, discipline)
    // structured gaps → work-queue items (lib/work-items); advisory unless flagged
    ;(artifact as any).gaps = Array.isArray((out as any)?.gaps)
      ? (out as any).gaps.slice(0, 10).map((g: any) => ({ text: String(g?.text ?? g).slice(0, 240), blocking: g?.blocking === true }))
      : []

    // Persist the artifact so the full-pipeline orchestrator's result is durable
    // and the discipline tab shows it on reload without re-running (in-memory-only
    // before). Grounded on the real board via boardCtx above, so it stays connected.
    if (runId && RUN_ID.test(runId)) {
      try {
        const runDir = path.join(process.cwd(), 'public', 'runs', runId)
        const dir = path.join(runDir, 'disciplines')
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, `${discipline}.json`), JSON.stringify(artifact))
        // Persist the product spec itself so selecting this run later restores it
        // (the tabs gate on productSpec; without this a saved run's disciplines
        // show disabled/not-built even though every artifact is on disk).
        await fs.writeFile(path.join(runDir, 'product-spec.json'), JSON.stringify(spec))
      } catch { /* best effort — persistence failure must not fail the response */ }
    }

    return Response.json({ artifact })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
