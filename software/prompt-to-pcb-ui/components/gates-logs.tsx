'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  GATE_REPORTS_PASSED,
  GATE_REPORTS_FAILED,
  type GateReport,
  type Run,
  type StageId,
} from '@/lib/firstlight'
import {
  Check,
  X,
  FileJson2,
  Wrench,
  RefreshCw,
  Download,
  Upload,
  Loader2,
  Stethoscope,
} from 'lucide-react'

const STAGE_COLOR: Record<StageId, string> = {
  design: 'text-primary',
  placement: 'text-[#5fb3e8]',
  routing: 'text-[#c792ea]',
  validation: 'text-success',
  erc: 'text-[#7fd4a8]',
  firmware: 'text-[#e8b75f]',
}

type RepairOp =
  | 'revalidate'
  | 'clearance'
  | 'placement'
  | 'stitch'
  | 'stitch-plane'
  | 'reroute'
  | 'diagnose'

// map a failing gate check to the repair that addresses it
function opForRule(rule: string): { op: RepairOp; label: string } | null {
  const r = rule.toLowerCase()
  // unconnected pads are almost always SMD power/gnd pins with no via to their
  // plane — stitch_to_plane fixes that directly (reroute is the signal-net path).
  if (r.includes('unconnected'))
    return { op: 'stitch-plane', label: 'Fix: stitch pads to plane' }
  if (r.includes('drc violations')) return { op: 'clearance', label: 'Fix: repair clearance' }
  if (r.includes('overlap') || r.includes('off-board') || r.includes('courtyard'))
    return { op: 'placement', label: 'Fix: repair placement' }
  return null
}

