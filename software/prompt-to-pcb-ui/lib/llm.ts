/**
 * Frontier-model provider chain, shared by the Design Interview and the
 * application-firmware generator. Tries OpenAI gpt-5.1 -> Gemini -> Nemotron and
 * returns raw text (no JSON parsing — callers that want JSON ask for it in the
 * prompt). Keys come from the gitignored .env.local.
 */

async function openaiCall(system: string, user: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY
  const model = process.env.OPENAI_MODEL || 'gpt-5.1'
  if (!key) throw new Error('no openai key')
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
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

async function nemotronCall(system: string, user: string): Promise<string> {
  const key = process.env.NVIDIA_API_KEY
  const model = process.env.NVIDIA_MODEL || 'nvidia/llama-3.3-nemotron-super-49b-v1'
  if (!key) throw new Error('NVIDIA_API_KEY not set')
  const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
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

/** Try providers in order of preference, fall back on any failure. */
export async function callLLMText(
  system: string,
  user: string,
): Promise<{ text: string; provider: string }> {
  const chain: [string, (s: string, u: string) => Promise<string>][] = [
    ['openai', openaiCall],
    ['gemini', geminiCall],
    ['nemotron', nemotronCall],
  ]
  let lastErr: unknown
  for (const [provider, fn] of chain) {
    try {
      return { text: await fn(system, user), provider }
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
