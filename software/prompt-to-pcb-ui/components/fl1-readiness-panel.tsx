'use client'

/**
 * FL-1 Instrument Readiness — the honest planning view for the FL-1 internal
 * instrument board family. Reads the fl1-* reports: board readiness ranking,
 * instrument bus, pattern readiness, RF/scope/stimulus/logic/FPGA status, and
 * manufacturing capability. Never fakes a capability — scope-lite shows
 * unsupported, RF shows estimate-only, DDR/PCIe/MIPI/BGA show unsupported.
 */

import { useEffect, useState } from 'react'
import { Cpu, Download, AlertTriangle } from 'lucide-react'

const R_STYLE: Record<string, string> = {
  ready_to_attempt: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  pattern_backed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  buildable_with_review: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  partial: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  needs_reference: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  needs_simulation: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  needs_specialist_fab: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  needs_external_instrument: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  unsupported: 'border-destructive/40 bg-destructive/10 text-destructive',
}

export function FL1ReadinessPanel({ runId }: { runId: string | null }) {
  const [d, setD] = useState<Record<string, any> | null | undefined>(undefined)

  useEffect(() => {
    if (!runId) {
      setD(null)
      return
    }
    let off = false
    const files = [
      'fl1-board-family-architecture', 'fl1-instrument-bus-v1',
      'fl1-reference-pattern-readiness', 'fl1-rf-50ohm-interface-report',
      'fl1-scope-lite-starter-report', 'fl1-stimulus-starter-report',
      'fl1-logic-capture-starter-report', 'fl1-fpga-module-carrier-report',
      'fl1-manufacturing-capability-report',
    ]
    Promise.all(
      files.map((f) =>
        fetch(`/runs/${runId}/data/${f}.json`, { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => [f, j] as const)
          .catch(() => [f, null] as const),
      ),
    ).then((p) => !off && setD(Object.fromEntries(p)))
    return () => {
      off = true
    }
  }, [runId])

  if (!runId || d === null)
    return <div className="p-4 text-xs text-muted-foreground">No FL-1 readiness reports for this run.</div>
  if (d === undefined) return <div className="p-4 text-xs text-muted-foreground">Loading…</div>

  const fam = d['fl1-board-family-architecture']
  if (!fam)
    return <div className="p-4 text-xs text-muted-foreground">No FL-1 readiness reports for this run.</div>

  const starters = [
    ['RF / 50Ω interface', d['fl1-rf-50ohm-interface-report']],
    ['Scope-lite starter', d['fl1-scope-lite-starter-report']],
    ['Stimulus starter', d['fl1-stimulus-starter-report']],
    ['Logic capture starter', d['fl1-logic-capture-starter-report']],
    ['FPGA/module carrier', d['fl1-fpga-module-carrier-report']],
  ] as const

  return (
    <div className="space-y-4 overflow-y-auto p-4 text-xs">
      <div className="flex items-center gap-2">
        <Cpu className="size-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">FL-1 Instrument Readiness</span>
        <a
          href={`/runs/${runId}/data/fl1-board-family-architecture.json`}
          download
          className="ml-auto inline-flex items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20"
        >
          <Download className="size-3" /> architecture JSON
        </a>
      </div>

      {/* board family readiness ranking */}
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
          Board family readiness ({fam.boards?.length ?? 0})
        </p>
        <div className="space-y-1">
          {(fam.boards ?? []).map((b: any, i: number) => (
            <div key={i} className="rounded-md border border-border px-3 py-1.5">
              <div className="flex items-center gap-2">
                <span className="text-foreground">{b.name}</span>
                <span
                  className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${
                    R_STYLE[b.readiness] ?? 'border-border text-muted-foreground'
                  }`}
                >
                  {b.readiness}
                </span>
                <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                  {b.manufacturing}
                </span>
              </div>
              {b.blockers?.length > 0 && (
                <div className="mt-0.5 flex items-start gap-1 text-[10px] text-muted-foreground">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0 text-amber-500" />
                  {b.blockers.join('; ')}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* starter statuses (honesty front and center) */}
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
          Starter capability status
        </p>
        <div className="space-y-1">
          {starters.map(([name, rep]) =>
            rep ? (
              <div key={name} className="rounded-md border border-border px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-foreground">{name}</span>
                  <span
                    className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${
                      R_STYLE[rep.status] ?? 'border-border text-muted-foreground'
                    }`}
                  >
                    {rep.status}
                  </span>
                </div>
                {rep.honesty && (
                  <div className="mt-0.5 text-[10px] text-amber-500">
                    {Object.values(rep.honesty).join(' · ')}
                  </div>
                )}
                {rep.unsupported && (
                  <div className="mt-0.5 font-mono text-[9px] text-destructive">
                    {Object.keys(rep.unsupported).filter((k) => rep.unsupported[k]).join(', ')}
                  </div>
                )}
              </div>
            ) : null,
          )}
        </div>
      </div>

      {/* pattern readiness summary */}
      {d['fl1-reference-pattern-readiness'] && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Reference pattern readiness
          </p>
          <div className="flex flex-wrap gap-1 font-mono text-[10px]">
            {Object.entries(d['fl1-reference-pattern-readiness'].summary ?? {}).map(([k, v]) => (
              <span key={k} className="rounded-sm border border-border px-1.5 py-0.5 text-muted-foreground">
                {k}: {String(v)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* instrument bus */}
      {d['fl1-instrument-bus-v1'] && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            FL-1 instrument bus ({d['fl1-instrument-bus-v1'].version})
          </p>
          <div className="font-mono text-[10px] text-muted-foreground">
            rails: {(d['fl1-instrument-bus-v1'].power_rails ?? []).join(', ')} · protected:{' '}
            {(d['fl1-instrument-bus-v1'].protected_rails ?? []).join(', ')} · control:{' '}
            {(d['fl1-instrument-bus-v1'].control_bus_options ?? []).join('/')}
          </div>
        </div>
      )}
    </div>
  )
}
