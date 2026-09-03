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
  /**
   * Per-call model override. Recognised tiers: fable / opus / sonnet / haiku (see the
   * alias chain in claudeCodeCall — an unrecognised string silently runs sonnet).
   * Defaults live in lib/model-tiers.ts; prefer setting them there over hardcoding here.
   */
  model?: string
}

// Every provider fetch gets a hard timeout. Without one, a stalled provider
// connection (rate-limit black-holing, network stall) hangs the WHOLE pipeline
// in the firmware stage and wedges the run lock — a hung fetch was the root
// cause of the "pipeline already in progress" lockups. On timeout the provider
// throws, the chain falls through, and callers degrade honestly.
const LLM_TIMEOUT_MS = 120_000
// The Claude Code CLI path is slower than a raw fetch: full CLI spin-up (loads
// the local config + MCP context) PLUS generation. A complex board's netlist can
// take past the 120s fetch budget, and on timeout it wrongly falls through to the
// (often out-of-credit) metered API. Give the CLI its own, longer wall.
const CLAUDE_CLI_TIMEOUT_MS = 300_000

/**
 * Thrown when the Claude Code CLI child was killed by its execution wall.
 * callLLMText treats this DIFFERENTLY from a spawn/output failure: a timed-out
 * generation must NOT fall through to the metered API — the CLI wall exists
 * precisely to avoid metered spend, and a generation that outran the 300s CLI
 * wall would blow the API's 120s fetch wall anyway.
 */
export class CliTimeoutError extends Error {}

