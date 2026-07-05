'use client'

/**
 * Bring-your-own-key AI settings. The key lives ONLY in this browser's
 * localStorage and is sent per-request via the x-llm-key header, it is never
 * persisted server-side. With no key set, requests use the platform's
 * provider chain (subject to deployment env keys).
 */

import { useEffect, useRef, useState } from 'react'
import { KeyRound, Check } from 'lucide-react'

const LS_PROVIDER = 'fl-llm-provider'
const LS_KEY = 'fl-llm-key'

export const LLM_PROVIDERS = [
  { id: '', label: 'Platform default' },
  { id: 'anthropic', label: 'Anthropic (Claude)' },
  { id: 'openai', label: 'OpenAI (GPT)' },
  { id: 'gemini', label: 'Google (Gemini)' },
  { id: 'nemotron', label: 'NVIDIA (Nemotron)' },
]

/** Headers to attach to any AI-backed request. */
export function llmHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  const key = localStorage.getItem(LS_KEY)?.trim()
  if (!key) return {}
  const provider = localStorage.getItem(LS_PROVIDER)?.trim()
  const h: Record<string, string> = { 'x-llm-key': key }
  if (provider) h['x-llm-provider'] = provider
  return h
}

export function LLMSettings() {
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState('')
  const [key, setKey] = useState('')
  const [saved, setSaved] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setProvider(localStorage.getItem(LS_PROVIDER) ?? '')
    setKey(localStorage.getItem(LS_KEY) ?? '')
  }, [])

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  function save() {
    localStorage.setItem(LS_PROVIDER, provider)
    localStorage.setItem(LS_KEY, key.trim())
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const active = typeof window !== 'undefined' && !!key.trim()

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
        <div className="absolute right-0 top-8 z-50 w-72 rounded-md border border-border bg-card p-3 shadow-xl">
          <p className="mb-2 text-xs font-semibold text-foreground">AI provider</p>
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
            placeholder="Your API key (stored in this browser only)"
            className="mb-2 w-full rounded-sm border border-border bg-background px-2 py-1.5 text-xs text-foreground"
          />
          <button
            type="button"
            onClick={save}
            className="flex w-full items-center justify-center gap-1 rounded-sm bg-primary px-2 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
          >
            {saved ? <Check className="size-3.5" /> : null}
            {saved ? 'Saved' : 'Save'}
          </button>
          <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
            Your key never leaves this browser except to authenticate your own
            requests. Leave empty to use the platform default.
          </p>
        </div>
      )}
    </div>
  )
}
