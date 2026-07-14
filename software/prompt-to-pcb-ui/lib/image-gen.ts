/**
 * Image-generation chain for the Industrial Design render. Providers:
 *   - Cloudflare Workers AI — FLUX.1-schnell, free daily quota (needs
 *     CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN). Prompt-only, FLUX quality.
 *   - Gemini  — conditions on the reference scaffold; billing-gated.
 *   - OpenAI  — gpt-image-1, conditions on the reference scaffold; billing-gated.
 * The reference PNG (the to-scale ID scaffold) is used by providers that support
 * image conditioning. Order is chosen at call time (see generateImage): when a
 * scaffold ref is present the conditioning providers run first so all four
 * quadrants stay the SAME product; Cloudflare (prompt-only) leads only when
 * there is no ref.
 *
 * HONEST GATING: the result distinguishes `unavailable` (quota/billing/no key —
 * a gated, not-broken state the UI shows plainly) from a real `error`. Nothing
 * is faked when a provider can't run.
 */

export type ImageResult =
  | { ok: true; dataBase64: string; mime: string; provider: string }
  | { ok: false; reason: 'unavailable' | 'error'; message: string }

const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image'
const CF_MODEL = process.env.CLOUDFLARE_IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell'

/** Quota / billing / auth / missing-key → a gated "unavailable" state, not an error. */
function isUnavailable(status: number, message: string): boolean {
  const m = message.toLowerCase()
  return (
    status === 401 || status === 403 || status === 429 || status === 402 ||
    m.includes('billing') || m.includes('quota') || m.includes('hard limit') ||
    m.includes('insufficient') || m.includes('exceeded') || m.includes('authentication')
  )
}

/** Cloudflare Workers AI — FLUX.1-schnell. Free daily quota, FLUX quality. */
async function cloudflareImage(prompt: string): Promise<ImageResult> {
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!acct || !token) return { ok: false, reason: 'unavailable', message: 'no Cloudflare account id / api token' }
  try {
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${CF_MODEL}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        // Fixed seed so the prompt-only fallback path is deterministic run-to-run.
        body: JSON.stringify({ prompt, steps: 8, seed: 42 }),
        signal: AbortSignal.timeout(60_000),
      },
    )
    const d = await r.json().catch(() => null)
    if (!r.ok || !d?.success) {
      const msg = d?.errors?.map((e: any) => e.message).join('; ') || `cloudflare HTTP ${r.status}`
      return { ok: false, reason: isUnavailable(r.status, msg) ? 'unavailable' : 'error', message: msg }
    }
    // flux-1-schnell returns { result: { image: "<base64 jpeg>" } }
    const b64 = d?.result?.image
    if (!b64) return { ok: false, reason: 'error', message: 'cloudflare returned no image' }
    return { ok: true, dataBase64: b64, mime: 'image/jpeg', provider: `cloudflare (${CF_MODEL})` }
  } catch (e) {
    return { ok: false, reason: 'error', message: `cloudflare: ${String(e).slice(0, 200)}` }
  }
}

async function geminiImage(prompt: string, refPngBase64?: string): Promise<ImageResult> {
  const key = process.env.GEMINI_API_KEY
  if (!key) return { ok: false, reason: 'unavailable', message: 'no GEMINI_API_KEY' }
  const parts: Record<string, unknown>[] = [{ text: prompt }]
  if (refPngBase64) parts.push({ inline_data: { mime_type: 'image/png', data: refPngBase64 } })
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] }),
        signal: AbortSignal.timeout(60_000),
      },
    )
    const d = await r.json()
    if (!r.ok) {
      const msg = d?.error?.message || `gemini HTTP ${r.status}`
      return { ok: false, reason: isUnavailable(r.status, msg) ? 'unavailable' : 'error', message: msg }
    }
    const outParts = (d?.candidates?.[0]?.content?.parts ?? []) as Record<string, any>[]
    const img = outParts.find((p) => p.inline_data || p.inlineData)
    const data = img ? (img.inline_data || img.inlineData).data : null
    if (!data) return { ok: false, reason: 'error', message: 'gemini returned no image' }
    return { ok: true, dataBase64: data, mime: 'image/png', provider: `gemini (${GEMINI_IMAGE_MODEL})` }
  } catch (e) {
    return { ok: false, reason: 'error', message: `gemini: ${String(e).slice(0, 200)}` }
  }
}

async function openaiImage(prompt: string, refPngBase64?: string): Promise<ImageResult> {
  const key = process.env.OPENAI_API_KEY
  if (!key) return { ok: false, reason: 'unavailable', message: 'no OPENAI_API_KEY' }
  try {
    let r: Response
    if (refPngBase64) {
      const form = new FormData()
      form.append('model', 'gpt-image-1')
      form.append('prompt', prompt)
      form.append('size', '1024x1024')
      form.append('image', new Blob([Buffer.from(refPngBase64, 'base64')], { type: 'image/png' }), 'scaffold.png')
      r = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
        signal: AbortSignal.timeout(90_000),
      })
    } else {
      r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-image-1', prompt, size: '1024x1024' }),
        signal: AbortSignal.timeout(90_000),
      })
    }
    const d = await r.json()
    if (!r.ok) {
      const msg = d?.error?.message || `openai HTTP ${r.status}`
      return { ok: false, reason: isUnavailable(r.status, msg) ? 'unavailable' : 'error', message: msg }
    }
    const b64 = d?.data?.[0]?.b64_json
    if (!b64) return { ok: false, reason: 'error', message: 'openai returned no image' }
    return { ok: true, dataBase64: b64, mime: 'image/png', provider: 'openai (gpt-image-1)' }
  } catch (e) {
    return { ok: false, reason: 'error', message: `openai: ${String(e).slice(0, 200)}` }
  }
}

/**
 * Generate an image. Provider order depends on whether a scaffold reference is
 * supplied:
 *   - WITH a ref: the reference-conditioning providers run FIRST (Gemini →
 *     OpenAI → Cloudflare). Conditioning on the scaffold geometry forces all
 *     four quadrants to depict the SAME single product; Cloudflare flux-1-schnell
 *     is prompt-only and ignores the ref, so it can only be the last resort.
 *   - WITHOUT a ref: Cloudflare FLUX first (free quota, best prompt-only quality),
 *     then Gemini → OpenAI.
 * Returns the first success, or — if all failed — a real `error` if any hit a
 * genuine fault, else the honest `unavailable` gate.
 */
export async function generateImage(prompt: string, refPngBase64?: string): Promise<ImageResult> {
  const attempts: Array<() => Promise<ImageResult>> = refPngBase64
    ? [
        () => geminiImage(prompt, refPngBase64),
        () => openaiImage(prompt, refPngBase64),
        () => cloudflareImage(prompt),
      ]
    : [
        () => cloudflareImage(prompt),
        () => geminiImage(prompt, refPngBase64),
        () => openaiImage(prompt, refPngBase64),
      ]
  const failures: ImageResult[] = []
  for (const run of attempts) {
    const res = await run()
    if (res.ok) return res
    failures.push(res)
  }
  const realError = failures.find((r) => !r.ok && r.reason === 'error') as
    | { ok: false; reason: 'error'; message: string } | undefined
  if (realError) return realError
  const msgs = failures.map((r) => (r.ok ? '' : r.message)).filter(Boolean).join(' | ')
  return { ok: false, reason: 'unavailable', message: msgs || 'image generation unavailable' }
}
