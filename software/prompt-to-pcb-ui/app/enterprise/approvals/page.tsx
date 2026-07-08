'use client'

/**
 * Approvals inbox — the cross-program "what needs a human decision" queue.
 * Reads real approvals from the store; who may decide is set by RBAC and every
 * decision is audited. Read-first: the decision itself routes through the
 * audited dispatcher (manage/approve permissions), not from this view.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { EnterpriseNav } from '@/components/enterprise-nav'

type Any = Record<string, any>
const PENDING = ['pending', 'requested', 'awaiting']

const STATUS_STYLE: Record<string, string> = {
  approved: 'text-emerald-500', rejected: 'text-destructive',
  revoked: 'text-destructive', requested: 'text-amber-500',
  pending: 'text-amber-500', awaiting: 'text-amber-500',
}
// which role decides which approval (from the E5 policy)
const APPROVER: Record<string, string> = {
  approved_for_quote: 'procurement / org admin',
  approved_for_order: 'procurement / org admin',
  approve_architecture: 'reviewer',
  approve_package_release: 'reviewer',
  accept_physical_evidence: 'reviewer / engineer',
  mark_validation_passed: 'reviewer',
}

export default function ApprovalsPage() {
  const [db, setDb] = useState<Any | null>(null)
  useEffect(() => {
    fetch('/api/enterprise', { cache: 'no-store' }).then((r) => r.json()).then(setDb).catch(() => {})
  }, [])
  if (!db) return <div className="p-6 text-xs text-muted-foreground">Loading approvals…</div>
  if (db.error) return <div className="p-6 text-xs text-muted-foreground">Sign in required.</div>

  const boards: Any[] = db.boards ?? []
  const boardName = (id: string) => boards.find((b) => b.board_id === id)?.name ?? id
  const approvals: Any[] = db.approvals ?? []
  const pending = approvals.filter((a) => PENDING.includes(a.status))
  const decided = approvals.filter((a) => !PENDING.includes(a.status))

  const Row = ({ a }: { a: Any }) => (
    <div className="flex items-center gap-3 px-3 py-2">
      <span className="w-44 shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        {a.approval_type?.replace(/_/g, ' ')}
      </span>
      <button
        type="button"
        onClick={() => a.scope?.board_id && (window.location.href = `/enterprise?board=${a.scope.board_id}`)}
        className="min-w-0 flex-1 truncate text-left text-xs font-medium hover:text-primary">
        {a.scope?.board_id ? boardName(a.scope.board_id) : (a.scope?.program_id ? 'program-level' : '—')}
      </button>
      <span className="hidden shrink-0 text-[10px] text-muted-foreground sm:inline">
        req by {a.requested_by}{a.approver ? ` · by ${a.approver}` : ''}
      </span>
      <span className="w-28 shrink-0 text-right text-[10px] text-muted-foreground">
        decides: {APPROVER[a.approval_type] ?? 'admin'}
      </span>
      <span className={cn('w-16 shrink-0 text-right font-mono text-[11px]', STATUS_STYLE[a.status] ?? 'text-muted-foreground')}>
        {a.status}
      </span>
    </div>
  )

  return (
    <div className="min-h-screen bg-background p-4 text-xs text-foreground">
      <div className="mb-3 flex items-center gap-3">
        <Link href="/enterprise" className="text-muted-foreground hover:text-foreground">← Programs</Link>
        <h1 className="text-base font-semibold">Approvals</h1>
        <span className="text-muted-foreground">{pending.length} awaiting · {decided.length} decided</span>
      </div>
      <EnterpriseNav />

      <div className="space-y-4">
        <div className="rounded-md border border-border">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-semibold">Awaiting decision</span>
            <span className="font-mono text-[10px] text-amber-500">{pending.length}</span>
            <span className="ml-auto font-mono text-[9px] text-muted-foreground">
              quote/order gates block the money path until signed · every decision is audited
            </span>
          </div>
          <div className="divide-y divide-border">
            {pending.length === 0 && <p className="px-3 py-3 text-muted-foreground">Nothing awaiting a decision.</p>}
            {pending.map((a) => <Row key={a.approval_id} a={a} />)}
          </div>
        </div>

        <div className="rounded-md border border-border">
          <div className="border-b border-border px-3 py-2 text-xs font-semibold">Decided</div>
          <div className="divide-y divide-border">
            {decided.length === 0 && <p className="px-3 py-3 text-muted-foreground">No decisions yet.</p>}
            {decided.map((a) => <Row key={a.approval_id} a={a} />)}
          </div>
        </div>
      </div>
    </div>
  )
}