async function openaiCall(system: string, user: string, key?: string, model?: string): Promise<string> {
  const k = key || process.env.OPENAI_API_KEY
  const m = model || process.env.OPENAI_MODEL || 'gpt-5.1'
  if (!k) throw new Error('no openai key')
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${k}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: m,
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

async function geminiCall(system: string, user: string, key?: string, model?: string): Promise<string> {
  const k = key || process.env.GEMINI_API_KEY
  const m = model || process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview'
  if (!k) throw new Error('no gemini key')
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${k}`,
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
 * OpenRouter — the PLATFORM's funded provider. One key (OPENROUTER_API_KEY)
 * fronts the whole model menu (Claude, GPT, Gemini, Llama, …) via an
 * OpenAI-compatible API, so platform-funded runs (the free taste + Pro/
 * Enterprise) route here instead of four separate metered keys. `model` is a
 * full OpenRouter slug like 'anthropic/claude-sonnet-4.5' (see the catalog's
 * openrouterModel). BYOK users hit their own native provider, not this.
 */
async function openrouterCall(system: string, user: string, key?: string, model?: string): Promise<string> {
  const k = key || process.env.OPENROUTER_API_KEY
  const m = model || process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5'
  if (!k) throw new Error('no openrouter key')
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${k}`,
      'content-type': 'application/json',
      // OpenRouter attribution headers (optional but recommended)
      'HTTP-Referer': process.env.APP_URL || 'https://compose.firstlight.build',
      'X-Title': 'FirstLight Compose',
    },
    body: JSON.stringify({
      model: m,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!r.ok) throw new Error(`openrouter HTTP ${r.status}`)
  const d = await r.json()
  const t = d.choices?.[0]?.message?.content
  if (!t) throw new Error('openrouter empty')
  return t
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
  const { claudeBin } = await import('@/lib/toolchain')
  const bin = claudeBin()
  // Map the model string to a CLI alias. NOTE the trap in the final `: 'sonnet'`
  // fallback: any string this chain does not recognise SILENTLY runs sonnet. That is
  // why 'claude-fable-5' used to become sonnet with no error (the CLI does support a
  // 'fable' alias — verified: `claude -p --model fable` returns cleanly). Keep this
  // chain in sync when adding a tier, or the new model quietly never runs.
  const alias = /fable/i.test(model || '') ? 'fable'
    : /opus/i.test(model || '') ? 'opus'
      : /haiku/i.test(model || '') ? 'haiku'
        : 'sonnet'
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  // Fast headless mode (opt out with FL_CLI_FAST=0). Every call used to pay the
  // FULL interactive-session spin-up: CLAUDE.md auto-discovery, skills/plugins,
  // hooks, and MCP server init (the repo's colab MCP boots a uvx python env).
  // Measured on a trivial prompt (3-sample medians, claude 2.1.209):
  //   plain flags 6.0s -> with --safe-mode 2.4s  (~3.6s saved PER CALL).
  // --safe-mode disables all customizations but explicitly keeps auth working
  // (OAuth/keychain still read — verified live with ANTHROPIC_API_KEY stripped),
  // and the JSON envelope is byte-for-byte the same shape (type/result/is_error).
  // It ALSO stops the repo's CLAUDE.md leaking into these supposedly hermetic
  // prompts (without it, "say OK" replies referenced this repo's contents).
  // --no-session-persistence: don't write every pipeline call to disk as a
  // resumable session (no timing cost, avoids session-list pollution).
  // NOT used: --bare (never reads OAuth -> would break subscription auth);
  // --resume/--continue session reuse (prior turns would leak into unrelated
  // calls with different system prompts — a correctness regression — and it
  // saves nothing anyway: each resume still pays full process spin-up).
  const fastFlags = process.env.FL_CLI_FAST === '0' ? [] : ['--safe-mode', '--no-session-persistence']
  return await new Promise<string>((resolve, reject) => {
    const t0 = Date.now()
    const cp = spawn(bin, ['-p', '--model', alias, '--output-format', 'json', ...fastFlags], { env, timeout: CLAUDE_CLI_TIMEOUT_MS })
    let out = '', err = ''
    cp.stdout.on('data', (d) => (out += d))
    cp.stderr.on('data', (d) => (err += d))
    cp.on('error', (e) => reject(new Error(`claude-code spawn: ${e.message}`)))
    cp.on('close', () => {
      // The spawn `timeout` kills the child with SIGTERM at the wall, which used
      // to surface as a misleading generic "bad output" parse failure. Detect the
      // kill (cp.killed + elapsed at/over the wall, with 1s scheduling slack) and
      // report the timeout distinctly, as a CliTimeoutError.
      const elapsed = Date.now() - t0
      const timedOut = cp.killed && elapsed >= CLAUDE_CLI_TIMEOUT_MS - 1_000
      try {
        const d = JSON.parse(out.trim())
        if (d.is_error) return reject(new Error(`claude-code: ${String(d.result || err).slice(0, 140)}`))
        if (!d.result) return reject(new Error('claude-code empty'))
        resolve(d.result)
      } catch {
        if (timedOut) return reject(new CliTimeoutError(`claude-code CLI timed out after ${Math.round(elapsed / 1000)}s (wall ${CLAUDE_CLI_TIMEOUT_MS / 1000}s)`))
        reject(new Error(`claude-code bad output: ${(err || out).slice(0, 140)}`))
      }
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
  openrouter: openrouterCall,
  'claude-code': claudeCodeCall,
}

const shouldUseClaudeCodeCli = () =>
  process.env.USE_CLAUDE_CODE_CLI === '1' || process.env.USE_CLAUDE_CODE_CLI === 'true'

/** Read a BYOK override out of request headers (x-llm-provider / x-llm-key). */
export function overrideFromHeaders(headers: Headers): LLMOverride | undefined {
  const provider = headers.get('x-llm-provider')?.trim().toLowerCase() || undefined
  const apiKey = headers.get('x-llm-key')?.trim() || undefined
  if (!apiKey) {
    // x-llm-provider WITHOUT x-llm-key is deliberately NOT honored: a bare
    // provider pin would steer requests (and platform-key spend) by header
    // without the caller bringing their own key, and BYOK's no-fallback
    // guarantee only makes sense when the key is the caller's. Warn instead of
    // silently ignoring, so a misconfigured client can see why its pin is inert.
    if (provider) console.warn(`[llm] ignoring x-llm-provider="${provider}": no x-llm-key header (BYOK requires both)`)
    return undefined
  }
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
  // Subscription (CLI) path is ADMIN-ONLY now: a plan-routed request carries a
  // platform provider pin (override.provider, no apiKey) chosen by
  // lib/plan-llm.ts, and must NOT borrow the subscription. So only fire the CLI
  // when there is NO provider pin and NO user key — i.e. the admin path, which
  // resolves to a model-only override.
  if (shouldUseClaudeCodeCli() && !override?.provider && !override?.apiKey) {
    try {
      return { text: await claudeCodeCall(system, user, undefined, override?.model), provider: 'claude-code (subscription)' }
    } catch (e) {
      // A CLI TIMEOUT must NOT fall through to the metered API: the CLI wall
      // exists precisely to avoid metered spend, and a generation that outran
      // the 300s CLI wall would blow the API's 120s fetch wall anyway. Only
      // genuine spawn/output failures (CLI missing, bad output) fall through.
      if (e instanceof CliTimeoutError) throw e
      /* fall through to platform chain */
    }
  }
  if (override?.apiKey) {
    const name = override.provider && PROVIDERS[override.provider] ? override.provider : 'anthropic'
    return {
      text: await PROVIDERS[name](system, user, override.apiKey, override.model),
      provider: `${name} (user key)`,
    }
  }
  // Platform provider PIN (plan-routed, no user key): run exactly the selected
  // provider on the PLATFORM key — no chain fallthrough, so a free user's Gemini
  // pick can't silently escalate to a paid provider on our dime.
  if (override?.provider && PROVIDERS[override.provider]) {
    return {
      text: await PROVIDERS[override.provider](system, user, undefined, override.model),
      provider: `${override.provider} (platform)`,
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
