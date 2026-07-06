'use client'

/**
 * Recovery / Substitutions tab: the human-readable view of a run's
 * recovery.json. Every substitution the design-recovery loop made is shown in
 * full — original request, blocker, what it was replaced with, capabilities
 * preserved and lost, and whether it needs approval. Nothing is hidden, and a
 * substitution is never dressed up as native support for the original part.
 */

import { useEffect, useState } from 'react'
import { GitBranch, ArrowRight, Check, X, AlertTriangle, Wrench, Download } from 'lucide-react'

const LOOP_STYLE: Record<string, string> = {
  passed_without_recovery: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  recovered_and_passed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  recovered_with_substitution: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  failed_honestly: 'border-destructive/40 bg-destructive/10 text-destructive',
  unsupported: 'border-destructive/40 bg-destructive/10 text-destructive',
  needs_human_review: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
}

function RecoveryLoop({ runId }: { runId: string }) {
  const [loop, setLoop] = useState<any | null>(null)
  useEffect(() => {
    let off = false
    fetch(`/runs/${runId}/data/recovery-loop.json`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => !off && setLoop(d))
      .catch(() => {})
    return () => {
      off = true
    }
  }, [runId])
  if (!loop) return null
  return (
    <div className="mb-4 rounded-md border border-border bg-card p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Wrench className="size-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">Recovery loop</span>
        <span
          className={`rounded-sm border px-1.5 py-0.5 font-mono text-[10px] ${
            LOOP_STYLE[loop.final_status] ?? 'border-border text-muted-foreground'
          }`}
        >
          {loop.final_status}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {loop.attempts?.length ?? 1} attempt(s)
        </span>
        <a
          href={`/runs/${runId}/data/recovery-loop.json`}
          download
          className="ml-auto inline-flex items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20"
        >
          <Download className="size-3" /> recovery-report.json
        </a>
      </div>
      <div className="mb-2 font-mono text-[10px] text-muted-foreground">
        initial: {loop.initial_result?.status}, {loop.initial_result?.violations} viol,{' '}
        {loop.initial_result?.unconnected} unconn → final: {loop.final_result?.status},{' '}
        {loop.final_result?.violations} viol, {loop.final_result?.unconnected} unconn
      </div>
      {loop.design_changes?.length > 0 && (
        <div className="mb-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Attempted fixes
          </p>
          <ul className="space-y-0.5">
            {loop.design_changes.map((c: any, i: number) => (
              <li key={i} className="text-xs text-muted-foreground">
                <span className="font-mono text-foreground">{c.strategy}</span> — {c.change}
              </li>
            ))}
          </ul>
        </div>
      )}
      {loop.blocker && (
        <p className="mb-1 flex items-start gap-1.5 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <span>
            <span className="font-semibold text-foreground">Honest blocker: </span>
            {loop.blocker}
          </span>
        </p>
      )}
      {loop.phase8_capability_required && (
        <p className="rounded-sm border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-500">
          Requires the Phase-8 capability: <strong>{loop.phase8_capability_required}</strong>. Placement
          recovery could not resolve it without that router work.
        </p>
      )}
    </div>
  )
}

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
      <div className="h-full overflow-y-auto p-4">
        <RecoveryLoop runId={runId} />
        <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
          <Check className="size-6 text-success" />
          <p className="text-sm font-semibold text-foreground">No component substitutions</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Every requested part was built as specified. Any board-level repairs are
            shown in the recovery loop above.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <RecoveryLoop runId={runId} />
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
