/**
 * Frontier-model provider chain, shared by the Design Interview and the
 * application-firmware generator. Returns raw text (no JSON parsing, callers
 * that want JSON ask for it in the prompt).
 *
 * Two key modes:
 * - Platform keys (env, gitignored .env.local / Vercel env): tries
 *   Anthropic (Sonnet 5) -> OpenAI -> Gemini -> Nemotron, falling through on any failure.
 * - Bring-your-own-key: callers pass {provider, apiKey} (from the
 *   x-llm-provider / x-llm-key request headers) and ONLY that provider is
 *   used with the user's key. User keys are never logged or persisted.
 */

export interface LLMOverride {
  provider?: string
  apiKey?: string
  /** per-call model override (e.g. review uses claude-fable-5) */
  model?: string
}

async function openaiCall(system: string, user: string, key?: string): Promise<string> {
  const k = key || process.env.OPENAI_API_KEY
  const model = process.env.OPENAI_MODEL || 'gpt-5.1'
  if (!k) throw new Error('no openai key')
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${k}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
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

async function anthropicCall(system: string, user: string, key?: string, model?: string): Promise<string> {
  const k = key || process.env.ANTHROPIC_API_KEY
  model = model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'
  if (!k) throw new Error('no anthropic key')
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': k,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  })
  if (!r.ok) throw new Error(`anthropic HTTP ${r.status}`)
  const d = await r.json()
  const t = d.content?.[0]?.text
  if (!t) throw new Error('anthropic empty')
  return t
}

async function geminiCall(system: string, user: string, key?: string): Promise<string> {
  const k = key || process.env.GEMINI_API_KEY
  const model = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview'
  if (!k) throw new Error('no gemini key')
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${k}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: user }] }],
        generationConfig: { temperature: 0.1 },
      }),
    },
  )
  if (!r.ok) throw new Error(`gemini HTTP ${r.status}`)
  const d = await r.json()
  const t = d.candidates?.[0]?.content?.parts?.[0]?.text
  if (!t) throw new Error('gemini empty')
  return t
}

async function nemotronCall(system: string, user: string, key?: string): Promise<string> {
  const k = key || process.env.NVIDIA_API_KEY
  const model = process.env.NVIDIA_MODEL || 'nvidia/llama-3.3-nemotron-super-49b-v1'
  if (!k) throw new Error('NVIDIA_API_KEY not set')
  const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${k}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      temperature: 0.1,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!r.ok) throw new Error(`Nemotron HTTP ${r.status}`)
  const d = await r.json()
  return d.choices?.[0]?.message?.content ?? ''
}

const PROVIDERS: Record<string, (s: string, u: string, k?: string, m?: string) => Promise<string>> = {
  anthropic: anthropicCall,
  openai: openaiCall,
  gemini: geminiCall,
  nemotron: nemotronCall,
}

/** Read a BYOK override out of request headers (x-llm-provider / x-llm-key). */
export function overrideFromHeaders(headers: Headers): LLMOverride | undefined {
  const provider = headers.get('x-llm-provider')?.trim().toLowerCase() || undefined
  const apiKey = headers.get('x-llm-key')?.trim() || undefined
  if (!apiKey) return undefined
  return { provider, apiKey }
}

/**
 * Call an LLM. With a BYOK override, only the named provider (default:
 * anthropic) runs, using the user's key, no silent fallback to platform
 * keys, so a bad user key surfaces as an error instead of billing us.
 * Otherwise: platform-key chain with fallback.
 */
export async function callLLMText(
  system: string,
  user: string,
  override?: LLMOverride,
): Promise<{ text: string; provider: string }> {
  if (override?.apiKey) {
    const name = override.provider && PROVIDERS[override.provider] ? override.provider : 'anthropic'
    return {
      text: await PROVIDERS[name](system, user, override.apiKey, override.model),
      provider: `${name} (user key)`,
    }
  }
  // Anthropic first: strongest instruction-following for structured output.
  const chain = ['anthropic', 'openai', 'gemini', 'nemotron']
  let lastErr: unknown
  for (const provider of chain) {
    try {
      return {
        text: await PROVIDERS[provider](system, user, undefined, override?.model),
        provider,
      }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('all LLM providers failed')
}

/** Pull Rust source out of a model reply: first ```rust fenced block, else the
 *  largest fenced block, else the whole text trimmed of stray prose lines. */
export function extractRust(text: string): string {
  const fenced = text.match(/```(?:rust|rs)?\s*\n([\s\S]*?)```/i)
  if (fenced) return fenced[1].trim() + '\n'
  return text.trim() + '\n'
}
