'use client'

/**
 * Pinout / MCU tab — the MCU Selection & Pin Allocation view. Renders a run's
 * mcu-selection.json + pin-assignment.json (+ mcu-recovery.json when the
 * requested MCU had to be substituted). Shows the selected MCU and WHY, the
 * candidates it rejected and why, the real pad assignments, reserved pins, and a
 * download for pin_assignment.json. Nothing faked — pads come from the allocator.
 */

import { useEffect, useState } from 'react'
import { Cpu, AlertTriangle, ShieldQuestion, Download, XCircle } from 'lucide-react'

export function PinoutPanel({ runId }: { runId: string | null }) {
  const [sel, setSel] = useState<any | null | undefined>(undefined)
  const [pin, setPin] = useState<any | null>(null)
  const [rec, setRec] = useState<any | null>(null)

  useEffect(() => {
    if (!runId) {
      setSel(null)
      return
    }
    let off = false
    const base = `/runs/${runId}/data`
    const get = (f: string) =>
      fetch(`${base}/${f}`, { cache: 'no-store' }).then((x) => (x.ok ? x.json() : null))
    get('mcu-selection.json').then((d) => !off && setSel(d))
    get('pin-assignment.json').then((d) => !off && setPin(d))
    get('mcu-recovery.json').then((d) => !off && setRec(d))
    return () => {
      off = true
    }
  }, [runId])

  if (!runId || sel === null)
    return <div className="p-4 text-xs text-muted-foreground">No MCU selection for this run.</div>
  if (sel === undefined) return <div className="p-4 text-xs text-muted-foreground">Loading…</div>

  const rejected: any[] = sel.rejected ?? []
  const assignments: any[] = pin?.assignments ?? []
  const reserved: Record<string, string[]> = pin?.reserved ?? {}
  const conflicts: any[] = pin?.conflicts ?? []

  return (
    <div className="space-y-4 overflow-y-auto p-4 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Cpu className="size-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">MCU &amp; Pin Allocation</span>
        {sel.selected && (
          <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] text-foreground">
            {sel.selected} · {sel.package}
          </span>
        )}
        <span
          className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${
            sel.status === 'supported'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-500'
          }`}
        >
          {sel.status ?? 'n/a'}
        </span>
        {pin && (
          <a
            href={`/runs/${runId}/data/pin-assignment.json`}
            download
            className="ml-auto inline-flex items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-2 py-1 text-[11px] text-primary hover:bg-primary/20"
          >
            <Download className="size-3" /> pin_assignment.json
          </a>
        )}
      </div>

      {sel.why && <p className="text-muted-foreground">Why: {sel.why}</p>}
      {sel.partial_warning && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-amber-500">
          partial: {sel.partial_warning}
        </p>
      )}

      {/* MCU recovery / substitution */}
      {rec && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-amber-500">
            <AlertTriangle className="size-3.5" /> MCU substituted (requested part could not meet the design)
          </p>
          <div className="text-muted-foreground">
            <span className="font-mono text-foreground">{rec.requested_mcu}</span> →{' '}
            <span className="font-mono text-foreground">{rec.substituted_mcu}</span>
            <div className="pl-3">
              <div>blocker: {rec.blocker}</div>
              <div className="text-emerald-500">preserved: {(rec.preserved ?? []).join(', ')}</div>
              <div className="text-amber-500">lost: {(rec.lost ?? []).join('; ')}</div>
            </div>
          </div>
        </div>
      )}

      {/* pin conflicts (should be empty on a good board) */}
      {conflicts.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-destructive">
          <p className="flex items-center gap-1.5 font-semibold">
            <XCircle className="size-3.5" /> Unresolved pin conflicts
          </p>
          {conflicts.map((c, i) => (
            <div key={i} className="pl-3 text-muted-foreground">
              {c.role} ({c.cap}): {c.why}
            </div>
          ))}
        </div>
      )}

      {/* pin assignment table */}
      {assignments.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Pin assignment
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[10px]">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-1 pr-3">Signal</th>
                  <th className="py-1 pr-3">Net</th>
                  <th className="py-1 pr-3">Pad</th>
                  <th className="py-1 pr-3">Capability</th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((a, i) => (
                  <tr key={i} className="border-b border-border/40">
                    <td className="py-1 pr-3 text-foreground">{a.role}</td>
                    <td className="py-1 pr-3 text-muted-foreground">{a.net}</td>
                    <td className="py-1 pr-3 text-primary">{a.pad}</td>
                    <td className="py-1 pr-3 text-muted-foreground">{a.cap}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* reserved pads */}
      {Object.values(reserved).some((v) => v.length) && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Reserved (never allocated)
          </p>
          <div className="space-y-0.5 font-mono text-[10px] text-muted-foreground">
            {Object.entries(reserved)
              .filter(([, v]) => v.length)
              .map(([k, v]) => (
                <div key={k}>
                  <span className="text-foreground">{k}:</span> {v.join(', ')}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* rejected candidates */}
      {rejected.length > 0 && (
        <div>
          <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <ShieldQuestion className="size-3" /> Rejected candidates
          </p>
          <ul className="space-y-0.5">
            {rejected.map((r, i) => (
              <li key={i} className="text-muted-foreground">
                <span className="font-mono text-foreground">{r.mcu}</span> — {(r.reasons ?? []).join('; ')}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
