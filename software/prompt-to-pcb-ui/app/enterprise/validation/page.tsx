'use client'

/**
 * Validation console — FL-1 validation sessions and assets. This is the bridge
 * to real physical evidence: sessions carry a plan, an operator, measurements,
 * and pass/fail — and feed the (currently empty) physical evidence ledger.
 * Read-honest: a planned/blocked session claims nothing; only recorded
 * measurements + signed adjudication promote a board.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { EnterpriseNav } from '@/components/enterprise-nav'

type Any = Record<string, any>

const STATUS_STYLE: Record<string, string> = {
  planned: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  scheduled: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  in_progress: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  passed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  blocked: 'border-destructive/40 bg-destructive/10 text-destructive',
}

export default function ValidationPage() {
  const [db, setDb] = useState<Any | null>(null)
  useEffect(() => {
    fetch('/api/enterprise', { cache: 'no-store' }).then((r) => r.json()).then(setDb).catch(() => {})
  }, [])
  if (!db) return <div className="p-6 text-xs text-muted-foreground">Loading validation…</div>
  if (db.error) return <div className="p-6 text-xs text-muted-foreground">Sign in required.</div>

  const boards: Any[] = db.boards ?? []
  const boardName = (id: string) => boards.find((b) => b.board_id === id)?.name ?? id
  const sessions: Any[] = db.validation_sessions ?? []
  const assets: Any[] = db.fl1_assets ?? []
  const physicalEvidence = (db.evidence ?? []).filter((e: Any) => e.status === 'accepted')

  return (
    <div className="min-h-screen bg-background p-4 text-xs text-foreground">
      <div className="mb-3 flex items-center gap-3">
        <Link href="/enterprise" className="text-muted-foreground hover:text-foreground">← Programs</Link>
        <h1 className="text-base font-semibold">Validation console</h1>
        <span className="text-muted-foreground">{sessions.length} session(s) · {assets.length} FL-1 asset(s)</span>
      </div>
      <EnterpriseNav />

      <div className="mb-3 rounded-md border border-border bg-muted/10 px-3 py-2 text-[10px] text-muted-foreground">
        Physical evidence ledger:{' '}
        <span className="font-mono text-foreground">
          {physicalEvidence.length ? `${physicalEvidence.length} accepted item(s)` : 'EMPTY'}
        </span>{' '}
        — a planned session claims nothing; only recorded measurements + signed
        adjudication promote a board to physically_validated.
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="rounded-md border border-border">
          <div className="border-b border-border px-3 py-2 text-xs font-semibold">Validation sessions</div>
          <div className="divide-y divide-border">
            {sessions.length === 0 && <p className="px-3 py-3 text-muted-foreground">No sessions planned.</p>}
            {sessions.map((s) => (
              <div key={s.session_id} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{boardName(s.board_id)}</span>
                  <span className={cn('rounded-sm border px-1.5 py-0.5 font-mono text-[10px]',
                    STATUS_STYLE[s.status] ?? 'border-border bg-muted/30 text-muted-foreground')}>
                    {s.status}
                  </span>
                  <span className="ml-auto font-mono text-[9px] text-muted-foreground">{s.session_id}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-muted-foreground">
                  <span>operator: {s.operator ?? 'unassigned'}</span>
                  <span>review: {s.review_state ?? '—'}</span>
                  <span>measurements: {(s.measurements ?? []).length}</span>
                  <span>evidence: {(s.evidence_ids ?? []).length}</span>
                  {(s.failures ?? []).length > 0 && (
                    <span className="text-destructive">failures: {(s.failures ?? []).length}</span>
                  )}
                </div>
                {s.blocked_reason && <div className="mt-1 text-[10px] text-destructive">blocked: {s.blocked_reason}</div>}
                {(s.claims_affected ?? []).length > 0 && (
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    claims affected: {(s.claims_affected ?? []).join(' · ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-border">
          <div className="border-b border-border px-3 py-2 text-xs font-semibold">FL-1 validation assets</div>
          <div className="divide-y divide-border">
            {assets.length === 0 && <p className="px-3 py-3 text-muted-foreground">No FL-1 assets registered.</p>}
            {assets.map((a, i) => (
              <div key={i} className="px-3 py-2">
                <div className="text-xs font-medium">{a.name ?? a.asset_id ?? `asset ${i + 1}`}</div>
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  {a.asset_type ?? a.kind ?? 'FL-1 instrument'}{a.status ? ` · ${a.status}` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
