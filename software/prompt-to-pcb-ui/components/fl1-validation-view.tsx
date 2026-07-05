'use client'

/**
 * FL-1 Validation Package viewer: the human-readable render of a run's
 * fl1-validation.json — the executable bring-up + test spec FL-1 runs. Every
 * value comes straight from the file; nothing is invented. Sections absent from
 * the file are simply not shown.
 */

import { useEffect, useState } from 'react'
import { ClipboardList, ChevronRight } from 'lucide-react'

// deliberately loose: we only ever read fields, and missing ones are skipped
type Pkg = Record<string, any>

export function FL1ValidationView({ runId }: { runId: string | null }) {
  const [pkg, setPkg] = useState<Pkg | null | undefined>(undefined)
  const [rawOpen, setRawOpen] = useState(false)

  useEffect(() => {
    if (!runId) {
      setPkg(null)
      return
    }
    let cancelled = false
    fetch(`/runs/${runId}/data/fl1-validation.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => !cancelled && setPkg(d))
      .catch(() => !cancelled && setPkg(null))
    return () => {
      cancelled = true
    }
  }, [runId])

  if (!runId || pkg === null) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        No FL-1 Validation Package for this run (generated for boards that pass).
      </div>
    )
  }
  if (pkg === undefined) return <div className="p-4 text-xs text-muted-foreground">Loading…</div>

  const ps = pkg.power_sequence ?? {}
  const rails: any[] = ps.expected_currents ?? []
  const fw = pkg.firmware_programming

  return (
    <div className="space-y-4 p-4 text-xs">
      <div className="flex items-center gap-2">
        <ClipboardList className="size-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">FL-1 Validation Package</span>
        <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          executable spec FL-1 runs
        </span>
      </div>

      {/* required tools */}
      {arr(pkg.required_fl1_tools).length > 0 && (
        <Section title="Required FL-1 tools">
          <div className="flex flex-wrap gap-1.5">
            {arr(pkg.required_fl1_tools).map((t: string) => (
              <span key={t} className="rounded-sm border border-border bg-card px-1.5 py-0.5 font-mono text-[10px]">
                {t}
              </span>
            ))}
          </div>
        </Section>
      )}

      {/* power-up sequence + expected rails/currents */}
      {(arr(ps.power_up).length > 0 || rails.length > 0) && (
        <Section title="Power-up sequence & rails">
          {arr(ps.pre_power_checks).length > 0 && (
            <p className="mb-2 text-muted-foreground">
              Pre-power: {arr(ps.pre_power_checks).map((c: any) => c.note ?? c.check).join('; ')}
            </p>
          )}
          <ol className="mb-2 space-y-1">
            {arr(ps.power_up).map((s: any, i: number) => (
              <li key={i} className="text-muted-foreground">
                <span className="font-mono text-foreground">{s.step}.</span> {s.action}
                {s.verify && <span className="text-muted-foreground"> → {s.verify}</span>}
                {s.limit_ma != null && <span className="font-mono"> (≤{s.limit_ma} mA inrush)</span>}
              </li>
            ))}
          </ol>
          {rails.length > 0 && (
            <Table
              head={['Rail', 'Typical', 'Max', 'OC trip']}
              rows={rails.map((r) => [r.rail, mA(r.typical_ma), mA(r.max_ma), mA(r.over_current_trip_ma)])}
            />
          )}
          {arr(ps.timing).length > 0 && (
            <div className="mt-2 space-y-0.5 text-muted-foreground">
              {arr(ps.timing).map((t: any, i: number) => (
                <div key={i}>
                  <span className="font-mono text-foreground">{t.requirement}</span> ({t.signal}): {t.spec}
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* firmware programming */}
      {fw && (
        <Section title="Firmware programming">
          <p className="text-muted-foreground">
            <span className="font-mono text-foreground">{fw.target}</span> via {fw.interface}
          </p>
          <ol className="mt-1 space-y-0.5">
            {arr(fw.steps).map((s: any, i: number) => (
              <li key={i} className="text-muted-foreground">
                <span className="font-mono text-foreground">{s.step}.</span> {s.action}
              </li>
            ))}
          </ol>
          {fw.verify && <p className="mt-1 text-muted-foreground">Verify: {fw.verify}</p>}
        </Section>
      )}

      {/* bus protocols */}
      {arr(pkg.bus_protocols).length > 0 && (
        <Section title="Bus protocols">
          <div className="space-y-2">
            {arr(pkg.bus_protocols).map((b: any, i: number) => (
              <div key={i} className="rounded-sm border border-border bg-card p-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-foreground">{b.bus}</span>
                  <span className="text-muted-foreground">{b.speed ?? b.mode ?? b.protocol}</span>
                </div>
                {arr(b.signals).length > 0 && (
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {arr(b.signals).join(' · ')}
                  </p>
                )}
                {arr(b.devices).length > 0 && (
                  <p className="mt-0.5 text-muted-foreground">
                    devices: {arr(b.devices).map((d: any) => `${d.ref} ${d.part}`).join(', ')}
                  </p>
                )}
                {b.termination && <p className="mt-0.5 text-muted-foreground">{b.termination}</p>}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* probe map */}
      {arr(pkg.probe_map).length > 0 && (
        <Section title={`Probe map (${arr(pkg.probe_map).length} points)`}>
          <Table
            head={['Point', 'Net', 'X (mm)', 'Y (mm)', 'Pad']}
            rows={arr(pkg.probe_map).map((p: any) => [p.ref, p.net, p.x_mm, p.y_mm, p.pad_mm])}
          />
        </Section>
      )}

      {/* functional test sequence */}
      {arr(pkg.functional_tests).length > 0 && (
        <Section title="Functional test sequence">
          <ol className="space-y-1">
            {arr(pkg.functional_tests).map((t: any, i: number) => (
              <li key={i} className="text-muted-foreground">
                <span className="font-mono text-foreground">{t.step}. {t.name}</span>
                {t.pass_if && <span className="text-muted-foreground"> — pass if {t.pass_if}</span>}
              </li>
            ))}
          </ol>
        </Section>
      )}

      {/* pass/fail measurement limits */}
      {arr(pkg.measurements).length > 0 && (
        <Section title="Pass/fail limits">
          <Table
            head={['Point', 'Net', 'Check', 'Expected', 'Min', 'Max']}
            rows={arr(pkg.measurements).map((m: any) => [
              m.point, m.net, m.type,
              m.expect_v != null ? `${m.expect_v} V` : (m.expect ?? '—'),
              m.min_v != null ? `${m.min_v} V` : '—',
              m.max_v != null ? `${m.max_v} V` : '—',
            ])}
          />
        </Section>
      )}

      {/* calibration */}
      {arr(pkg.calibration).length > 0 && (
        <Section title="Calibration procedures">
          <ul className="space-y-1">
            {arr(pkg.calibration).map((c: any, i: number) => (
              <li key={i} className="text-muted-foreground">
                <span className="font-mono text-foreground">{c.procedure}</span> — ref: {c.reference}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* manual / unsupported */}
      {arr(pkg.manual_or_unsupported_tests).length > 0 && (
        <Section title="Manual / unsupported tests">
          <ul className="space-y-1">
            {arr(pkg.manual_or_unsupported_tests).map((m: any, i: number) => (
              <li key={i} className="text-muted-foreground">
                <span className="text-amber-500">{m.test}</span> — {m.reason}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* raw JSON */}
      <div>
        <button
          type="button"
          onClick={() => setRawOpen((o) => !o)}
          className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={`size-3 transition-transform ${rawOpen ? 'rotate-90' : ''}`} />
          Raw fl1-validation.json
        </button>
        {rawOpen && (
          <pre className="mt-2 max-h-96 overflow-auto rounded-sm border border-border bg-card p-2 font-mono text-[10px] text-muted-foreground">
            {JSON.stringify(pkg, null, 1)}
          </pre>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-primary">{title}</p>
      {children}
    </div>
  )
}

function Table({ head, rows }: { head: string[]; rows: any[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-[10px]">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            {head.map((h) => (
              <th key={h} className="py-1 pr-3 font-semibold">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/40">
              {r.map((c, j) => (
                <td key={j} className="py-1 pr-3 text-muted-foreground">{c ?? '—'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function arr(x: any): any[] {
  return Array.isArray(x) ? x : []
}
function mA(v: any) {
  return v == null ? '—' : `${v} mA`
}
