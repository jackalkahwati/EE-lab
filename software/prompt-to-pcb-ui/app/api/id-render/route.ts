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
import { generateImage } from '@/lib/image-gen'
import { normalizeIdBrief, type IdBrief } from '@/lib/id-brief'

export const dynamic = 'force-dynamic'

const RUN_ID = /^run-[A-Za-z0-9._-]{1,128}$/

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

    const prompt = buildPrompt(brief)
    const result = await generateImage(prompt, scaffoldPng)

    if (!result.ok) {
      // gated (billing/quota) or a real error — surface honestly, not faked.
      return Response.json({ ok: false, reason: result.reason, message: result.message })
    }

    // Persist under the run's own dir when we have a valid run id, so the render
    // survives reloads; otherwise hand back an inline data URL.
    const ext = result.mime === 'image/png' ? 'png' : result.mime === 'image/webp' ? 'webp' : 'jpg'
    const runId: string | undefined = typeof body.runId === 'string' ? body.runId : undefined
    if (runId && RUN_ID.test(runId)) {
      try {
        const dir = path.join(process.cwd(), 'public', 'runs', runId, 'id')
        await fs.mkdir(dir, { recursive: true })
        const url = `/runs/${runId}/id/render.${ext}`
        await fs.writeFile(path.join(dir, `render.${ext}`), Buffer.from(result.dataBase64, 'base64'))
        // stable pointer so the client can load the render on mount without knowing
        // the extension (which varies by provider: flux→jpg, gemini/openai→png).
        await fs.writeFile(path.join(dir, 'render.json'), JSON.stringify({ url, provider: result.provider }))
        return Response.json({ ok: true, url: `${url}?t=${Date.now()}`, provider: result.provider })
      } catch {
        // fall through to the inline data URL if the run dir isn't writable yet
      }
    }
    return Response.json({ ok: true, url: `data:${result.mime};base64,${result.dataBase64}`, provider: result.provider })
  } catch (err) {
    return Response.json({ ok: false, reason: 'error', message: String(err) }, { status: 500 })
  }
}
