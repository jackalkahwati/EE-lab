'use client'

/**
 * Quotes & procurement — the fab quote/order workflow. Prices are PLACEHOLDER
 * until a real vendor quote is ingested; the human approval gate blocks the
 * "order / spend money" step. Compose prepares packets and ingests evidence;
 * it never places an order or submits a quote automatically.
 */
import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { enterpriseAction } from '@/lib/enterprise-actions'

type Any = Record<string, any>

const STATE_STYLE: Record<string, string> = {
  draft: 'border-border bg-muted/30 text-muted-foreground',
  packet_ready: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  approved_for_quote: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  quote_received: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  approved_for_order: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  ordered: 'border-primary/40 bg-primary/10 text-primary',
}

export default function QuotesPage() {
  const [db, setDb] = useState<Any | null>(null)
  const [busy, setBusy] = useState(false)
  const [pick, setPick] = useState('')
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const refresh = useCallback(() => {
    fetch('/api/enterprise', { cache: 'no-store' }).then((r) => r.json()).then(setDb).catch(() => {})
  }, [])
  useEffect(() => { refresh() }, [refresh])

  if (!db) return <div className="p-6 text-xs text-muted-foreground">Loading quotes…</div>
  if (db.error) return <div className="p-6 text-xs text-muted-foreground">Sign in required.</div>

  const boards: Any[] = db.boards ?? []
  const boardName = (id: string) => boards.find((b) => b.board_id === id)?.name ?? id
  const quotes: Any[] = db.quotes ?? []
  const quotedIds = new Set(quotes.map((q) => q.board_id))
  const eligible = boards.filter(
    (b) => ['routed_in_sandbox', 'package_ready_with_review'].includes(b.readiness) && !quotedIds.has(b.board_id))

  async function generate() {
    if (!pick) return
    setBusy(true); setMsg(null)
    const r = await enterpriseAction('generate_quote_packet', { board_id: pick })
    setBusy(false)
    if (r.error) setMsg({ tone: 'err', text: `${r.error}${r.detail ? ` — ${r.detail}` : ''}` })
    else { setMsg({ tone: 'ok', text: 'quote packet generated' }); setPick(''); refresh() }
  }

  return (
    <div className="min-h-screen bg-background p-4 text-xs text-foreground">
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-base font-semibold">Quotes &amp; procurement</h1>
        <span className="text-muted-foreground">{quotes.length} quote flow(s)</span>
        {msg && (
          <span className={cn('ml-auto rounded-sm px-2 py-0.5 font-mono text-[10px]',
            msg.tone === 'ok' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-destructive/10 text-destructive')}>
            {msg.text}
          </span>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/40 px-3 py-2">
        <span className="text-[11px] font-medium">Generate quote packet</span>
        <select value={pick} onChange={(e) => setPick(e.target.value)}
          className="rounded-sm border border-border bg-background px-2 py-1 text-xs">
          <option value="">select a routed board…</option>
          {eligible.map((b) => <option key={b.board_id} value={b.board_id}>{b.name}</option>)}
        </select>
        <button type="button" disabled={!pick || busy} onClick={generate}
          className="rounded-sm border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-50">
          Generate
        </button>
        <span className="font-mono text-[9px] text-muted-foreground">
          gated by RBAC (generate_package) · prices stay PLACEHOLDER, order/spend stays human-gated
        </span>
      </div>

      <div className="space-y-3">
        {quotes.length === 0 && (
          <p className="rounded-md border border-border p-4 text-muted-foreground">
            No quote flows yet. A board reaches this stage after its package is review-approved.
          </p>
        )}
        {quotes.map((q) => (
          <div key={q.quote_id} className="rounded-md border border-border">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <span className="text-sm font-semibold">{boardName(q.board_id)}</span>
              <span className={cn('rounded-sm border px-1.5 py-0.5 font-mono text-[10px]',
                STATE_STYLE[q.state] ?? 'border-border bg-muted/30 text-muted-foreground')}>
                {q.state?.replace(/_/g, ' ')}
              </span>
              <span className="ml-auto font-mono text-[10px] text-muted-foreground">{q.quote_id}</span>
            </div>
            <div className="grid gap-3 p-3 sm:grid-cols-2">
              <div className="space-y-1">
                <div className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">Fab vendor</div>
                <div className="text-xs">{q.fab_vendor?.name ?? 'not selected'}</div>
                {q.fab_vendor?.note && (
                  <div className="text-[9px] text-muted-foreground/70">{q.fab_vendor.note}</div>
                )}
                <div className="mt-1.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">Packet</div>
                <div className="text-[11px] text-muted-foreground">
                  {q.packet ? 'gerbers · drill · BOM · CPL prepared' : 'not prepared'}
                  {q.fab_attach ? ' · fab files attached' : ''}
                </div>
              </div>
              <div className="space-y-1">
                <div className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">Price</div>
                <div className="font-mono text-xs text-amber-500">PLACEHOLDER · real quote required</div>
                <div className="mt-1.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
                  Manual quote entries
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {(q.manual_entries ?? []).length
                    ? `${(q.manual_entries ?? []).length} entry(ies)`
                    : 'none — awaiting real vendor quotes'}
                </div>
              </div>
            </div>
            {(q.history ?? []).length > 0 && (
              <div className="border-t border-border px-3 py-2">
                <div className="mb-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">History</div>
                <div className="space-y-0.5">
                  {(q.history ?? []).slice(-5).map((h: Any, i: number) => (
                    <div key={i} className="font-mono text-[10px] text-muted-foreground">
                      {h.state ?? h.action ?? JSON.stringify(h)}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
