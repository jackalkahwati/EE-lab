/**
 * Industrial Design render — turns the ID brief + the to-scale scaffold into a
 * standardized 4-quadrant photorealistic concept sheet (front · perspective ·
 * top · side). Every product uses the SAME prompt template + view layout, so the
 * output format is consistent and downstream-parseable.
 *
 * The client passes the rasterized scaffold PNG as a reference so the render
 * matches real proportions (the scaffold is drawn from real mm + the built
 * board). Image billing may be capped: this route passes through the honest
 * `unavailable` gate from lib/image-gen rather than faking a result.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { generateImage } from '@/lib/image-gen'
import { normalizeIdBrief, type IdBrief } from '@/lib/id-brief'

export const dynamic = 'force-dynamic'

const RUN_ID = /^run-[A-Za-z0-9._-]{1,128}$/

const CONSISTENCY_ROUNDS = Number(process.env.FL_ID_CONSISTENCY_ROUNDS || 1)
const CONSISTENCY_ENABLED = process.env.FL_ID_CONSISTENCY !== '0'

/** Run the vision judge (scripts/vision_judge.py); never rejects — an
 *  unavailable judge resolves { ok: false } so the honest-degradation path
 *  (state "unverified" + reason) can take over. */
function runJudge(images: string[], system: string, user: string): Promise<{ ok: boolean; provider?: string; verdict?: unknown; errors?: string[] }> {
  const script = path.join(process.cwd(), 'scripts', 'vision_judge.py')
  return new Promise((resolve) => {
    const py = spawn(process.env.FL_PYTHON || 'python3', [script], { timeout: 320_000 })
    let out = ''
    py.stdout.on('data', (d) => (out += d))
    py.on('error', () => resolve({ ok: false, errors: ['spawn failed'] }))
    py.on('close', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop() || '{}')) }
      catch { resolve({ ok: false, errors: ['judge produced no JSON'] }) }
    })
    py.stdin.write(JSON.stringify({ system, user, images }))
    py.stdin.end()
  })
}

const CONSISTENCY_SYSTEM =
  'You inspect a 2x2 industrial-design concept sheet (front / perspective / top / side of what should be ONE product). ' +
  'You check whether all four quadrants depict the SAME physical object. Ignore lighting and viewing angle; flag real ' +
  'disagreements: different proportions, a feature present in one view and absent where its face is visible in another, ' +
  'different feature positions, different colors or materials. Reply with ONLY a JSON object.'

const CONSISTENCY_USER =
  'Is this sheet self-consistent — one product, four views? Reply with ONLY: ' +
  '{"consistent": bool, "score": 0-100, "mismatches": [{"views": "which two views disagree", "detail": "what differs, concretely"}]}'

