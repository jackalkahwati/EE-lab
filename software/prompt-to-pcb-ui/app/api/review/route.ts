/**
 * Automated design review, "review this board like a principal EE."
 *
 * POST {runId, force?} → extracts deterministic board facts (review_facts.py:
 * decoupling distances, RF impedance, TP coverage, copper stats, DRC), then
 * has the LLM write a category-scored review grounded ONLY in those facts.
 * Result is cached at the run's data/review.json; force=true regenerates.
 * Respects bring-your-own-key headers (x-llm-provider / x-llm-key).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { callLLMText } from '@/lib/llm'
import { overrideForRequest } from '@/lib/byok'
import { isValidRunId, runAccess } from '@/lib/auth'
import { kicadCli, kicadPython } from '@/lib/toolchain'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const KCLI = kicadCli()
const KPY = kicadPython()

const CATEGORIES = [
  'power', 'signal_integrity', 'emi', 'rf', 'thermal',
  'manufacturability', 'reliability', 'testability',
] as const

const SYSTEM = `detailed thinking off.
You are a principal electrical engineer performing a design review of an
auto-generated PCBA. You are given MEASURED FACTS extracted from the actual board file.
Ground every finding in those facts, never invent measurements. Where a fact is absent,
say "not evaluated" rather than guessing.

Score each category 0-10 (10 = production-ready). Be tough but fair: this is a
module-level 4-layer board, not a smartphone. Cite the fact behind each finding.

Keep it terse: at most 3 findings per category, each under 18 words.
Output ONLY one MINIFIED JSON object (single line, no prose, no markdown fences):
{"overall": <0-10>,
 "summary": "<two sentences>",
 "categories": {
   "power": {"score": <0-10>, "findings": ["..."]},
   "signal_integrity": {...}, "emi": {...}, "rf": {...}, "thermal": {...},
   "manufacturability": {...}, "reliability": {...}, "testability": {...}
 }}`

function sh(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(cmd, args)
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()))
    child.stderr?.on('data', (c: Buffer) => (out += c.toString()))
    child.on('error', (e) => resolve({ code: -1, out: out + `\nspawn failed: ${e.message}` }))
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
}

function balancedFrom(text: string, start: number): string | null {
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
  return null
}

/** Find the review object anywhere in the reply: strips reasoning tags, then
 *  tries every '{' until one balances AND parses AND looks like a review. */
function extractReviewJson(raw: string): string {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  let idx = text.indexOf('{')
  let attempts = 0
  while (idx >= 0 && attempts < 80) {
    const cand = balancedFrom(text, idx)
    if (cand) {
      try {
        const o = JSON.parse(cand)
        if (o && typeof o === 'object' && ('categories' in o || 'overall' in o)) return cand
      } catch {
        /* try next start */
      }
    }
    idx = text.indexOf('{', idx + 1)
    attempts++
  }
  throw new Error('no valid review JSON in model reply')
}

