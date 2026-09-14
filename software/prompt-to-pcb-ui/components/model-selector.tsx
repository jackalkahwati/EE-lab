'use client'

/**
 * Model selector — the pull-down the customer sets BEFORE running.
 *
 * Reads the plan's model catalog from /api/auth/me (each entry flagged
 * `allowed` for the signed-in plan). Allowed models are selectable; locked
 * frontier models render disabled with their required plan, as an upsell/BYOK
 * hint. The choice is stored in localStorage (LS_MODEL) so it rides every run:
 * the EventSource run URLs append `&model=<id>` and POST calls send x-fl-model
 * (see llmHeaders). Plan enforcement is server-side (lib/plan-llm.ts); this is
 * only the picker.
 */
import { useEffect, useId, useState } from 'react'
import { LS_MODEL } from '@/components/llm-settings'

interface ModelOpt {
  id: string
  label: string
  blurb: string
  minPlan: 'free' | 'pro' | 'enterprise'
  creditMult: number
  allowed: boolean
}

export function ModelSelector() {
  const selectId = useId()
  const [models, setModels] = useState<ModelOpt[]>([])
  const [sel, setSel] = useState('')
  const [plan, setPlan] = useState<string>('free')
  const [storageNote, setStorageNote] = useState<string | null>(null)

  useEffect(() => {
    try {
      setSel(localStorage.getItem(LS_MODEL)?.trim() || '')
    } catch {
      setSel('')
      setStorageNote('Browser storage unavailable. Showing Auto because the saved model could not be read.')
    }
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d?.models)) setModels(d.models)
        if (d?.user?.plan) setPlan(d.user.plan)
      })
      .catch(() => {})
  }, [])

  if (!models.length) return null

  function pick(id: string) {
    try {
      if (id) localStorage.setItem(LS_MODEL, id)
      else localStorage.removeItem(LS_MODEL)
      setSel(id)
      setStorageNote(null)
    } catch {
      // Run routing reads storage, so never display an unsaved choice as active.
      try {
        setSel(localStorage.getItem(LS_MODEL)?.trim() || '')
        setStorageNote('Model choice not saved. Browser storage could not be updated; showing the saved selection.')
      } catch {
        setSel('')
        setStorageNote('Model choice not saved. Browser storage unavailable; showing Auto because the saved model could not be read.')
      }
    }
  }

  const locked = models.filter((m) => !m.allowed)

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
      <label htmlFor={selectId} title="Model used for design steps">Model</label>
      <select
        id={selectId}
        value={sel}
        aria-describedby={storageNote ? `${selectId}-storage` : undefined}
        onChange={(e) => pick(e.target.value)}
        className="max-w-[200px] rounded border border-border bg-transparent px-1.5 py-0.5 text-[11px] focus-visible:outline-2 focus-visible:outline-primary"
      >
        <option value="">Auto ({plan} default)</option>
        {models.map((m) => (
          <option key={m.id} value={m.id} disabled={!m.allowed}>
            {m.label}
            {m.allowed ? '' : ` — ${m.minPlan[0].toUpperCase()}${m.minPlan.slice(1)}`}
          </option>
        ))}
      </select>
      {locked.length > 0 && (
        <a
          href="/pricing"
          className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/20"
          title="Frontier models need Pro/Enterprise, or add your own API key"
        >
          Unlock
        </a>
      )}
      {storageNote && (
        <span id={`${selectId}-storage`} role="status" className="basis-full">
          {storageNote}
        </span>
      )}
    </div>
  )
}
