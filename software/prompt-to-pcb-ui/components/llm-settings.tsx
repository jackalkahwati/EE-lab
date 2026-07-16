'use client'

/**
 * Bring-your-own-key AI settings, two scopes the user picks explicitly:
 *
 *  - "This browser": key lives ONLY in localStorage and rides each request as
 *    the x-llm-key header. Never persisted server-side. (Original behavior.)
 *  - "My account": key is stored server-side ENCRYPTED (AES-256-GCM under the
 *    deployment secret), so background/API jobs and other devices use it too.
 *    The server never returns the key — only provider + last 4.
 *
 * Either scope keeps BYOK semantics: only the chosen provider runs, on the
 *  user's key, with no silent fallback to platform keys. With a key set, runs
 *  continue even at 0 credits (the model spend is the user's own).
 */

import { useEffect, useRef, useState } from 'react'
import { KeyRound, Check, Trash2 } from 'lucide-react'

const LS_PROVIDER = 'fl-llm-provider'
const LS_KEY = 'fl-llm-key'

export const LLM_PROVIDERS = [
  { id: '', label: 'Platform default' },
  { id: 'anthropic', label: 'Anthropic (Claude)' },
  { id: 'openai', label: 'OpenAI (GPT)' },
  { id: 'gemini', label: 'Google (Gemini)' },
  { id: 'nemotron', label: 'NVIDIA (Nemotron)' },
]

/** Headers to attach to any AI-backed request (browser-scope key only; an
 *  account-scope key is resolved server-side from the session). */
export function llmHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  const key = localStorage.getItem(LS_KEY)?.trim()
  if (!key) return {}
  const provider = localStorage.getItem(LS_PROVIDER)?.trim()
  const h: Record<string, string> = { 'x-llm-key': key }
  if (provider) h['x-llm-provider'] = provider
  return h
}

type AccountKey = { provider: string; last4: string; addedAt: string } | null

export function LLMSettings() {
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState('')
  const [key, setKey] = useState('')
  const [scope, setScope] = useState<'browser' | 'account'>('browser')
  const [accountKey, setAccountKey] = useState<AccountKey>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setProvider(localStorage.getItem(LS_PROVIDER) ?? '')
    setKey(localStorage.getItem(LS_KEY) ?? '')
  }, [])

  useEffect(() => {
    if (!open) return
    fetch('/api/account/llm-key')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAccountKey(d?.key ?? null))
      .catch(() => {})
  }, [open])

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  async function save() {
    setError('')
    if (scope === 'browser') {
      localStorage.setItem(LS_PROVIDER, provider)
      localStorage.setItem(LS_KEY, key.trim())
    } else {
      const r = await fetch('/api/account/llm-key', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: provider || 'anthropic', key: key.trim() }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        setError(d?.error || 'save failed')
        return
      }
      setAccountKey(d.key ?? null)
      setKey('')
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  async function removeAccountKey() {
    await fetch('/api/account/llm-key', { method: 'DELETE' }).catch(() => {})
    setAccountKey(null)
  }

  const active =
    (typeof window !== 'undefined' && !!localStorage.getItem(LS_KEY)?.trim()) || !!accountKey

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`rounded-sm p-1 hover:bg-secondary ${
          active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
        }`}
        aria-label="AI provider settings"
        title={active ? 'Using your API key' : 'AI provider settings'}
      >
        <KeyRound className="size-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-50 w-80 rounded-md border border-border bg-card p-3 shadow-xl">
          <p className="mb-2 text-xs font-semibold text-foreground">AI provider</p>
          {accountKey && (
            <div className="mb-2 flex items-center justify-between rounded-sm border border-border bg-secondary/50 px-2 py-1.5">
              <span className="text-[11px] text-foreground">
                Account key: {accountKey.provider} ····{accountKey.last4}
              </span>
              <button
                type="button"
                onClick={removeAccountKey}
                className="rounded-sm p-0.5 text-muted-foreground hover:text-destructive"
                aria-label="Remove account key"
                title="Remove account key"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          )}
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="mb-2 w-full rounded-sm border border-border bg-background px-2 py-1.5 text-xs text-foreground"
          >
            {LLM_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Your API key"
            className="mb-2 w-full rounded-sm border border-border bg-background px-2 py-1.5 text-xs text-foreground"
          />
          <div className="mb-2 flex gap-3 text-[11px] text-muted-foreground">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="fl-key-scope"
                checked={scope === 'browser'}
                onChange={() => setScope('browser')}
              />
              This browser only
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="fl-key-scope"
                checked={scope === 'account'}
                onChange={() => setScope('account')}
              />
              My account
            </label>
          </div>
          <button
            type="button"
            onClick={save}
            className="flex w-full items-center justify-center gap-1 rounded-sm bg-primary px-2 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
          >
            {saved ? <Check className="size-3.5" /> : null}
            {saved ? 'Saved' : 'Save'}
          </button>
          {error && <p className="mt-1 text-[10px] text-destructive">{error}</p>}
          <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
            {scope === 'browser'
              ? 'Browser scope: the key stays in this browser and is only sent to authenticate your own requests.'
              : 'Account scope: stored encrypted on the server so API and background jobs use it too; readable by no one, removable anytime.'}{' '}
            With your own key set, runs keep working even at 0 credits. Leave
            empty to use the platform default.
          </p>
        </div>
      )}
    </div>
  )
}
