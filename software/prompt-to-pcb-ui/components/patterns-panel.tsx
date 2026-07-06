'use client'

/**
 * Reference Patterns tab — the pattern-learning view. Shows the FirstLight
 * Instrument Pattern Library (patterns extracted from proven designs + honest
 * needs_reference placeholders) and the curated reference manifest with its
 * LICENSE / trust status. The license gate is explicit: only permissive patterns
 * say "direct reuse"; manufacturer/unknown say reference-only or review.
 */

import { useEffect, useState } from 'react'
import { Layers, ShieldCheck, ShieldAlert, Download, BookMarked } from 'lucide-react'

const STATUS_STYLE: Record<string, string> = {
  reusable: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  reusable_with_review: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  reference_only: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  needs_review: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  unsupported: 'border-destructive/40 bg-destructive/10 text-destructive',
}

export function PatternsPanel() {
  const [data, setData] = useState<any | null>(null)
  const [sel, setSel] = useState<any | null>(null)

  useEffect(() => {
    fetch('/api/patterns', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { patterns: [], references: [] }))
      .then((d) => {
        setData(d)
        setSel((d.patterns ?? []).find((p: any) => !p.needs_reference) ?? d.patterns?.[0] ?? null)
      })
      .catch(() => setData({ patterns: [], references: [] }))
  }, [])

  if (!data) return <div className="p-4 text-xs text-muted-foreground">Loading…</div>
  const patterns: any[] = data.patterns ?? []
  const references: any[] = data.references ?? []

  return (
    <div className="flex h-full text-xs">
      <div className="w-52 shrink-0 overflow-y-auto border-r border-border p-2">
        <p className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
          <Layers className="size-3" /> Pattern library ({patterns.length})
        </p>
        {patterns.map((p) => (
          <button
            key={p.category}
            type="button"
            onClick={() => setSel(p)}
            className={`mb-1 w-full rounded-sm border px-2 py-1 text-left ${
              sel?.category === p.category ? 'border-primary/50 bg-primary/5' : 'border-border'
            }`}
          >
            <div className="text-[11px] text-foreground">{p.name}</div>
            <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
              {p.support_status}
              {p.needs_reference && <span className="text-amber-500">· needs ref</span>}
            </div>
          </button>
        ))}
        <p className="mb-1 mt-3 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <BookMarked className="size-3" /> References ({references.length})
        </p>
        {references.map((r, i) => (
          <div key={i} className="mb-1 rounded-sm border border-border px-2 py-1">
            <div className="text-[10px] text-foreground">{r.name}</div>
            <div className="text-[9px] text-muted-foreground">
              {r.source_type} · {r.trust_level} trust
            </div>
            <div
              className={`text-[9px] ${
                r.allowed_use === 'direct_reuse' ? 'text-emerald-500' : 'text-sky-400'
              }`}
            >
              {r.license_status} → {r.allowed_use}
            </div>
          </div>
        ))}
      </div>

      {sel && (
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{sel.name}</span>
            <span
              className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${
                STATUS_STYLE[sel.support_status] ?? 'border-border text-muted-foreground'
              }`}
            >
              {sel.support_status}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] ${
                sel.direct_reuse_allowed
                  ? 'border-emerald-500/40 text-emerald-500'
                  : 'border-sky-500/40 text-sky-400'
              }`}
            >
              {sel.direct_reuse_allowed ? (
                <ShieldCheck className="size-3" />
              ) : (
                <ShieldAlert className="size-3" />
              )}
              {sel.license_status} → {sel.allowed_use}
            </span>
            <a
              href="/api/patterns"
              download={`${sel.category}.pattern.json`}
              className="ml-auto inline-flex items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20"
            >
              <Download className="size-3" /> pattern JSON
            </a>
          </div>

          <p className="text-muted-foreground">{sel.purpose}</p>
          {sel.needs_reference ? (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-amber-500">
              needs_reference — drop a curated reference into references/ and register it (with a
              license) before this pattern can be used.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
                <div>
                  <span className="text-foreground">Interfaces:</span>{' '}
                  {sel.interface_pins.join(', ') || '—'}
                </div>
                <div>
                  <span className="text-foreground">Rails:</span>{' '}
                  {(sel.power?.rails ?? []).join(', ') || '—'}
                </div>
              </div>

              {sel.components.length > 0 && (
                <div>
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
                    Components (adaptation zones)
                  </p>
                  {sel.components.map((c: any, i: number) => (
                    <div key={i} className="text-muted-foreground">
                      <span className="font-mono text-foreground">{c.role}</span>
                      {c.mpn ? ` (${c.mpn})` : ''} —{' '}
                      <span
                        className={
                          c.zone === 'preserve_exactly' ? 'text-destructive' : 'text-emerald-500'
                        }
                      >
                        {c.zone}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {sel.layout_constraints.length > 0 && (
                <div>
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
                    Layout constraints
                  </p>
                  {sel.layout_constraints.map((l: any, i: number) => (
                    <div key={i} className="text-muted-foreground">
                      <span className="font-mono text-foreground">{l.rule}</span> — {l.detail}
                    </div>
                  ))}
                </div>
              )}

              {sel.validation_procedure && (
                <p className="text-muted-foreground">
                  <span className="text-foreground">Validation:</span> {sel.validation_procedure}
                </p>
              )}
              {sel.status_reasons.length > 0 && (
                <p className="text-[10px] text-muted-foreground">
                  status: {sel.status_reasons.join('; ')}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
