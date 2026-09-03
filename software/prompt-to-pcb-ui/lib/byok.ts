/**
 * Per-account BYOK (bring-your-own-key) storage + resolution.
 *
 * The browser-local BYOK path (components/llm-settings.tsx -> x-llm-key
 * header) only covers requests the BROWSER makes. Server-side work — v1 API
 * jobs, the pipeline's early server-side kicks — never saw the user's key.
 * This module stores an OPTIONAL per-account key (AES-256-GCM, key derived
 * from AUTH_SECRET) so every authenticated request can resolve it.
 *
 * Resolution order (overrideForRequest):
 *   1. x-llm-key/x-llm-provider headers — explicit per-request key wins
 *   2. the signed-in account's stored key
 *   3. undefined -> platform-key chain
 * BYOK semantics downstream are unchanged: named provider only, no silent
 * fallback to platform keys (a bad user key must surface, not bill us).
 *
 * The stored key is never returned by any API — only provider + last4.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { authSecret, getUser, sessionEmail, updateUser, type UserRecord } from '@/lib/auth'
import { overrideFromHeaders, type LLMOverride } from '@/lib/llm'

export interface StoredLlmKey {
  provider: string
  /** base64(iv).base64(tag).base64(ciphertext) — AES-256-GCM */
  enc: string
  last4: string
  addedAt: string
}

function encryptionKey(): Buffer {
  // authSecret() falls back to the dev secret only outside production and
  // THROWS in production when neither AUTH_SECRET nor FL_PASSWORD is set — a
  // known checked-in key must never encrypt customer API keys at rest.
  return scryptSync(authSecret(), 'fl-byok-v1', 32)
}

export function encryptKey(apiKey: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ct = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64')).join('.')
}

export function decryptKey(enc: string): string {
  const [iv, tag, ct] = enc.split('.').map((s) => Buffer.from(s, 'base64'))
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

const PROVIDERS = new Set(['anthropic', 'openai', 'gemini', 'nemotron'])

export function setAccountLlmKey(email: string, provider: string, apiKey: string): StoredLlmKey {
  const p = provider.trim().toLowerCase() || 'anthropic'
  if (!PROVIDERS.has(p)) throw new Error(`unknown provider: ${p}`)
  const key = apiKey.trim()
  if (key.length < 12) throw new Error('key looks too short')
  const stored: StoredLlmKey = {
    provider: p,
    enc: encryptKey(key),
    last4: key.slice(-4),
    addedAt: new Date().toISOString(),
  }
  updateUser(email, (u) => {
    ;(u as UserRecord & { llmKey?: StoredLlmKey }).llmKey = stored
  })
  return stored
}

export function clearAccountLlmKey(email: string) {
  updateUser(email, (u) => {
    delete (u as UserRecord & { llmKey?: StoredLlmKey }).llmKey
  })
}

/** Masked description for UI display — never the key itself. */
export function describeAccountLlmKey(u: UserRecord): { provider: string; last4: string; addedAt: string } | null {
  const k = (u as UserRecord & { llmKey?: StoredLlmKey }).llmKey
  return k ? { provider: k.provider, last4: k.last4, addedAt: k.addedAt } : null
}

function accountOverride(email: string | null): LLMOverride | undefined {
  if (!email) return undefined
  const u = getUser(email)
  const k = u && (u as UserRecord & { llmKey?: StoredLlmKey }).llmKey
  if (!k) return undefined
  try {
    return { provider: k.provider, apiKey: decryptKey(k.enc) }
  } catch {
    // AUTH_SECRET rotated or record corrupt: treat as no key (platform chain),
    // never as a half-working override
    return undefined
  }
}

/** Does this request carry ANY user key (header or account)? Used by the
 *  credit gate: out-of-credits users may keep running on their own key. */
export function hasByok(req: Request): boolean {
  return !!overrideForRequest(req)
}

/** The BYOK override for a request: explicit header first, else the signed-in
 *  account's stored key, else undefined (platform chain). */
export function overrideForRequest(req: Request): LLMOverride | undefined {
  return overrideFromHeaders(req.headers) ?? accountOverride(sessionEmail(req))
}
