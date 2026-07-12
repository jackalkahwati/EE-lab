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

// Every provider fetch gets a hard timeout. Without one, a stalled provider
// connection (rate-limit black-holing, network stall) hangs the WHOLE pipeline
// in the firmware stage and wedges the run lock — a hung fetch was the root
// cause of the "pipeline already in progress" lockups. On timeout the provider
// throws, the chain falls through, and callers degrade honestly.
const LLM_TIMEOUT_MS = 120_000

async function openaiCall(system: string, user: string, key?: string): Promise<string> {
  const k = key || process.env.OPENAI_API_KEY
  const model = process.env.OPENAI_MODEL || 'gpt-5.1'
  if (!k) throw new Error('no openai key')
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
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
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
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
  // Claude-5 models can emit a reasoning block before the answer, so the text
  // is not always content[0]. Find the first text block (reading content[0]
  // blindly returned empty and silently fell the whole chain through to
  // nemotron).
  const t = (d.content as { type: string; text?: string }[] | undefined)
    ?.find((b) => b.type === 'text')?.text
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
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
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
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
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

/**
 * Claude Code CLI provider — routes calls through the LOCAL `claude` binary,
 * which authenticates with the user's claude.ai (Max) subscription login rather
 * than the metered API. Opt-in via USE_CLAUDE_CODE_CLI so it never affects a
 * deployed/multi-user instance (and the binary only exists on a dev machine).
 * ANTHROPIC_API_KEY is stripped from the child env: Claude Code prefers an API
 * key over the subscription login, so leaving it set would re-hit the metered
 * (possibly out-of-credit) API. Slower than a raw fetch (full CLI spin-up) and
 * bounded by the subscription's usage limits.
 */
async function claudeCodeCall(system: string, user: string, _key?: string, model?: string): Promise<string> {
  const { spawn } = await import('node:child_process')
  const fs = await import('node:fs')
  const bin = (() => {
    if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH
    const home = process.env.HOME || ''
    for (const p of [`${home}/.local/bin/claude`, '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
      try { if (fs.existsSync(p)) return p } catch { /* keep looking */ }
    }
    return 'claude'
  })()
  const alias = /opus/i.test(model || '') ? 'opus' : /haiku/i.test(model || '') ? 'haiku' : 'sonnet'
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  return await new Promise<string>((resolve, reject) => {
    const cp = spawn(bin, ['-p', '--model', alias, '--output-format', 'json'], { env, timeout: LLM_TIMEOUT_MS })
    let out = '', err = ''
    cp.stdout.on('data', (d) => (out += d))
    cp.stderr.on('data', (d) => (err += d))
    cp.on('error', (e) => reject(new Error(`claude-code spawn: ${e.message}`)))
    cp.on('close', () => {
      try {
        const d = JSON.parse(out.trim())
        if (d.is_error) return reject(new Error(`claude-code: ${String(d.result || err).slice(0, 140)}`))
        if (!d.result) return reject(new Error('claude-code empty'))
        resolve(d.result)
      } catch { reject(new Error(`claude-code bad output: ${(err || out).slice(0, 140)}`)) }
    })
    cp.stdin.write(`${system}\n\n${user}`)
    cp.stdin.end()
  })
}

const PROVIDERS: Record<string, (s: string, u: string, k?: string, m?: string) => Promise<string>> = {
  anthropic: anthropicCall,
  openai: openaiCall,
  gemini: geminiCall,
  nemotron: nemotronCall,
  'claude-code': claudeCodeCall,
}

const useClaudeCodeCli = () =>
  process.env.USE_CLAUDE_CODE_CLI === '1' || process.env.USE_CLAUDE_CODE_CLI === 'true'

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
  // Local subscription mode: route calls through the Claude Code CLI (Max
  // subscription, not metered API). Routes pass the platform ANTHROPIC_API_KEY
  // as an override, so treat an override key that MATCHES the env key as
  // "platform" (use the CLI); only a real header BYOK key (different from the
  // env key) takes precedence. Falls through to the normal chain if the CLI
  // itself fails.
  if (useClaudeCodeCli() && (!override?.apiKey || override.apiKey === process.env.ANTHROPIC_API_KEY)) {
    try {
      return { text: await claudeCodeCall(system, user, undefined, override?.model), provider: 'claude-code (subscription)' }
    } catch { /* fall through to platform chain */ }
  }
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
