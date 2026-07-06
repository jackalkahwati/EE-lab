'use client'

/**
 * Advanced Routing tab — the electrical-geometry view. Renders a run's
 * advanced-routing-report.json: differential pairs, keepouts, impedance/stackup
 * plan, USB/Ethernet status, and analog/power layout rules. HONEST: high-speed
 * pairs the v1 router cannot enforce are shown as unsupported (red), and the
 * impedance plan carries its "estimate — requires a fab controlled-Z stackup"
 * caveat prominently. Nothing claims guaranteed impedance or high-speed support.
 */

import { useEffect, useState } from 'react'
import { Waves, AlertTriangle, ShieldAlert, Ruler, Download } from 'lucide-react'

export function AdvancedRoutingPanel({ runId }: { runId: string | null }) {
  const [m, setM] = useState<any | null | undefined>(undefined)

  useEffect(() => {
    if (!runId) {
      setM(null)
      return
    }
    let off = false
    fetch(`/runs/${runId}/data/advanced-routing-report.json`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => !off && setM(d))
      .catch(() => !off && setM(null))
    return () => {
      off = true
    }
  }, [runId])

  if (!runId || m === null)
    return <div className="p-4 text-xs text-muted-foreground">No advanced-routing analysis for this run.</div>
  if (m === undefined) return <div className="p-4 text-xs text-muted-foreground">Loading…</div>

  const s = m.summary ?? {}
  const pairs: any[] = m.differential_pairs ?? []
  const unsup: any[] = m.unsupported_constraints ?? []
  const imp = m.impedance_plan ?? {}
  const ifaces: any[] = m.interfaces ?? []

  return (
    <div className="space-y-4 overflow-y-auto p-4 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Waves className="size-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">Advanced Routing v1</span>
        <span
          className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${
            s.advanced_routable
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
              : 'border-destructive/40 bg-destructive/10 text-destructive'
          }`}
        >
          {s.advanced_routable ? 'advanced-routable' : 'unsupported constraints'}
        </span>
        <a
          href={`/runs/${runId}/data/advanced-routing-report.json`}
          download
          className="ml-auto inline-flex items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20"
        >
          <Download className="size-3" /> report JSON
        </a>
      </div>

      {/* unsupported — honest, shown first */}
      {unsup.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-destructive">
            <ShieldAlert className="size-3.5" /> Unsupported by the v1 router (honest — not faked)
          </p>
          {unsup.map((u, i) => (
            <div key={i} className="text-muted-foreground">
              <span className="font-mono text-foreground">{u.pair}</span> ({u.class}) — {u.why}
            </div>
          ))}
          {ifaces
            .filter((f) => !f.supported)
            .map((f, i) => (
              <div key={`i${i}`} className="mt-1 text-muted-foreground">
                <span className="text-foreground">{f.interface}</span>: {f.reason}{' '}
                <span className="text-primary">fallback: {f.fallback}</span>
              </div>
            ))}
        </div>
      )}

      {/* differential pairs */}
      {pairs.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Differential pairs ({pairs.length})
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[10px]">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-1 pr-3">Pair</th>
                  <th className="py-1 pr-3">Class</th>
                  <th className="py-1 pr-3">Zdiff</th>
                  <th className="py-1 pr-3">est W/S</th>
                  <th className="py-1 pr-3">Enforcement</th>
                </tr>
              </thead>
              <tbody>
                {pairs.map((p, i) => (
                  <tr key={i} className="border-b border-border/40">
                    <td className="py-1 pr-3 text-foreground">{p.pair}</td>
                    <td className="py-1 pr-3 text-muted-foreground">{p.class}</td>
                    <td className="py-1 pr-3 text-muted-foreground">{p.target_impedance_ohm}Ω</td>
                    <td className="py-1 pr-3 text-muted-foreground">
                      {p.est_width_mm}/{p.est_spacing_mm}
                    </td>
                    <td
                      className={`py-1 pr-3 ${
                        p.enforcement === 'unsupported_by_router'
                          ? 'text-destructive'
                          : 'text-amber-500'
                      }`}
                    >
                      {p.enforcement}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* impedance / stackup */}
      <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-500">
          <Ruler className="size-3.5" /> Impedance plan (ESTIMATE)
        </p>
        <p className="mt-1 font-mono text-[10px] text-muted-foreground">
          50Ω single-ended ≈ {imp.single_ended_50ohm_width_mm} mm ·{' '}
          {imp.stackup?.layers}-layer {imp.stackup?.material} · quote required:{' '}
          {String(imp.controlled_impedance_quote_required)}
        </p>
        <p className="mt-1 text-muted-foreground">{imp.guarantee}</p>
      </div>

      {/* analog + power + keepouts */}
      {[
        ['Analog layout rules', m.analog_rules],
        ['Power layout rules', m.power_rules],
        ['Keepouts', m.keepouts],
      ].map(([title, list]: any) =>
        list?.length ? (
          <div key={title}>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
              {title} ({list.length})
            </p>
            <ul className="space-y-0.5">
              {list.map((r: any, i: number) => (
                <li key={i} className="text-muted-foreground">
                  <span className="font-mono text-foreground">
                    {r.rule ?? r.type}
                    {r.component ? ` (${r.component})` : ''}
                  </span>{' '}
                  — {r.detail}
                  {r.enforcement === 'advisory' && (
                    <span className="ml-1 text-amber-500">· advisory</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
    </div>
  )
}
