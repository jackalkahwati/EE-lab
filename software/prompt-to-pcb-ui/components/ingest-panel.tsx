'use client'

/**
 * Ingest tab — the datasheet-to-UCS view. Lists the approved component library
 * (parts imported via ingest_cli.py) and, for the selected part, shows identity,
 * inferred interfaces, symbol/footprint, support status, the pin table, and
 * confidence/provenance. Honest: needs_review / partial / unsupported are shown
 * as-is; only supported/partial are usable in synthesis.
 */

import { useEffect, useState } from 'react'
import { PackagePlus, Download, CheckCircle2, AlertTriangle } from 'lucide-react'

const STATUS_STYLE: Record<string, string> = {
  supported: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  partial: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  needs_review: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  unsupported: 'border-destructive/40 bg-destructive/10 text-destructive',
}

export function IngestPanel() {
  const [parts, setParts] = useState<any[] | null>(null)
  const [sel, setSel] = useState<any | null>(null)

  useEffect(() => {
    fetch('/api/ingest/library', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { parts: [] }))
      .then((d) => {
        setParts(d.parts ?? [])
        setSel((d.parts ?? [])[0] ?? null)
      })
      .catch(() => setParts([]))
  }, [])

  if (parts === null) return <div className="p-4 text-xs text-muted-foreground">Loading…</div>
  if (parts.length === 0)
    return (
      <div className="space-y-2 p-4 text-xs text-muted-foreground">
        <p className="flex items-center gap-1.5 text-foreground">
          <PackagePlus className="size-4 text-primary" /> No ingested parts yet.
        </p>
        <p>
          Import a part with the ingestion CLI, e.g.
          <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono">
            python3 ingest_cli.py ADS1115IDGS --symbol ADS1115IDGS --category adc.precision --approve partial
          </code>
        </p>
      </div>
    )

  return (
    <div className="flex h-full text-xs">
      {/* library list */}
      <div className="w-48 shrink-0 overflow-y-auto border-r border-border p-2">
        <p className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
          <PackagePlus className="size-3" /> Ingested library ({parts.length})
        </p>
        {parts.map((p) => (
          <button
            key={p.mpn}
            type="button"
            onClick={() => setSel(p)}
            className={`mb-1 w-full rounded-sm border px-2 py-1 text-left ${
              sel?.mpn === p.mpn ? 'border-primary/50 bg-primary/5' : 'border-border'
            }`}
          >
            <div className="font-mono text-[11px] text-foreground">{p.mpn}</div>
            <div className="text-[9px] text-muted-foreground">{p.category}</div>
          </button>
        ))}
      </div>

      {/* detail */}
      {sel && (
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-foreground">{sel.mpn}</span>
            <span
              className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${
                STATUS_STYLE[sel.support_status] ?? 'border-border text-muted-foreground'
              }`}
            >
              {sel.support_status}
            </span>
            <a
              href={`/api/ingest/library`}
              download={`${sel.mpn}.ucs.json`}
              className="ml-auto inline-flex items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20"
            >
              <Download className="size-3" /> UCS JSON
            </a>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
            <div>
              <span className="text-foreground">Manufacturer:</span> {sel.manufacturer || '?'}
            </div>
            <div>
              <span className="text-foreground">Package:</span> {sel.package || '?'}
            </div>
            <div>
              <span className="text-foreground">Interfaces:</span> {sel.interfaces.join(', ') || 'none'}
            </div>
            <div>
              <span className="text-foreground">Pins:</span> {sel.pins.length}
            </div>
          </div>
          <div className="space-y-0.5 font-mono text-[10px] text-muted-foreground">
            <div>symbol: {sel.kicad_symbol || '—'}</div>
            <div>footprint: {sel.kicad_footprint || '—'}</div>
          </div>

          {sel.user_notes && (
            <p className="rounded-md border border-border p-2 text-muted-foreground">{sel.user_notes}</p>
          )}

          {/* symbol/footprint validation status */}
          <div className="flex flex-wrap gap-2 text-[10px]">
            {sel.unsupported_fields?.length ? (
              <span className="inline-flex items-center gap-1 rounded-sm border border-destructive/40 bg-destructive/5 px-2 py-1 text-destructive">
                <AlertTriangle className="size-3" /> {sel.unsupported_fields.join('; ')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-sm border border-emerald-500/40 bg-emerald-500/5 px-2 py-1 text-emerald-500">
                <CheckCircle2 className="size-3" /> symbol ↔ footprint validated
              </span>
            )}
            {sel.approval && (
              <span className="rounded-sm border border-border px-2 py-1 text-muted-foreground">
                approved: {sel.approval.status} by {sel.approval.by}
              </span>
            )}
          </div>

          {/* pin table */}
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
              Pin table (from {sel.provenance?.pins ?? 'source'})
            </p>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse font-mono text-[10px]">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1 pr-3">Pad</th>
                    <th className="py-1 pr-3">Name</th>
                    <th className="py-1 pr-3">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {sel.pins.map((p: any, i: number) => (
                    <tr key={i} className="border-b border-border/40">
                      <td className="py-1 pr-3 text-primary">{p.number}</td>
                      <td className="py-1 pr-3 text-foreground">{p.name}</td>
                      <td className="py-1 pr-3 text-muted-foreground">{p.etype}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* confidence / provenance */}
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Confidence / provenance
            </p>
            <div className="space-y-0.5 font-mono text-[10px] text-muted-foreground">
              {Object.entries(sel.confidence).map(([k, v]) => (
                <div key={k}>
                  {k}: {String(v)}{' '}
                  <span className="text-foreground/60">({sel.provenance?.[k] ?? '?'})</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
