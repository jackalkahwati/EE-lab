'use client'

/**
 * Assembly / Manufacturing tab — the order-ready PCBA view. Renders a run's
 * assembly-readiness.json + sourcing-report.json + substitutions.json: whether
 * the board is ready to assemble, pick-and-place status, sourcing (HONESTLY
 * labelled — live supplier data vs fallback estimate), fine-pitch / hand-solder
 * risk, substitutions, and a download button for the full PCBA package.
 */

import { useEffect, useState } from 'react'
import { PackageCheck, AlertTriangle, Download, CircuitBoard, Wrench } from 'lucide-react'

export function AssemblyPanel({ runId, fabZip }: { runId: string | null; fabZip: string | null }) {
  const [r, setR] = useState<any | null | undefined>(undefined)
  const [src, setSrc] = useState<any | null>(null)
  const [subs, setSubs] = useState<any[]>([])

  useEffect(() => {
    if (!runId) {
      setR(null)
      return
    }
    let off = false
    const base = `/runs/${runId}/data`
    const get = (f: string) =>
      fetch(`${base}/${f}`, { cache: 'no-store' }).then((x) => (x.ok ? x.json() : null))
    get('assembly-readiness.json').then((d) => !off && setR(d))
    get('sourcing-report.json').then((d) => !off && setSrc(d))
    get('substitutions.json').then((d) => !off && setSubs(Array.isArray(d) ? d : []))
    return () => {
      off = true
    }
  }, [runId])

  if (!runId || r === null)
    return <div className="p-4 text-xs text-muted-foreground">No assembly package for this run.</div>
  if (r === undefined) return <div className="p-4 text-xs text-muted-foreground">Loading…</div>

  const ready = r.ready_for_assembly
  const lines: any[] = src?.lines ?? []
  const sum = src?.summary ?? {}

  return (
    <div className="space-y-4 overflow-y-auto p-4 text-xs">
      {/* readiness banner */}
      <div className="flex flex-wrap items-center gap-2">
        <PackageCheck className="size-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">PCBA Assembly</span>
        <span
          className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] ${
            ready
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
              : 'border-destructive/40 bg-destructive/10 text-destructive'
          }`}
        >
          {ready ? 'ready for assembly' : 'not ready — missing parts'}
        </span>
        {fabZip && (
          <a
            href={fabZip}
            download
            className="ml-auto inline-flex items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-2 py-1 text-[11px] text-primary hover:bg-primary/20"
          >
            <Download className="size-3" /> Download PCBA package
          </a>
        )}
      </div>

      {/* board + placement summary */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['Placed', r.board?.components_placed],
          ['DNP', r.board?.dnp],
          ['Fine-pitch', r.fine_pitch_parts?.length ?? 0],
          ['Sourcing conf.', r.sourcing_confidence],
        ].map(([k, v]) => (
          <div key={k as string} className="rounded-md border border-border p-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</div>
            <div className="font-mono text-sm text-foreground">{v ?? '—'}</div>
          </div>
        ))}
      </div>

      {/* honest sourcing state */}
      {src?.live_sourcing && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-500">
            <AlertTriangle className="size-3.5" /> Sourcing: {src.live_sourcing.available ? 'live' : 'fallback mode'}
          </p>
          <p className="mt-1 text-muted-foreground">{src.live_sourcing.note}</p>
          <p className="mt-1 font-mono text-[10px] text-muted-foreground">
            equivalent {sum.equivalent ?? 0} · fallback {sum.fallback ?? 0} · missing {sum.missing ?? 0}
          </p>
        </div>
      )}

      {/* hand-solder / handling */}
      <div className="flex flex-wrap gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-muted-foreground">
          <Wrench className="size-3" /> hand-solder: {r.hand_solder_compatible ? 'yes' : 'no'} ({r.hand_solder_risk})
        </span>
        <span className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-muted-foreground">
          <CircuitBoard className="size-3" /> {r.recommended_assembly}
        </span>
      </div>

      {/* substitutions (honest, not drop-in) */}
      {subs.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-500">
            Substitutions (review before production — not footprint drop-in)
          </p>
          {subs.map((s, i) => (
            <div key={i} className="text-muted-foreground">
              <span className="text-foreground">{s.original}</span> → <span className="font-mono">{s.substitute}</span>
              {s.lost?.length ? <span> · lost: {s.lost.join(', ')}</span> : null}
            </div>
          ))}
        </div>
      )}

      {/* sourcing table */}
      {lines.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Bill of materials sourcing
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[10px]">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-1 pr-3">Refs</th>
                  <th className="py-1 pr-3">Part</th>
                  <th className="py-1 pr-3">MPN</th>
                  <th className="py-1 pr-3">LCSC</th>
                  <th className="py-1 pr-3">Match</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className="border-b border-border/40">
                    <td className="py-1 pr-3 text-foreground">{l.refs}</td>
                    <td className="py-1 pr-3 text-muted-foreground">{l.part}</td>
                    <td className="py-1 pr-3 text-muted-foreground">{l.mpn || '—'}</td>
                    <td className="py-1 pr-3 text-muted-foreground">{l.lcsc || '—'}</td>
                    <td
                      className={`py-1 pr-3 ${
                        l.match === 'equivalent'
                          ? 'text-emerald-500'
                          : l.match === 'missing'
                            ? 'text-destructive'
                            : l.match === 'not_placed'
                              ? 'text-muted-foreground'
                              : 'text-amber-500'
                      }`}
                    >
                      {l.match}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
