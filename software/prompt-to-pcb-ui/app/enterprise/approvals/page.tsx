'use client'

/**
 * Approvals inbox — the cross-program decision queue, wired to the real
 * RBAC-gated dispatcher. Request a board review, then approve/reject it as the
 * logged-in user; permission denials and the audit trail are real. History is
 * immutable — only 'requested' approvals can be decided.
 */
import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { currentActor, enterpriseAction } from '@/lib/enterprise-actions'

type Any = Record<string, any>
const PENDING = ['pending', 'requested', 'awaiting']

const STATUS_STYLE: Record<string, string> = {
  approved: 'text-emerald-500', rejected: 'text-destructive',
  revoked: 'text-destructive', requested: 'text-amber-500',
}

export default function ApprovalsPage() {
  const [db, setDb] = useState<Any | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [pick, setPick] = useState('')
  const [me, setMe] = useState('')

  const refresh = useCallback(() => {
    fetch('/api/enterprise', { cache: 'no-store' }).then((r) => r.json()).then(setDb).catch(() => {})
  }, [])
  useEffect(() => { refresh(); currentActor().then(setMe) }, [refresh])

  if (!db) return <div className="p-6 text-xs text-muted-foreground">Loading approvals…</div>
  if (db.error) return <div className="p-6 text-xs text-muted-foreground">Sign in required.</div>

  const boards: Any[] = db.boards ?? []
  const boardName = (id: string) => boards.find((b) => b.board_id === id)?.name ?? id
  const approvals: Any[] = db.approvals ?? []
  const pending = approvals.filter((a) => PENDING.includes(a.status))
  const decided = approvals.filter((a) => !PENDING.includes(a.status))

  // boards eligible to request a review: routed, no requested approval yet
  const pendingBoardIds = new Set(pending.map((a) => a.scope?.board_id))
  const eligible = boards.filter(
    (b) => ['routed_in_sandbox', 'package_ready_with_review'].includes(b.readiness)
      && !pendingBoardIds.has(b.board_id))

  async function run(label: string, action: string, params: Any) {
    setBusy(label); setMsg(null)
    const r = await enterpriseAction(action, params)
    setBusy(null)
    if (r.error) setMsg({ tone: 'err', text: `${r.error}${r.detail ? ` — ${r.detail}` : ''}` })
    else { setMsg({ tone: 'ok', text: 'done' }); setPick(''); refresh() }
  }

  const Row = ({ a }: { a: Any }) => {
    const decidable = a.status === 'requested'
    return (
      <div className="flex flex-wrap items-center gap-3 px-3 py-2">
        <span className="w-44 shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {a.approval_type?.replace(/_/g, ' ')}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {a.scope?.board_id ? boardName(a.scope.board_id) : (a.scope?.program_id ? 'program-level' : '—')}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          req by {a.requested_by}{a.approver ? ` · by ${a.approver}` : ''}
        </span>
        {decidable ? (
          <span className="flex shrink-0 gap-1">
            <button type="button" disabled={!!busy}
              onClick={() => run(`ok-${a.approval_id}`, 'decide_approval', { approval_id: a.approval_id, decision: 'approved', approver: me })}
              className="rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-500 hover:bg-emerald-500/20 disabled:opacity-50">
              Approve
            </button>
            <button type="button" disabled={!!busy}
              onClick={() => run(`no-${a.approval_id}`, 'decide_approval', { approval_id: a.approval_id, decision: 'rejected', approver: me })}
              className="rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] text-destructive hover:bg-destructive/20 disabled:opacity-50">
              Reject
            </button>
          </span>
        ) : (
          <span className={cn('w-16 shrink-0 text-right font-mono text-[11px]', STATUS_STYLE[a.status] ?? 'text-muted-foreground')}>
            {a.status}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background p-4 text-xs text-foreground">
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-base font-semibold">Approvals</h1>
        <span className="text-muted-foreground">{pending.length} awaiting · {decided.length} decided</span>
        {msg && (
          <span className={cn('ml-auto rounded-sm px-2 py-0.5 font-mono text-[10px]',
            msg.tone === 'ok' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-destructive/10 text-destructive')}>
            {msg.text}
          </span>
        )}
      </div>

      {/* request a review */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/40 px-3 py-2">
        <span className="text-[11px] font-medium">Request board review</span>
        <select value={pick} onChange={(e) => setPick(e.target.value)}
          className="rounded-sm border border-border bg-background px-2 py-1 text-xs">
          <option value="">select a routed board…</option>
          {eligible.map((b) => <option key={b.board_id} value={b.board_id}>{b.name}</option>)}
        </select>
        <button type="button" disabled={!pick || !!busy}
          onClick={() => run('req', 'request_approval', {
            approval_type: 'board_review_approval', scope: { board_id: pick }, requested_by: me,
          })}
          className="rounded-sm border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-50">
          Request
        </button>
        <span className="font-mono text-[9px] text-muted-foreground">
          gated by RBAC — requires request_approval; deciding requires the reviewer/approver permission
        </span>
      </div>

      <div className="space-y-4">
        <div className="rounded-md border border-border">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-semibold">Awaiting decision</span>
            <span className="font-mono text-[10px] text-amber-500">{pending.length}</span>
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
