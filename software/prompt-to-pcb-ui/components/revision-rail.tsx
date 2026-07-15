'use client'

/**
 * Revision lineage for the selected run's PRODUCT (Phase 1 of the iteration
 * platform). Shows every build of this product oldest→newest, marks the one
 * on screen, navigates between revisions, and opens a structured diff
 * against the previous revision (lib/design-diff via /api/runs/diff).
 */
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { GitBranch, Diff, X, Loader2, Pin as PinIcon, Plus } from 'lucide-react'

type Revision = { runId: string; parentRunId: string | null; createdAt: string; note?: string }
type PinRec = { id: string; area: string; kind: string; value: Record<string, unknown>; label: string }
type Product = { productId: string; name: string; revisions: Revision[]; activeRunId: string; pins: PinRec[] }

type FieldDelta = { label: string; from: unknown; to: unknown }
type DiffPayload = {
  board: { available: boolean; note?: string; delta: FieldDelta[] }
  bom: { available: boolean; note?: string; delta: { added: { ref: string; part: string }[]; removed: { ref: string; part: string }[]; changed: { ref: string; from: string; to: string }[] } }
  enclosure: { available: boolean; note?: string; delta: FieldDelta[] }
  budgets: { available: boolean; note?: string; delta: FieldDelta[] }
  simulation: { available: boolean; note?: string; delta: FieldDelta[] }
}

const fmt = (v: unknown) => (v === null || v === undefined ? '—' : String(v))

function DeltaRows({ title, sec }: { title: string; sec: { available: boolean; note?: string; delta: FieldDelta[] } }) {
  if (!sec.available) {
    return <div className="text-[11px] text-muted-foreground">{title}: {sec.note ?? 'unavailable'}</div>
  }
  if (!sec.delta.length) {
    return <div className="text-[11px] text-muted-foreground">{title}: no change</div>
  }
  return (
    <div>
      <div className="mb-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">{title}</div>
      {sec.delta.map((f) => (
        <div key={f.label} className="flex items-baseline gap-2 py-0.5 text-[11.5px]">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{f.label}</span>
          <span className="font-mono text-muted-foreground line-through">{fmt(f.from)}</span>
          <span className="font-mono text-foreground">{fmt(f.to)}</span>
        </div>
      ))}
    </div>
  )
}

