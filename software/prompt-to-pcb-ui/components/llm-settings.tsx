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

import { useEffect, useId, useRef, useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import { KeyRound, Check, Trash2, X } from 'lucide-react'

const LS_PROVIDER = 'fl-llm-provider'
const LS_KEY = 'fl-llm-key'

export const LLM_PROVIDERS = [
  { id: '', label: 'Platform default' },
  { id: 'anthropic', label: 'Anthropic (Claude)' },
  { id: 'openai', label: 'OpenAI (GPT)' },
  { id: 'gemini', label: 'Google (Gemini)' },
  { id: 'nemotron', label: 'NVIDIA (Nemotron)' },
]

/** localStorage key for the selected model id (see components/model-selector). */
export const LS_MODEL = 'fl-model'

/** The model id the user picked in the selector, or '' for the plan default. */
export function selectedModelId(): string {
  if (typeof window === 'undefined') return ''
  try { return localStorage.getItem(LS_MODEL)?.trim() || '' } catch { return '' }
}

/** Headers to attach to any AI-backed request: the browser-scope BYOK key (an
 *  account-scope key is resolved server-side from the session) plus the selected
 *  model id (x-fl-model), which plan routing honors on both BYOK and platform. */
export function llmHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  const h: Record<string, string> = {}
  try {
    // Read both before attaching either: a partial read must not mismatch key/provider.
    const key = localStorage.getItem(LS_KEY)?.trim()
    const provider = localStorage.getItem(LS_PROVIDER)?.trim()
    if (key) {
      h['x-llm-key'] = key
      if (provider) h['x-llm-provider'] = provider
    }
  } catch { /* No readable browser override; account/plan routing stays server-side. */ }
  const model = selectedModelId()
  if (model) h['x-fl-model'] = model
  return h
}

type AccountKey = { provider: string; last4: string; addedAt: string } | null

function accountKeyFrom(data: unknown): AccountKey {
  if (!data || typeof data !== 'object' || !('key' in data)) throw new Error('Invalid account key response.')
  const key = data.key
  if (key === null) return null
  if (!key || typeof key !== 'object' || !('provider' in key) || typeof key.provider !== 'string'
    || !('last4' in key) || typeof key.last4 !== 'string'
    || !('addedAt' in key) || typeof key.addedAt !== 'string') throw new Error('Invalid account key response.')
  return { provider: key.provider, last4: key.last4, addedAt: key.addedAt }
}

