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
import { useEffect, useState } from 'react'
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
  const [models, setModels] = useState<ModelOpt[]>([])
  const [sel, setSel] = useState('')
  const [plan, setPlan] = useState<string>('free')

  useEffect(() => {
    setSel(localStorage.getItem(LS_MODEL)?.trim() || '')
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
    setSel(id)
    if (id) localStorage.setItem(LS_MODEL, id)
    else localStorage.removeItem(LS_MODEL)
  }

  const locked = models.filter((m) => !m.allowed)

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span title="Model used for design steps">Model</span>
      <select
        value={sel}
        onChange={(e) => pick(e.target.value)}
        className="max-w-[200px] rounded border border-border bg-transparent px-1.5 py-0.5 text-[11px] outline-none"
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
          href="/account"
          className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/20"
          title="Frontier models need Pro/Enterprise, or add your own API key"
        >
          Unlock
        </a>
      )}
    </div>
  )
}
