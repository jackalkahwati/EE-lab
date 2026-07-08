'use client'

/**
 * Board maturity strip — the single glance that communicates exactly how far
 * a board has come without overclaiming a millimetre. Nine cells, each mapped
 * to a real field in the enterprise store / its latest run:
 *   Architecture · Placement · Routing · DRC/ERC · External Evidence ·
 *   Human Review · Quote Approval · Physical Evidence · Production Ready
 * Maximally honest: "Physical Evidence: None" and "Production Ready: No" render
 * on every board, always, until real evidence and repeated validation exist.
 */
import { cn } from '@/lib/utils'

type Any = Record<string, any>

type Cell = { label: string; state: string; value: string }

// state -> glyph + colour. `none`/`no` are first-class honest states, shown
// clearly (not hidden), but styled as "definitively not yet", not as errors.
const STATE: Record<string, { glyph: string; cls: string }> = {
  pass: { glyph: '✓', cls: 'text-emerald-500' },
  partial: { glyph: '◐', cls: 'text-amber-500' },
  pending: { glyph: '⏳', cls: 'text-amber-500' },
  required: { glyph: '⚠', cls: 'text-amber-500' },
  fail: { glyph: '✗', cls: 'text-destructive' },
  none: { glyph: '∅', cls: 'text-muted-foreground' },
  no: { glyph: '✗', cls: 'text-muted-foreground' },
  na: { glyph: '–', cls: 'text-muted-foreground/60' },
}

export function deriveStrip(board: Any, db: Any): Cell[] {
  const run = (db.runs ?? []).find(
    (r: Any) => r.run_id === board.latest_run_id)
  const approvals = (db.approvals ?? []).filter(
    (a: Any) => a.scope?.board_id === board.board_id)
  const quotes = (db.quotes ?? []).filter(
    (q: Any) => q.board_id === board.board_id)

  // Architecture — every generated board carries a design state / summary
  const arch: Cell = board.current_design_state || board.architecture_summary
    ? { label: 'Architecture', state: 'pass', value: 'generated' }
    : { label: 'Architecture', state: 'pending', value: 'not generated' }

  // Placement + Routing — a run means placement ran; routed_in_sandbox is the pass
  const routed = run?.route_evidence_state === 'routed_in_sandbox'
    || board.routed_state === 'routed_in_sandbox'
  const place: Cell = !run
    ? { label: 'Placement', state: 'na', value: 'no run' }
    : { label: 'Placement', state: 'pass', value: 'placed' }
  const route: Cell = !run
    ? { label: 'Routing', state: 'na', value: 'no run' }
    : routed
      ? { label: 'Routing', state: 'pass', value: 'routed (sandbox)' }
      : { label: 'Routing', state: 'fail', value: run.route_evidence_state ?? 'unrouted' }

  // DRC / ERC — from the latest run
  const drcOk = run?.drc_state === 'drc_clean'
  const ercOk = run?.erc_state === 'passed'
  const dre: Cell = !run
    ? { label: 'DRC/ERC', state: 'na', value: 'no run' }
    : drcOk && ercOk
      ? { label: 'DRC/ERC', state: 'pass', value: 'clean' }
      : { label: 'DRC/ERC', state: 'fail', value: `${run.drc_state}/${run.erc_state}` }

  // External Evidence (M3B) — absent/inventory = none, advisory = partial, gated = pass
  const ext = run?.external_eda_state ?? 'inventory_only_or_absent'
  const extCell: Cell = /passed_gate|gated_pass/.test(ext)
    ? { label: 'External Evidence', state: 'pass', value: 'gated' }
    : /advisory|completed/.test(ext)
      ? { label: 'External Evidence', state: 'partial', value: 'advisory' }
      : { label: 'External Evidence', state: 'none', value: 'inventory only' }

  // Human Review — blocked/review items keep this open
  const review: Cell = board.review_required_items?.length
    ? { label: 'Human Review', state: 'required',
        value: `${board.review_required_items.length} item(s)` }
    : { label: 'Human Review', state: 'pass', value: 'no open items' }

  // Quote Approval — approvals of a quote type / quote state
  const qa = approvals.find((a: Any) => /quote/.test(a.approval_type ?? ''))
  const quoteReady = quotes.some((q: Any) => q.state === 'approved_for_quote' || q.packet)
  const quoteCell: Cell = qa?.status === 'approved'
    ? { label: 'Quote Approval', state: 'pass', value: 'approved' }
    : qa && /requested|pending|awaiting/.test(qa.status)
      ? { label: 'Quote Approval', state: 'pending', value: 'awaiting sign-off' }
      : quoteReady
        ? { label: 'Quote Approval', state: 'pending', value: 'packet ready' }
        : { label: 'Quote Approval', state: 'na', value: 'not requested' }

  // Physical Evidence — the honest floor. None unless real physical evidence.
  const phys = board.physical_evidence_state
  const physCell: Cell = phys && phys !== 'none' && phys !== 'empty'
    ? { label: 'Physical Evidence', state: 'partial', value: phys.replace(/_/g, ' ') }
    : { label: 'Physical Evidence', state: 'none', value: 'None' }

  // Production Ready — structurally No until repeated validation + evidence + approval
  const prod: Cell = board.production_readiness_state === 'production_ready'
    ? { label: 'Production Ready', state: 'pass', value: 'Yes' }
    : { label: 'Production Ready', state: 'no', value: 'No' }

  return [arch, place, route, dre, extCell, review, quoteCell, physCell, prod]
}

export function StatusStrip({ board, db }: { board: Any; db: Any }) {
  const cells = deriveStrip(board, db)
  return (
    <div className="flex flex-wrap gap-1.5 border-b border-border bg-card/30 p-2">
      {cells.map((c) => {
        const s = STATE[c.state] ?? STATE.na
        return (
          <div
            key={c.label}
            title={`${c.label}: ${c.value}`}
            className="flex min-w-[92px] flex-1 items-center gap-1.5 rounded-sm border border-border/70 bg-background/40 px-2 py-1"
          >
            <span className={cn('font-mono text-sm leading-none', s.cls)}>{s.glyph}</span>
            <div className="min-w-0">
              <div className="truncate text-[9px] uppercase leading-tight tracking-wide text-muted-foreground">
                {c.label}
              </div>
              <div className={cn('truncate text-[10px] font-medium leading-tight', s.cls)}>
                {c.value}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
