'use client'

/**
 * Top-level build-status badge — the honesty layer. Reflects exactly what
 * happened to a run:
 *   Generated successfully        — passed, no substitutions
 *   Generated with substitutions  — passed, but the recovery loop substituted
 *   Partially supported           — passed with dropped/unsupported items
 *   Failed with blockers          — gate failed
 * A substitution is never dressed up as full success.
 */

import { useEffect, useState } from 'react'
import { CheckCircle2, GitBranch, AlertTriangle, XCircle } from 'lucide-react'

export function BuildStatus({ runId, status }: { runId: string | null; status: string }) {
  const [subs, setSubs] = useState(0)

  useEffect(() => {
    if (!runId) {
      setSubs(0)
      return
    }
    let cancelled = false
    fetch(`/runs/${runId}/data/recovery.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return
        const list = Array.isArray(d) ? d : d ? [d] : []
        setSubs(list.filter((x: { recovered?: boolean; proposed?: string }) => x.recovered !== false && x.proposed).length)
      })
      .catch(() => !cancelled && setSubs(0))
    return () => {
      cancelled = true
    }
  }, [runId])

  const failed = /FAIL/i.test(status)
  let label: string
  let Icon = CheckCircle2
  let cls = 'border-success/40 bg-success/10 text-success'
  if (failed) {
    label = 'Failed with blockers'
    Icon = XCircle
    cls = 'border-destructive/40 bg-destructive/10 text-destructive'
  } else if (subs > 0) {
    label = `Generated with substitution${subs > 1 ? 's' : ''}`
    Icon = GitBranch
    cls = 'border-amber-500/40 bg-amber-500/10 text-amber-500'
  } else if (/PARTIAL/i.test(status)) {
    label = 'Partially supported'
    Icon = AlertTriangle
    cls = 'border-amber-500/40 bg-amber-500/10 text-amber-500'
  } else {
    label = 'Generated successfully'
  }

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[11px] font-semibold ${cls}`}
      title={failed ? 'The board did not pass the DRC/ERC gates' : label}
    >
      <Icon className="size-3.5" />
      {label}
    </span>
  )
}