export function GatesLogs({
  run,
  reports: reportsProp,
  runDir,
  onRefresh,
}: {
  run: Run
  reports?: GateReport[] | null
  runDir?: string
  onRefresh?: () => void
}) {
  const logRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState<RepairOp | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [run.logs.length])

  // repair is only possible for a real run that has its own persisted board dir
  const canRepair = run.real === true && !!runDir && run.status !== 'RUNNING'

  async function runRepair(op: RepairOp) {
    if (busy) return
    setBusy(op)
    setResult(null)
    try {
      const res = await fetch('/api/pipeline/repair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: run.id, op }),
      })
      const data = await res.json()
      if (!res.ok) {
        setResult(`✗ ${data.error ?? 'repair failed'}`)
      } else if (op === 'diagnose') {
        setResult(data.diagnosis || 'no diagnosis returned')
      } else {
        const b = data.before
        const a = data.after
        setResult(
          `${op}: violations ${b.violations}→${a.violations}, ` +
            `unconnected ${b.unconnected}→${a.unconnected} — ${data.status}`,
        )
        onRefresh?.()
      }
    } catch (e) {
      setResult(`✗ ${String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  async function uploadBoard(file: File) {
    setBusy('revalidate')
    setResult(null)
    try {
      const text = await file.text()
      const up = await fetch(`/api/pipeline/upload?runId=${encodeURIComponent(run.id)}`, {
        method: 'POST',
        body: text,
      })
      if (!up.ok) {
        const d = await up.json()
        setResult(`✗ upload: ${d.error ?? up.status}`)
        return
      }
      setBusy(null)
      await runRepair('revalidate')
    } catch (e) {
      setResult(`✗ ${String(e)}`)
      setBusy(null)
    }
  }

  const reports =
    reportsProp ??
    (run.status === 'GATE FAILED' ? GATE_REPORTS_FAILED : GATE_REPORTS_PASSED)

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3 lg:flex-row">
      {/* terminal log */}
      <div className="flex min-h-64 flex-1 flex-col overflow-hidden rounded-sm border border-border bg-[#07090c]">
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
          <span className="size-2 rounded-full bg-destructive/60" />
          <span className="size-2 rounded-full bg-primary/60" />
          <span className="size-2 rounded-full bg-success/60" />
          <span className="ml-1 font-mono text-[10px] text-muted-foreground">
            firstlight — pipeline.log
          </span>
        </div>
        <div
          ref={logRef}
          className="flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed"
        >
          {run.logs.map((line, i) => (
            <div key={i} className="flex gap-2">
              <span className={cn('shrink-0', STAGE_COLOR[line.stage])}>
                [{line.prefix}]
              </span>
              <span
                className={cn(
                  line.level === 'ok' && 'text-success',
                  line.level === 'err' && 'text-destructive',
                  line.level === 'warn' && 'text-primary',
                  (!line.level || line.level === 'info') && 'text-foreground/80',
                )}
              >
                {line.text}
              </span>
            </div>
          ))}
          {run.status === 'RUNNING' && (
            <div className="flex gap-2">
              <span className="text-muted-foreground stage-pulse">▋</span>
            </div>
          )}
        </div>
      </div>

      {/* gate report cards */}
      <div className="flex w-full flex-col gap-3 lg:w-80 lg:shrink-0">
        {/* incremental-repair toolbar — fix defects without re-running the pipeline */}
        {canRepair && (
          <div className="flex flex-col gap-2 rounded-sm border border-border bg-card p-2.5">
            <div className="flex items-center gap-2">
              <Wrench className="size-3.5 text-primary" />
              <span className="font-mono text-[11px] text-foreground">repair this run</span>
              {busy && <Loader2 className="size-3 animate-spin text-primary" />}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                disabled={!!busy}
                onClick={() => runRepair('revalidate')}
                className="flex items-center gap-1 rounded-sm border border-border bg-secondary px-2 py-1 font-mono text-[10px] text-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-40"
              >
                <RefreshCw className="size-3" /> Re-validate
              </button>
              <a
                href={`${runDir}/variant.kicad_pcb`}
                download
                className="flex items-center gap-1 rounded-sm border border-border bg-secondary px-2 py-1 font-mono text-[10px] text-foreground transition-colors hover:border-primary/40 hover:text-primary"
              >
                <Download className="size-3" /> Download .kicad_pcb
              </a>
              <button
                type="button"
                disabled={!!busy}
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-1 rounded-sm border border-border bg-secondary px-2 py-1 font-mono text-[10px] text-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-40"
              >
                <Upload className="size-3" /> Upload fixed
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".kicad_pcb"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) uploadBoard(f)
                  e.target.value = ''
                }}
              />
            </div>
            {result && (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-[#07090c] p-2 font-mono text-[10px] leading-relaxed text-foreground/80">
                {result}
              </pre>
            )}
          </div>
        )}
        {reports.map((report) => {
          const allPass = report.checks.every((c) => c.pass)
          return (
            <div
              key={report.file}
              className={cn(
                'rounded-sm border bg-card',
                allPass ? 'border-border' : 'border-destructive/40',
              )}
            >
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <div className="flex items-center gap-2">
                  <FileJson2 className="size-3.5 text-muted-foreground" />
                  <span className="font-mono text-xs text-foreground">
                    {report.file}
                  </span>
                </div>
                <span
                  className={cn(
                    'rounded-sm border px-1.5 py-0.5 font-mono text-[10px] leading-none',
                    allPass
                      ? 'border-success/40 bg-success/10 text-success'
                      : 'border-destructive/40 bg-destructive/10 text-destructive',
                  )}
                >
                  {allPass ? 'PASS' : 'FAIL'}
                </span>
              </div>
              <ul className="flex flex-col gap-1.5 p-3">
                {report.checks.map((check) => (
                  <li
                    key={check.rule}
                    className="flex items-start gap-2 font-mono text-[11px] leading-snug"
                  >
                    {check.pass ? (
                      <Check
                        className="mt-0.5 size-3 shrink-0 text-success"
                        strokeWidth={3}
                      />
                    ) : (
                      <X
                        className="mt-0.5 size-3 shrink-0 text-destructive"
                        strokeWidth={3}
                      />
                    )}
                    <span className="text-foreground/80">
                      {check.rule} —{' '}
                      <span
                        className={
                          check.pass ? 'text-success' : 'text-destructive'
                        }
                      >
                        {check.pass ? 'PASS' : 'FAIL'}, {check.measured}
                      </span>
                      {!check.pass && canRepair && opForRule(check.rule) && (
                        <span className="mt-1 flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            disabled={!!busy}
                            onClick={() => runRepair(opForRule(check.rule)!.op)}
                            className="flex items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-40"
                          >
                            <Wrench className="size-2.5" /> {opForRule(check.rule)!.label}
                          </button>
                          {opForRule(check.rule)!.op === 'stitch-plane' && (
                            <button
                              type="button"
                              disabled={!!busy}
                              onClick={() => runRepair('diagnose')}
                              className="flex items-center gap-1 rounded-sm border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-40"
                            >
                              <Stethoscope className="size-2.5" /> Diagnose
                            </button>
                          )}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
        {run.status === 'GATE FAILED' && (
          <p className="rounded-sm border border-destructive/40 bg-destructive/5 p-3 font-mono text-[11px] leading-relaxed text-destructive">
            {reportsProp
              ? `Gate failed: ${
                  reports
                    .flatMap((r) => r.checks)
                    .find((c) => !c.pass)?.rule ?? 'see report'
                } — ${
                  reports
                    .flatMap((r) => r.checks)
                    .find((c) => !c.pass)?.measured ?? ''
                }. Board does not ship until the referee reports zero.`
              : 'Pipeline halted at placement gate. Downstream stages (routing, validation) are blocked until the courtyard overlap is resolved.'}
          </p>
        )}
      </div>
    </div>
  )
}
