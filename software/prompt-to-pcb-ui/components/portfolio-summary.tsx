'use client'

/**
 * Portfolio homepage roll-up. Answers the eight questions a program owner or
 * investor opens the platform to ask, aggregated across the whole workspace:
 * active programs · boards ready for review · boards blocked · approvals
 * waiting · quote packets ready · validation sessions pending · evidence on
 * file · physical-ledger state. Every count is backed by a clickable board
 * queue — "which boards", not just "how many". Read-honest: physical evidence
 * and production readiness never render as present unless real evidence exists.
 */
import { cn } from '@/lib/utils'

type Any = Record<string, any>

const VALIDATION_PENDING = ['planned', 'pending', 'in_progress', 'scheduled']
const APPROVAL_WAITING = ['pending', 'requested', 'awaiting']
const PHYSICAL_RE = /physical|inspection|continuity|resistance|measurement|bring.?up|enumerat|thermal|scope/i

export function PortfolioSummary({
  db, programs, onOpenBoard,
}: {
  db: Any
  programs: Any[]
  onOpenBoard: (board: Any) => void
}) {
  const progIds = new Set(programs.map((p) => p.program_id))
  const boards = (db.boards ?? []).filter((b: Any) => progIds.has(b.program_id))
  const boardIds = new Set(boards.map((b: Any) => b.board_id))

  const activePrograms = programs.filter(
    (p) => p.status !== 'archived' && p.status !== 'closed')
  const needsReview = boards.filter(
    (b: Any) => b.review_required_items?.length
      || b.readiness === 'package_ready_with_review')
  const blocked = boards.filter(
    (b: Any) => b.blocked_claims?.length || b.readiness === 'blocked')
  const approvalsWaiting = (db.approvals ?? []).filter(
    (a: Any) => (boardIds.has(a.scope?.board_id) || progIds.has(a.scope?.program_id))
      && APPROVAL_WAITING.includes(a.status))
  const quotesReady = (db.quotes ?? []).filter(
    (q: Any) => boardIds.has(q.board_id)
      && (q.state === 'approved_for_quote' || q.packet))
  const validationPending = (db.validation_sessions ?? []).filter(
    (v: Any) => boardIds.has(v.board_id) && VALIDATION_PENDING.includes(v.status))
  const evidence = (db.evidence ?? []).filter(
    (e: Any) => boardIds.has(e.scope_id))
  const physicalEvidence = evidence.filter(
    (e: Any) => PHYSICAL_RE.test(e.evidence_type || '')
      && e.status === 'accepted')

  const boardById = (id: string) => boards.find((b: Any) => b.board_id === id)

  const stats: { label: string; value: string; tone: string; boards?: Any[] }[] = [
    { label: 'Active programs', value: String(activePrograms.length), tone: 'plain' },
    { label: 'Ready for review', value: String(needsReview.length),
      tone: needsReview.length ? 'amber' : 'plain', boards: needsReview },
    { label: 'Blocked', value: String(blocked.length),
      tone: blocked.length ? 'red' : 'plain', boards: blocked },
    { label: 'Approvals waiting', value: String(approvalsWaiting.length),
      tone: approvalsWaiting.length ? 'amber' : 'plain' },
    { label: 'Quote packets ready', value: String(quotesReady.length),
      tone: quotesReady.length ? 'emerald' : 'plain' },
    { label: 'Validation pending', value: String(validationPending.length),
      tone: validationPending.length ? 'amber' : 'plain' },
    { label: 'Evidence on file', value: String(evidence.length), tone: 'plain' },
    { label: 'Physical ledger',
      value: physicalEvidence.length ? String(physicalEvidence.length) : 'EMPTY',
      tone: physicalEvidence.length ? 'emerald' : 'muted' },
  ]

  const TONE: Record<string, string> = {
    plain: 'text-foreground',
    muted: 'text-muted-foreground',
    amber: 'text-amber-500',
    red: 'text-destructive',
    emerald: 'text-emerald-500',
  }

  // the actionable queue: the specific boards a human must touch next
  const attention: { kind: string; tone: string; board: Any; note: string }[] = []
  for (const b of blocked) attention.push({
    kind: 'blocked', tone: 'red', board: b,
    note: (b.blocked_claims ?? [])[0] ?? 'blocked' })
  for (const b of needsReview) if (!blocked.includes(b)) attention.push({
    kind: 'review', tone: 'amber', board: b,
    note: (b.review_required_items ?? [])[0] ?? 'human review required' })
  for (const a of approvalsWaiting) {
    const b = boardById(a.scope?.board_id)
    if (b) attention.push({ kind: 'approval', tone: 'amber', board: b,
      note: `${a.approval_type?.replace(/_/g, ' ')} — awaiting sign-off` })
  }
  for (const q of quotesReady) {
    const b = boardById(q.board_id)
    if (b) attention.push({ kind: 'quote', tone: 'emerald', board: b,
      note: 'quote packet ready — human approval gates the send' })
  }
  for (const v of validationPending) {
    const b = boardById(v.board_id)
    if (b) attention.push({ kind: 'validation', tone: 'amber', board: b,
      note: `validation session ${v.status}` })
  }

  return (
    <div className="mb-4 space-y-3">
      {/* the eight answers */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        {stats.map((s) => (
          <div key={s.label} className="rounded-md border border-border bg-card/40 p-2.5">
            <div className={cn('font-mono text-xl font-semibold tabular-nums', TONE[s.tone])}>
              {s.value}
            </div>
            <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
              {s.label}
            </div>
          </div>
        ))}
      </div>

      {/* the queue: which boards need a human next */}
      <div className="rounded-md border border-border">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-xs font-semibold">Needs attention</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {attention.length} item(s) across {programs.length} program(s)
          </span>
          <span className="ml-auto font-mono text-[9px] text-muted-foreground">
            routed_in_sandbox ≠ physically validated · nothing is production-ready
          </span>
        </div>
        <div className="max-h-64 divide-y divide-border overflow-y-auto">
          {attention.length === 0 && (
            <p className="px-3 py-3 text-muted-foreground">
              Nothing waiting on a human. Every board is at rest in its current
              evidence state.
            </p>
          )}
          {attention.map((a, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onOpenBoard(a.board)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-secondary/50"
            >
              <span className={cn(
                'w-16 shrink-0 font-mono text-[9px] uppercase tracking-wide',
                TONE[a.tone])}>
                {a.kind}
              </span>
              <span className="shrink-0 text-xs font-medium">{a.board.name}</span>
              <span className="truncate text-[11px] text-muted-foreground">{a.note}</span>
              <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground">
                {a.board.readiness?.replace(/_/g, ' ')}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