export function LLMSettings() {
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState('')
  const [key, setKey] = useState('')
  const [scope, setScope] = useState<'browser' | 'account'>('browser')
  const [accountKey, setAccountKey] = useState<AccountKey>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [browserActive, setBrowserActive] = useState(false)
  const [storageError, setStorageError] = useState('')
  const [accountError, setAccountError] = useState('')
  const [accountLoaded, setAccountLoaded] = useState(false)
  const [accountLoading, setAccountLoading] = useState(false)
  const [readAttempt, setReadAttempt] = useState(0)
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null)
  const readController = useRef<AbortController | null>(null)
  const mutationController = useRef<AbortController | null>(null)
  const mutationBusy = useRef(false)
  const mounted = useRef(false)
  const fieldId = useId()

  useEffect(() => {
    mounted.current = true
    try {
      const storedProvider = localStorage.getItem(LS_PROVIDER) ?? ''
      const storedKey = localStorage.getItem(LS_KEY) ?? ''
      setProvider(storedProvider)
      setKey(storedKey)
      setBrowserActive(!!storedKey.trim())
    } catch {
      setStorageError('Browser storage is unavailable. Browser key status is unknown; requests cannot use an unreadable browser key. You can retry saving or use My account.')
    }
    return () => {
      mounted.current = false
      readController.current?.abort()
      mutationController.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!open || mutationBusy.current) return
    const controller = new AbortController()
    readController.current = controller
    let current = true
    let timedOut = false
    setAccountLoading(true)
    setAccountError('')
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 15000)
    async function load() {
      try {
        const response = await fetch('/api/account/llm-key', { cache: 'no-store', signal: controller.signal })
        if (!response.ok) throw new Error(response.status === 401
          ? 'Sign in to view your account key.' : `Account key request failed (HTTP ${response.status}).`)
        const value = accountKeyFrom(await response.json())
        controller.signal.throwIfAborted()
        if (current && readController.current === controller) {
          setAccountKey(value)
          setAccountLoaded(true)
        }
      } catch (reason) {
        if (current && readController.current === controller) setAccountError(timedOut
          ? 'Account key lookup timed out. Try again.'
          : reason instanceof Error && !controller.signal.aborted ? reason.message : 'Could not load your account key. Try again.')
      } finally {
        clearTimeout(timeout)
        if (current && readController.current === controller) setAccountLoading(false)
      }
    }
    void load()
    return () => { current = false; clearTimeout(timeout); controller.abort() }
  }, [open, readAttempt])

  async function mutateAccount(action: 'save' | 'remove') {
    if (mutationBusy.current) return
    mutationBusy.current = true
    setBusy(action); setError(''); setSaved(false)
    // An older GET must not undo a successful save/delete, even if abort is ignored.
    readController.current?.abort()
    readController.current = null
    setAccountLoading(false)
    const controller = new AbortController()
    mutationController.current = controller
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch('/api/account/llm-key', action === 'save' ? {
        method: 'PUT', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: provider || 'anthropic', key: key.trim() }),
      } : { method: 'DELETE', signal: controller.signal })
      const data: unknown = await response.json()
      if (!response.ok) throw new Error(response.status === 401 ? 'Sign in before changing your account key.' : `Account key ${action} failed (HTTP ${response.status}).`)
      let next: AccountKey = null
      if (action === 'save') {
        next = accountKeyFrom(data)
        if (!next) throw new Error('The saved account key could not be confirmed.')
      } else if (!data || typeof data !== 'object' || !('ok' in data) || data.ok !== true) {
        throw new Error('Account key removal could not be confirmed.')
      }
      controller.signal.throwIfAborted()
      if (!mounted.current) return
      setAccountKey(next); setAccountLoaded(true); setAccountError('')
      // Removing an account key must not erase an unrelated, unsaved browser draft.
      if (action === 'save') { setKey(''); setSaved(true) }
    } catch {
      if (mounted.current) {
        setError(`Could not confirm account key ${action === 'save' ? 'save' : 'removal'}. Your input and last known key details have been kept. Check account status before retrying.`)
        setAccountError('Account key status may be out of date. Try again to check it.')
      }
    } finally {
      clearTimeout(timeout)
      mutationBusy.current = false
      if (mounted.current) setBusy(null)
    }
  }

  async function save() {
    if (mutationBusy.current) return
    setError(''); setSaved(false)
    if (scope === 'account') {
      if (!key.trim()) { setError('Enter a key to save to your account. Use Remove account key to delete an existing key.'); return }
      await mutateAccount('save')
      return
    }
    try {
      const storage = localStorage
      const previousProvider = storage.getItem(LS_PROVIDER)
      const previousKey = storage.getItem(LS_KEY)
      try {
        // Remove the old key before changing provider, so partial writes never pair them.
        storage.removeItem(LS_KEY)
        storage.setItem(LS_PROVIDER, provider)
        storage.setItem(LS_KEY, key.trim())
        if (storage.getItem(LS_PROVIDER) !== provider || storage.getItem(LS_KEY) !== key.trim()) throw new Error('Storage write was not retained.')
      } catch (reason) {
        try {
          storage.removeItem(LS_KEY)
          if (previousProvider === null) storage.removeItem(LS_PROVIDER)
          else storage.setItem(LS_PROVIDER, previousProvider)
          if (previousKey !== null) storage.setItem(LS_KEY, previousKey)
        } catch { /* State is uncertain; never claim a save or a clear. */ }
        throw reason
      }
      setBrowserActive(!!key.trim()); setStorageError(''); setSaved(true)
    } catch {
      setStorageError('Browser key save could not be confirmed. Your input has been kept. Browser key status is unknown; retry Save when storage is available or use My account.')
    }
  }

  const active = (!storageError && browserActive) || (accountLoaded && !accountError && !!accountKey)

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        type="button"
        className={`rounded-sm p-1 hover:bg-secondary ${
          active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
        }`}
        aria-label="AI provider settings"
        title={active ? 'Using your API key' : 'AI provider settings'}
      >
        <KeyRound className="size-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={8} className="z-[60]">
        <Popover.Popup className="max-h-[var(--available-height)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-border bg-card p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between gap-2">
            <Popover.Title className="text-xs font-semibold text-foreground">AI provider</Popover.Title>
            <Popover.Close aria-label="Close AI provider settings" className="rounded-sm p-1 text-muted-foreground hover:bg-secondary">
              <X className="size-4" />
            </Popover.Close>
          </div>
          {storageError && <p role="alert" className="mb-2 text-[11px] text-destructive">{storageError}</p>}
          {accountLoading && <p role="status" className="mb-2 text-[11px] text-muted-foreground">Checking account key…</p>}
          {accountError && (
            <div className="mb-2 text-[11px]">
              <p role="alert" className="text-destructive">{accountError}</p>
              {accountLoaded && <p className="text-muted-foreground">Last known account state shown below.</p>}
              <button type="button" disabled={!!busy || accountLoading} onClick={() => setReadAttempt(value => value + 1)}
                className="mt-1 rounded-sm border border-border px-2 py-1 disabled:opacity-50">Try again</button>
            </div>
          )}
          {accountLoaded && !accountKey && !accountLoading && !accountError && (
            <p className="mb-2 text-[11px] text-muted-foreground">No account key saved.</p>
          )}
          {accountKey && (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-sm border border-border bg-secondary/50 px-2 py-1.5">
              <span className="text-[11px] text-foreground">
                Account key: {accountKey.provider} ····{accountKey.last4}
              </span>
              <button
                type="button"
                onClick={() => mutateAccount('remove')}
                disabled={!!busy}
                aria-busy={busy === 'remove'}
                className="rounded-sm p-0.5 text-muted-foreground hover:text-destructive"
                aria-label="Remove account key"
                title="Remove account key"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          )}
          <label htmlFor={`${fieldId}-provider`} className="mb-1 block text-[11px] text-muted-foreground">Provider</label>
          <select
            id={`${fieldId}-provider`}
            value={provider}
            disabled={!!busy}
            onChange={(e) => { setProvider(e.target.value); setSaved(false) }}
            className="mb-2 w-full rounded-sm border border-border bg-background px-2 py-1.5 text-xs text-foreground"
          >
            {LLM_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <label htmlFor={`${fieldId}-key`} className="mb-1 block text-[11px] text-muted-foreground">API key</label>
          <input
            id={`${fieldId}-key`}
            autoComplete="off"
            type="password"
            value={key}
            disabled={!!busy}
            onChange={(e) => { setKey(e.target.value); setSaved(false) }}
            placeholder="Your API key"
            className="mb-2 w-full rounded-sm border border-border bg-background px-2 py-1.5 text-xs text-foreground"
          />
          <fieldset disabled={!!busy} className="mb-2 flex gap-3 text-[11px] text-muted-foreground">
            <legend className="mb-1">Save key to</legend>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name={`${fieldId}-scope`}
                checked={scope === 'browser'}
                onChange={() => { setScope('browser'); setSaved(false); setError('') }}
              />
              This browser only
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name={`${fieldId}-scope`}
                checked={scope === 'account'}
                onChange={() => { setScope('account'); setSaved(false); setError('') }}
              />
              My account
            </label>
          </fieldset>
          <button
            type="button"
            onClick={save}
            disabled={!!busy}
            aria-busy={busy === 'save'}
            className="flex w-full items-center justify-center gap-1 rounded-sm bg-primary px-2 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
          >
            {saved ? <Check className="size-3.5" /> : null}
            {busy === 'save' ? 'Saving…' : saved ? 'Saved' : 'Save'}
          </button>
          {busy === 'remove' && <p role="status" className="mt-1 text-[11px] text-muted-foreground">Removing account key…</p>}
          {saved && <p role="status" className="mt-1 text-[11px] text-muted-foreground">{scope === 'browser' ? 'Browser settings saved.' : 'Account key saved.'}</p>}
          {error && <p role="alert" className="mt-1 text-[10px] text-destructive">{error}</p>}
          <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
            {scope === 'browser'
              ? 'Browser scope: the key stays in this browser and is only sent to authenticate your own requests.'
              : 'Account scope: stored encrypted on the server so API and background jobs use it too. The key is never returned by this settings API.'}{' '}
            With your own key set, runs keep working even at 0 credits.{' '}
            {scope === 'browser'
              ? 'Save an empty browser key to remove the browser override. An account key, if set, still applies before the platform default.'
              : 'Use Remove account key to delete it. A browser key, if set, still takes precedence.'}
          </p>
        </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
