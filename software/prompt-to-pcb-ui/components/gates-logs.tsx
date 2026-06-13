'use client'

import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import {
  GATE_REPORTS_PASSED,
  GATE_REPORTS_FAILED,
  type GateReport,
  type Run,
  type StageId,
} from '@/lib/firstlight'
import { Check, X, FileJson2 } from 'lucide-react'

const STAGE_COLOR: Record<StageId, string> = {
  design: 'text-primary',
  placement: 'text-[#5fb3e8]',
  routing: 'text-[#c792ea]',
  validation: 'text-success',
}

export function GatesLogs({
  run,
  reports: reportsProp,
}: {
  run: Run
  reports?: GateReport[] | null
}) {
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [run.logs.length])

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
