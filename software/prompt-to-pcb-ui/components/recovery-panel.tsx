'use client'

/**
 * Recovery / Substitutions tab: the human-readable view of a run's
 * recovery.json. Every substitution the design-recovery loop made is shown in
 * full — original request, blocker, what it was replaced with, capabilities
 * preserved and lost, and whether it needs approval. Nothing is hidden, and a
 * substitution is never dressed up as native support for the original part.
 */

import { useEffect, useState } from 'react'
import { GitBranch, ArrowRight, Check, X, AlertTriangle } from 'lucide-react'

interface Recovery {
  original_request?: string
  blocker?: string
  substitution_type?: string
  proposed?: string
  replaces?: string
  capabilities_preserved?: string[]
  capabilities_lost?: string[]
  requires_approval?: boolean
  approval_note?: string
  confidence?: number
  status?: string
  note?: string
  recovered?: boolean
}

export function RecoveryPanel({ runId }: { runId: string | null }) {
  const [recs, setRecs] = useState<Recovery[] | null | undefined>(undefined)

  useEffect(() => {
    if (!runId) {
      setRecs(null)
      return
    }
    let cancelled = false
    fetch(`/runs/${runId}/data/recovery.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setRecs(Array.isArray(d) ? d : d ? [d] : [])
      })
      .catch(() => !cancelled && setRecs([]))
    return () => {
      cancelled = true
    }
  }, [runId])

  if (!runId) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        Select a run to see any design substitutions.
      </div>
    )
  }
  if (recs === undefined) {
    return <div className="p-6 text-sm text-muted-foreground">Loading substitutions…</div>
  }
  const subs = (recs ?? []).filter((r) => r.recovered !== false && r.proposed)
  if (subs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <Check className="size-6 text-success" />
        <p className="text-sm font-semibold text-foreground">No substitutions</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Every requested part and capability was built as specified — the design
          matches the request with no recovery needed.
        </p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-4 flex items-center gap-2">
        <GitBranch className="size-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">
          Design recovery — {subs.length} substitution{subs.length > 1 ? 's' : ''}
        </span>
        <span className="rounded-sm border border-primary/40 bg-primary/5 px-1.5 py-0.5 font-mono text-[10px] text-primary">
          intent preserved, not the original part
        </span>
      </div>

      <div className="space-y-4">
        {subs.map((r, i) => (
          <div key={i} className="rounded-md border border-border bg-card p-4">
            {/* headline: original -> substitution */}
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono text-muted-foreground line-through">
                {r.original_request ?? r.replaces}
              </span>
              <ArrowRight className="size-4 text-primary" />
              <span className="font-mono font-semibold text-foreground">{r.proposed}</span>
              {r.substitution_type && (
                <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {r.substitution_type.replace(/_/g, ' ')}
                </span>
              )}
              {r.status && (
                <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
                  {r.status}
                </span>
              )}
            </div>

            {/* blocker */}
            {r.blocker && (
              <div className="mb-3 flex items-start gap-1.5 text-xs">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                <span className="text-muted-foreground">
                  <span className="font-semibold text-foreground">Blocker: </span>
                  {r.blocker}
                </span>
              </div>
            )}

            {/* preserved / lost */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-success">
                  <Check className="size-3" /> Preserved
                </p>
                <ul className="space-y-0.5">
                  {(r.capabilities_preserved ?? []).map((c) => (
                    <li key={c} className="text-xs text-muted-foreground">
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-destructive">
                  <X className="size-3" /> Lost
                </p>
                <ul className="space-y-0.5">
                  {(r.capabilities_lost ?? []).map((c) => (
                    <li key={c} className="text-xs text-muted-foreground">
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* approval */}
            {r.requires_approval && (
              <div className="mt-3 flex items-start gap-1.5 rounded-sm border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                <span className="text-muted-foreground">
                  <span className="font-semibold text-amber-500">Approval required. </span>
                  {r.approval_note ?? 'This substitution changes the product; review before production.'}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