export async function POST(req: Request) {
  let body: { runId?: string; force?: boolean }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const id = String(body.runId ?? '')
  if (!isValidRunId(id)) {
    return Response.json({ error: 'valid runId required' }, { status: 400 })
  }
  const auth = runAccess(req, id)
  if (auth.access === 'unauthenticated') {
    return Response.json({ error: 'sign in required' }, { status: 401 })
  }
  if (auth.access === 'forbidden') {
    return Response.json({ error: 'not your board' }, { status: 403 })
  }

  const appDir = process.cwd()
  const runRoot = path.join(appDir, 'public/runs', id)
  const board = path.join(runRoot, 'variant.kicad_pcb')
  const dataDir = path.join(runRoot, 'data')
  const reviewPath = path.join(dataDir, 'review.json')

  // cached review unless force
  if (!body.force && fs.existsSync(reviewPath)) {
    try {
      return Response.json({ ...JSON.parse(fs.readFileSync(reviewPath, 'utf8')), cached: true })
    } catch {
      /* regenerate */
    }
  }

  // Shared demos may expose an existing cached review, but only an owner may
  // spend an LLM call and create/replace persisted review artifacts.
  if (auth.access !== 'owner') {
    return Response.json({ error: 'only the board owner can generate a review' }, { status: 403 })
  }

  if (!fs.existsSync(board)) {
    return Response.json(
      { error: 'no editable board for this run (older run or transient demo run)' },
      { status: 404 },
    )
  }
  if (!fs.existsSync(KCLI)) {
    return Response.json(
      { error: 'Design review runs on the FirstLight lab workstation (board fact extraction needs KiCad). Cached reviews remain viewable.' },
      { status: 503 },
    )
  }

  // facts: fresh DRC + extraction
  const drcPath = path.join(dataDir, 'drc.json')
  await sh(KCLI, ['pcb', 'drc', '--format', 'json', '--severity-error', '-o', drcPath, board])
  const factsPath = path.join(dataDir, 'review-facts.json')
  const fx = await sh(KPY, [
    path.join(appDir, 'scripts/review_facts.py'), board, drcPath, factsPath,
  ])
  if (!fx.out.includes('FACTS_OK')) {
    return Response.json({ error: 'fact extraction failed', log: fx.out.slice(-400) }, { status: 500 })
  }
  const facts = fs.readFileSync(factsPath, 'utf8')

  // optional context: BOM + power budget
  let bom = ''
  try {
    bom = fs.readFileSync(path.join(dataDir, 'bom.json'), 'utf8')
  } catch { /* optional */ }
  let power = ''
  try {
    power = fs.readFileSync(path.join(dataDir, 'power-budget.json'), 'utf8')
  } catch { /* optional */ }

  try {
    const override = overrideForRequest(req)
    const userMsg = `MEASURED BOARD FACTS:\n${facts}\n\nBOM:\n${bom || '(unavailable)'}\n\nPOWER BUDGET (computed):\n${power || '(unavailable)'}`
    let text = ''
    let provider = ''
    let parsed: string | null = null
    let lastFail = ''
    for (let attempt = 0; attempt < 3 && parsed === null; attempt++) {
      try {
        const r = await callLLMText(
          SYSTEM,
          attempt === 0
            ? userMsg
            : userMsg + '\n\nYOUR PREVIOUS REPLY WAS INVALID/TRUNCATED JSON. Reply again: one COMPLETE minified JSON object only, maximum brevity.',
          // review is the highest-reasoning call in the app, Sonnet 5 for now
          // (swap to claude-fable-5 for the flagship tier later). BYOK users
          // keep their own provider/model.
          { model: 'claude-sonnet-5', ...override },
        )
        text = r.text
        provider = r.provider
        parsed = extractReviewJson(text)
      } catch (e) {
        lastFail = String(e)
        parsed = null
      }
    }
    if (parsed === null) throw new Error(`no valid review after 3 attempts (${lastFail})`)
    const review = JSON.parse(parsed) as {
      overall?: number
      summary?: string
      categories?: Record<string, { score?: number; findings?: string[] }>
    }
    // shape guard: every category present, every score numeric 0-10
    for (const c of CATEGORIES) {
      const cat = review.categories?.[c]
      if (!cat) {
        review.categories = { ...review.categories, [c]: { score: null as unknown as number, findings: ['not evaluated'] } }
      } else if (typeof cat.score !== 'number' || Number.isNaN(cat.score)) {
        cat.score = null as unknown as number
        cat.findings = cat.findings?.length ? cat.findings : ['not evaluated']
      } else {
        cat.score = Math.max(0, Math.min(10, cat.score))
      }
    }
    if (typeof review.overall !== 'number' || Number.isNaN(review.overall)) {
      const nums = CATEGORIES.map((c) => review.categories?.[c]?.score).filter(
        (s): s is number => typeof s === 'number',
      )
      review.overall = nums.length
        ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10
        : undefined
    }
    const result = {
      ...review,
      provider,
      generatedAt: new Date().toISOString(),
      factsPath: `/runs/${id}/data/review-facts.json`,
    }
    fs.writeFileSync(reviewPath, JSON.stringify(result, null, 1))
    return Response.json(result)
  } catch (err) {
    return Response.json({ error: `review generation failed: ${String(err)}` }, { status: 500 })
  }
}
