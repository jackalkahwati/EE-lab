'use client'

/**
 * Constraints tab — the human-readable view of a run's constraints.json
 * (Constraint Manager v1). Shows how each net was classified, which per-class
 * rules were applied, and — honestly — which requested features are UNSUPPORTED
 * in v1 (differential-pair / controlled-impedance / high-speed), with the
 * required constraint and a fallback. Nothing faked.
 */

import { useEffect, useState } from 'react'
import { SlidersHorizontal, AlertTriangle, Zap, ChevronRight } from 'lucide-react'

type Model = Record<string, any>

export function ConstraintsPanel({ runId }: { runId: string | null }) {
  const [m, setM] = useState<Model | null | undefined>(undefined)
  const [netsOpen, setNetsOpen] = useState(false)

  useEffect(() => {
    if (!runId) {
      setM(null)
      return
    }
    let cancelled = false
    fetch(`/runs/${runId}/data/constraints.json`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => !cancelled && setM(d))
      .catch(() => !cancelled && setM(null))
    return () => {
      cancelled = true
    }
  }, [runId])

  if (!runId || m === null)
    return (
      <div className="p-4 text-xs text-muted-foreground">
        No constraint model for this run.
      </div>
    )
  if (m === undefined) return <div className="p-4 text-xs text-muted-foreground">Loading…</div>

  const counts: Record<string, number> = m.class_counts ?? {}
  const classes: Record<string, any> = m.classes ?? {}
  const unsupported: any[] = m.unsupported ?? []
  const highRisk: any[] = m.high_risk_nets ?? []
  const nets: Record<string, any> = m.nets ?? {}

  return (
    <div className="space-y-4 overflow-y-auto p-4 text-xs">
      <div className="flex items-center gap-2">
        <SlidersHorizontal className="size-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">Constraint Manager v1</span>
        <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {m.summary?.total_nets ?? Object.keys(nets).length} nets · {Object.keys(counts).length} classes
        </span>
        {m.summary?.has_high_current && (
          <span className="inline-flex items-center gap-1 rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-500">
            <Zap className="size-3" /> high-current nets
          </span>
        )}
      </div>

      {/* unsupported — most important, shown first, never hidden */}
      {unsupported.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-destructive">
            <AlertTriangle className="size-3.5" /> Unsupported in v1 (detected, not faked)
          </p>
          <div className="space-y-2">
            {unsupported.map((u, i) => (
              <div key={i} className="text-muted-foreground">
                <span className="font-mono text-foreground">{u.net}</span> — {u.feature}
                <div className="pl-3">
                  <div>needs: {u.required}</div>
                  <div>why: {u.why}</div>
                  <div className="text-primary">fallback: {u.fallback}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* net-class breakdown + applied rules */}
      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
          Net classes applied
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-[10px]">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-1 pr-3">Class</th>
                <th className="py-1 pr-3">Nets</th>
                <th className="py-1 pr-3">Track width</th>
                <th className="py-1 pr-3">Clearance</th>
                <th className="py-1 pr-3">Notes</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(counts)
                .sort((a, b) => b[1] - a[1])
                .map(([cls, n]) => {
                  const r = classes[cls] ?? {}
                  const flags = [
                    r.high_current && 'high-current',
                    r.plane && 'plane',
                    r.needs_pullup && 'needs pull-up',
                    r.controlled && 'controlled',
                    r.diff_pair_preferred && 'diff-pair pref',
                    r.rf && 'RF',
                    r.analog && 'analog',
                    r.route === 'short_direct' && 'short/direct',
                  ].filter(Boolean)
                  return (
                    <tr key={cls} className="border-b border-border/40">
                      <td className="py-1 pr-3 text-foreground">{cls}</td>
                      <td className="py-1 pr-3 text-muted-foreground">{n}</td>
                      <td className="py-1 pr-3 text-muted-foreground">
                        {r.min_width != null ? `${r.min_width} mm` : '—'}
                      </td>
                      <td className="py-1 pr-3 text-muted-foreground">
                        {r.clearance != null ? `${r.clearance} mm` : '—'}
                      </td>
                      <td className="py-1 pr-3 text-muted-foreground">{flags.join(', ') || '—'}</td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
      </div>

      {/* high-risk nets */}
      {highRisk.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-500">
            High-risk nets (verify by hand)
          </p>
          <ul className="space-y-0.5">
            {highRisk.map((h, i) => (
              <li key={i} className="text-muted-foreground">
                <span className="font-mono text-foreground">{h.net}</span> ({h.class})
                {h.note ? ` — ${h.note}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* per-net classification (collapsible) */}
      <div>
        <button
          type="button"
          onClick={() => setNetsOpen((o) => !o)}
          className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={`size-3 transition-transform ${netsOpen ? 'rotate-90' : ''}`} />
          Per-net classification ({Object.keys(nets).length})
        </button>
        {netsOpen && (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[10px]">
              <tbody>
                {Object.entries(nets).map(([net, info]) => (
                  <tr key={net} className="border-b border-border/40">
                    <td className="py-1 pr-3 text-foreground">{net}</td>
                    <td className="py-1 pr-3 text-primary">{info.class}</td>
                    <td className="py-1 text-muted-foreground">{info.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