export function RevisionRail({ runId, onSelectRun }: {
  runId?: string
  onSelectRun?: (runId: string) => void
}) {
  const [product, setProduct] = useState<Product | null>(null)
  const [diffFor, setDiffFor] = useState<{ from: string; to: string } | null>(null)
  const [diff, setDiff] = useState<DiffPayload | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setProduct(null); setDiffFor(null); setDiff(null)
    if (!runId) return
    let off = false
    fetch(`/api/products?run=${encodeURIComponent(runId)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!off && d?.product) setProduct(d.product) })
      .catch(() => {})
    return () => { off = true }
  }, [runId])

  useEffect(() => {
    if (!diffFor) { setDiff(null); return }
    let off = false
    setLoading(true)
    fetch(`/api/runs/diff?from=${encodeURIComponent(diffFor.from)}&to=${encodeURIComponent(diffFor.to)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!off) { setDiff(d); setLoading(false) } })
      .catch(() => { if (!off) setLoading(false) })
    return () => { off = true }
  }, [diffFor])

  // Single-revision products still render (it shows the product identity), but
  // stay compact — the rail earns its space once there are 2+ revisions.
  if (!product) return null
  const revs = product.revisions

  return (
    <div className="border-t border-border px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <GitBranch className="size-3 text-muted-foreground" />
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
          revisions · {revs.length}
        </span>
      </div>
      <div className="space-y-0.5">
        {revs.map((r, i) => {
          const current = r.runId === runId
          const prev = i > 0 ? revs[i - 1] : null
          return (
            <div key={r.runId} className={cn('group flex items-center gap-1.5 rounded-sm px-1.5 py-1',
              current ? 'bg-secondary/60' : 'hover:bg-secondary/30')}>
              <button
                type="button"
                onClick={() => !current && onSelectRun?.(r.runId)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                title={r.runId}
              >
                <span className={cn('font-mono text-[10px]', current ? 'text-primary' : 'text-muted-foreground')}>
                  rev {i + 1}
                </span>
                <span className={cn('min-w-0 flex-1 truncate text-[11px]',
                  current ? 'text-foreground' : 'text-muted-foreground')}>
                  {r.note ?? (i === 0 ? 'initial build' : 'revision')}
                </span>
                {current && <span className="shrink-0 font-mono text-[8px] uppercase text-primary">viewing</span>}
              </button>
              {prev && (
                <button
                  type="button"
                  title={`diff rev ${i} → rev ${i + 1}`}
                  onClick={() => setDiffFor(
                    diffFor?.to === r.runId ? null : { from: prev.runId, to: r.runId })}
                  className={cn('shrink-0 rounded-sm border border-border p-0.5',
                    diffFor?.to === r.runId ? 'text-primary' : 'text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground')}
                >
                  <Diff className="size-3" />
                </button>
              )}
            </div>
          )
        })}
      </div>

      <PinsPanel product={product} onChange={(pins) => setProduct({ ...product, pins })} />

      {diffFor && (
        <div className="mt-2 rounded-md border border-border bg-card/60 p-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
              what changed
            </span>
            <button type="button" onClick={() => setDiffFor(null)}
              className="ml-auto text-muted-foreground hover:text-foreground">
              <X className="size-3" />
            </button>
          </div>
          {loading && <div className="flex items-center gap-2 py-2 text-[11px] text-muted-foreground"><Loader2 className="size-3 animate-spin" /> computing…</div>}
          {diff && !loading && (
            <div className="space-y-2">
              <DeltaRows title="board" sec={diff.board} />
              {diff.bom.available ? (
                (diff.bom.delta.added.length || diff.bom.delta.removed.length || diff.bom.delta.changed.length) ? (
                  <div>
                    <div className="mb-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">BOM</div>
                    {diff.bom.delta.added.map((x) => (
                      <div key={`a${x.ref}`} className="py-0.5 text-[11.5px] text-emerald-600 dark:text-emerald-400">+ {x.ref} · {x.part}</div>
                    ))}
                    {diff.bom.delta.removed.map((x) => (
                      <div key={`r${x.ref}`} className="py-0.5 text-[11.5px] text-destructive">− {x.ref} · {x.part}</div>
                    ))}
                    {diff.bom.delta.changed.map((x) => (
                      <div key={`c${x.ref}`} className="py-0.5 text-[11.5px]"><span className="text-muted-foreground">{x.ref}:</span> <span className="text-muted-foreground line-through">{x.from}</span> <span className="text-foreground">{x.to}</span></div>
                    ))}
                  </div>
                ) : <div className="text-[11px] text-muted-foreground">BOM: no change</div>
              ) : <div className="text-[11px] text-muted-foreground">BOM: {diff.bom.note}</div>}
              <DeltaRows title="enclosure" sec={diff.enclosure} />
              <DeltaRows title="budgets" sec={diff.budgets} />
              <DeltaRows title="simulation" sec={diff.simulation} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}


/**
 * Engineer-locked decisions (Phase 2). Pins are HARD constraints injected into
 * the electronics/mechanical/redesign prompts and verified after builds — a
 * violated pin fails its stage. Add/remove here; owner-only server-side.
 */
function PinsPanel({ product, onChange }: {
  product: { productId: string; pins: PinRec[] }
  onChange: (pins: PinRec[]) => void
}) {
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<'part' | 'enclosure-dim' | 'budget'>('part')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    try {
      const r = await fetch('/api/products/pins', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ productId: product.productId, ...body }),
      })
      const d = await r.json()
      if (Array.isArray(d.pins)) onChange(d.pins)
    } catch { /* surface-less: the list simply doesn't change */ }
    setBusy(false)
  }

  function add() {
    const v = text.trim()
    if (!v) return
    const area = kind === 'part' ? 'electronics' : kind === 'enclosure-dim' ? 'mechanical' : 'budget'
    const value = kind === 'part' ? { mpn: v } : { text: v }
    void post({ add: { area, kind, value, label: kind === 'part' ? `part ${v}` : v } })
    setText(''); setAdding(false)
  }

  return (
    <div className="mt-2.5">
      <div className="mb-1 flex items-center gap-1.5">
        <PinIcon className="size-3 text-muted-foreground" />
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
          pins · {product.pins?.length ?? 0}
        </span>
        <button type="button" onClick={() => setAdding((v) => !v)}
          className="ml-auto rounded-sm border border-border p-0.5 text-muted-foreground hover:text-foreground">
          <Plus className="size-3" />
        </button>
      </div>
      {(product.pins ?? []).map((pin) => (
        <div key={pin.id} className="group flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 hover:bg-secondary/30">
          <span className="font-mono text-[9px] uppercase text-primary">{pin.kind}</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">{pin.label}</span>
          <button type="button" disabled={busy} onClick={() => void post({ removeId: pin.id })}
            className="shrink-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100">
            <X className="size-3" />
          </button>
        </div>
      ))}
      {!product.pins?.length && !adding && (
        <p className="px-1.5 text-[10.5px] text-muted-foreground">
          Nothing locked — pin a part (MPN), an enclosure dimension, or a budget
          and every regeneration must keep it.
        </p>
      )}
      {adding && (
        <div className="mt-1 flex items-center gap-1.5 px-1.5">
          <select value={kind} onChange={(e) => setKind(e.target.value as any)}
            className="rounded-sm border border-border bg-background px-1 py-0.5 font-mono text-[10px]">
            <option value="part">part</option>
            <option value="enclosure-dim">enclosure dim</option>
            <option value="budget">budget</option>
          </select>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); else if (e.key === 'Escape') setAdding(false) }}
            placeholder={kind === 'part' ? 'MPN, e.g. RP2040' : kind === 'enclosure-dim' ? 'e.g. wall 2.0 mm' : 'e.g. unit cost <= $25'}
            className="min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 py-0.5 text-[11px] outline-none focus:border-primary/60" />
          <button type="button" onClick={add} disabled={busy || !text.trim()}
            className="rounded-sm bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground disabled:opacity-50">
            pin
          </button>
        </div>
      )}
    </div>
  )
}
