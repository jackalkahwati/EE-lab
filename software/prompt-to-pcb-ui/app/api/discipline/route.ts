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
import { callLLMText, overrideFromHeaders, type LLMOverride } from '@/lib/llm'
import { DISCIPLINE_MODULES, DISCIPLINE_ARTIFACT_SCHEMA, normalizeDisciplineArtifact } from '@/lib/discipline-artifact'
import type { ProductSpec } from '@/lib/product-spec'

export const dynamic = 'force-dynamic'

const RUN_ID = /^run-[A-Za-z0-9._-]{1,128}$/

async function callLLM(sys: string, userMsg: string, override?: LLMOverride) {
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

    // ground in the real board (+ BOM for supply chain)
    let boardCtx = ''
    if (runId && RUN_ID.test(runId)) {
      try {
        const bj = JSON.parse(await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, 'data', 'board.json'), 'utf8'))
        boardCtx = `\nREAL BOARD: ${Math.round(bj?.boardSize?.wMm)}×${Math.round(bj?.boardSize?.hMm)}mm · ${bj?.layers}-layer · ${bj?.components} components · ${bj?.netsTotal} nets`
      } catch { /* none */ }
      if (discipline === 'supplyChain') {
        try {
          const bom = JSON.parse(await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, 'data', 'bom.json'), 'utf8'))
          const lines = Array.isArray(bom) ? bom.slice(0, 30).map((l: any) => l?.mpn || l?.part || l?.value || l?.ref).filter(Boolean) : []
          if (lines.length) boardCtx += `\nBOM PARTS: ${lines.join(', ')}`
        } catch { /* none */ }
      }
    }

    const sys = `detailed thinking off.
You are the ${mod.label} specialist for an autonomous product-engineering platform.
${mod.guidance}
GENERAL across product categories. Ground everything in the given product + board.
Be concrete and specific; no fluff. This artifact's fidelity is "${mod.fidelity}" —
do not overclaim (it is generated/advisory, not validated).
Output ONLY one JSON object, no prose, no markdown fences, EXACTLY this shape:
${DISCIPLINE_ARTIFACT_SCHEMA}`

    const b = spec.budgets ?? {}
    const userMsg =
      `PRODUCT: ${spec.product}\n${spec.description || ''}\nphilosophy: ${spec.philosophy || '-'}\n` +
      `budgets: ${JSON.stringify(b)}${boardCtx}\n\nEmit the ${mod.label} artifact.`

    const out = await callLLM(sys, userMsg, overrideFromHeaders(req.headers))
    return Response.json({ artifact: normalizeDisciplineArtifact(out, discipline) })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 })
  }
}