/** One standardized prompt template for every product's 4-quadrant sheet. */
function buildPrompt(b: IdBrief): string {
  const e = b.envelopeMm ?? {}
  const cmf = [b.cmf?.material, b.cmf?.finish].filter(Boolean).join(', ')
  const feats = [...(b.controls ?? []), ...(b.keyFeatures ?? [])].join(', ')
  const env = e.x && e.y ? `outer envelope approximately ${Math.round(e.x)} x ${Math.round(e.y)} x ${Math.round(e.z ?? 0)} mm` : ''
  return [
    // Dark studio so the sheet sits naturally in the app's near-black UI —
    // a white/grey JPEG reads as a pasted-in foreign object on the dark theme.
    'Studio industrial-design concept sheet: a 2x2 grid of four views of the SAME single product on a dark charcoal (near-black) seamless studio background, product softly lit and clearly separated from the background.',
    'Top-left: FRONT elevation (straight-on). Top-right: THREE-QUARTER perspective. Bottom-left: TOP-DOWN. Bottom-right: SIDE elevation.',
    'CRITICAL — all four quadrants depict the IDENTICAL physical object, as if four photographs of ONE prototype on a turntable: identical proportions, identical color/material/finish, and every feature (port, button, vent, window, seam) in the same position in every view where its face is visible. No variations between views.',
    `Product: ${b.product}. Form: ${b.formFactor}.`,
    b.ergonomics ? `Ergonomics: ${b.ergonomics}.` : '',
    cmf ? `Material and finish: ${cmf}.` : '',
    b.cmf?.color ? `Color: ${b.cmf.color}.` : '',
    b.aesthetic ? `Aesthetic: ${b.aesthetic}.` : '',
    feats ? `Physical features: ${feats}.` : '',
    env ? `The proportions MUST match the provided reference wireframe (${env}).` : 'Match the proportions of the provided reference wireframe.',
    'Photorealistic, soft studio lighting, subtle contact shadow, consistent material across all four views. No text, no dimension labels, no callouts, no people, no hands.',
  ].filter(Boolean).join(' ')
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    if (!body?.brief) return Response.json({ ok: false, reason: 'error', message: 'missing brief' }, { status: 400 })
    const brief = normalizeIdBrief(body.brief as Partial<IdBrief>)
    const scaffoldPng: string | undefined =
      typeof body.scaffoldPng === 'string' ? body.scaffoldPng.replace(/^data:image\/png;base64,/, '') : undefined

    const runId: string | undefined = typeof body.runId === 'string' ? body.runId : undefined

    const prompt = buildPrompt(brief)
    let result = await generateImage(prompt, scaffoldPng)

    if (!result.ok) {
      // gated (billing/quota) or a real error — surface honestly, not faked.
      return Response.json({ ok: false, reason: result.reason, message: result.message })
    }

    // Self-consistency gate: the sheet must depict ONE product in all four
    // quadrants before it can serve as mechanical ground truth. Judge → on
    // failure regenerate with the judge's SPECIFIC mismatches as constraints.
    // Honest degradation: judge down → state "unverified" + reason, sheet ships.
    const consistency: { state: 'verified' | 'failed-threshold' | 'unverified'; reason?: string; rounds: { round: number; provider: string; verdict: unknown }[] } =
      { state: 'unverified', rounds: [] }
    if (CONSISTENCY_ENABLED && runId && RUN_ID.test(runId)) {
      let current = result // narrowed ok:true — best candidate so far
      for (let round = 0; round <= CONSISTENCY_ROUNDS; round++) {
        // the judge reads files — write the candidate to a temp path in the run dir
        const dir = path.join(process.cwd(), 'public', 'runs', runId, 'id')
        await fs.mkdir(dir, { recursive: true })
        const candidate = path.join(dir, `candidate-${round}.${current.mime === 'image/png' ? 'png' : 'jpg'}`)
        await fs.writeFile(candidate, Buffer.from(current.dataBase64, 'base64'))

        const res = await runJudge([candidate], CONSISTENCY_SYSTEM, CONSISTENCY_USER)
        if (!res.ok) { consistency.reason = (res.errors ?? []).join(' | ') || 'judge unavailable'; break }
        const v = (res.verdict ?? {}) as { consistent?: boolean; score?: number; mismatches?: { views?: string; detail?: string }[] }
        consistency.rounds.push({ round, provider: res.provider ?? '?', verdict: v })

        if (v.consistent === true || (typeof v.score === 'number' && v.score >= 80)) { consistency.state = 'verified'; break }
        if (round === CONSISTENCY_ROUNDS) { consistency.state = 'failed-threshold'; break }
        // regenerate with the SPECIFIC mismatches as added constraints.
        // Cloudflare FLUX (the working fallback provider) rejects prompts
        // > 2048 chars — clamp the retry prompt or the regeneration is gated
        // for exactly the runs that need it (measured live: judge details are
        // long; an unclamped retry 500s with "Length of '/prompt' must be <= 2048").
        const fixes = (v.mismatches ?? []).map((m, i) => `${i + 1}. ${m.views}: ${m.detail}`).join(' ')
        const retryPrompt = (
          prompt + ` PREVIOUS ATTEMPT WAS INCONSISTENT BETWEEN VIEWS — fix exactly these disagreements and keep everything else: ${fixes}`
        ).slice(0, 2000)
        const retry = await generateImage(retryPrompt, scaffoldPng)
        if (!retry.ok) { consistency.reason = 'regeneration gated: ' + retry.message; break }
        current = retry
      }
      result = current
      try {
        await fs.writeFile(path.join(process.cwd(), 'public', 'runs', runId, 'id', 'consistency.json'),
          JSON.stringify(consistency, null, 1))
      } catch { /* evidence file, not a gate */ }
    } else if (!CONSISTENCY_ENABLED) {
      consistency.reason = 'disabled (FL_ID_CONSISTENCY=0)'
    } else {
      consistency.reason = 'no runId — nowhere to write judge evidence'
    }

    // Persist under the run's own dir when we have a valid run id, so the render
    // survives reloads; otherwise hand back an inline data URL.
    // candidate-<n>.* files are left in the run dir on purpose — judge evidence.
    const ext = result.mime === 'image/png' ? 'png' : result.mime === 'image/webp' ? 'webp' : 'jpg'
    if (runId && RUN_ID.test(runId)) {
      try {
        const dir = path.join(process.cwd(), 'public', 'runs', runId, 'id')
        await fs.mkdir(dir, { recursive: true })
        const url = `/runs/${runId}/id/render.${ext}`
        await fs.writeFile(path.join(dir, `render.${ext}`), Buffer.from(result.dataBase64, 'base64'))
        // stable pointer so the client can load the render on mount without knowing
        // the extension (which varies by provider: flux→jpg, gemini/openai→png).
        await fs.writeFile(path.join(dir, 'render.json'), JSON.stringify({ url, provider: result.provider }))
        return Response.json({ ok: true, url: `${url}?t=${Date.now()}`, provider: result.provider, consistency })
      } catch {
        // fall through to the inline data URL if the run dir isn't writable yet
      }
    }
    return Response.json({ ok: true, url: `data:${result.mime};base64,${result.dataBase64}`, provider: result.provider, consistency })
  } catch (err) {
    return Response.json({ ok: false, reason: 'error', message: String(err) }, { status: 500 })
  }
}
