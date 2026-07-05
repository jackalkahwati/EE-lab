'use client'

/**
 * FL-1 closed-loop tab: run a (simulated) machine test against this board's
 * own test plan, read the diagnosis, and turn the ECO into Rev B with one
 * click. When the physical FL-1 exists, real probe data replaces the
 * simulator, the rest of this loop is already the product.
 */

import { useState } from 'react'
import { Activity, Loader2, GitBranch, CheckCircle2, XCircle } from 'lucide-react'
import { llmHeaders } from '@/components/llm-settings'

interface Measurement {
  point: string
  net: string
  type: string
  expected: string
  measured: string
  pass: boolean
}

interface LoopResult {
  scenario?: string
  scenarioLabel?: string
  simulated?: boolean
  measurements?: Measurement[]
  anyFail?: boolean
  verdict?: string
  failed_points?: string[]
  diagnosis?: string
  root_cause?: string
  eco?: string
  error?: string
}

const SCENARIOS = [
  { id: 'pass', label: 'Healthy board' },
  { id: 'fail_3v3_sag', label: '+3V3 rail sag' },
  { id: 'fail_rail_short', label: 'Rail short (pre-power)' },
  { id: 'fail_dead_bus', label: 'Dead SPI bus' },
]

export function FL1Loop({
  runId,
  onRevise,
}: {
  runId: string | null
  onRevise: (ecoText: string) => void
}) {
  const [scenario, setScenario] = useState('pass')
  const [result, setResult] = useState<LoopResult | null>(null)
  const [busy, setBusy] = useState(false)

  async function run() {
    if (!runId) return
    setBusy(true)
    setResult(null)
    try {
      const r = await fetch('/api/fl1', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ runId, scenario }),
      })
      setResult((await r.json()) as LoopResult)
    } catch (e) {
      setResult({ error: String(e) })
    } finally {
      setBusy(false)
    }
  }

  if (!runId) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        Select a PASSED compose run (with an FL-1 test plan) to simulate the loop.
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="size-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">FL-1 validation loop</span>
          <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            SIMULATED, machine hardware in EVT
          </span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
            className="rounded-sm border border-border bg-background px-2 py-1.5 text-xs text-foreground"
          >
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={run}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Activity className="size-3.5" />}
            {busy ? 'Probing…' : 'Run FL-1 test'}
          </button>
        </div>
      </div>

      {result?.error && (
        <p className="rounded-sm border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {result.error}
        </p>
      )}

      {result?.measurements && (
        <>
          <table className="mb-4 w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border text-left font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 pr-2">Point</th>
                <th className="py-1.5 pr-2">Net</th>
                <th className="py-1.5 pr-2">Check</th>
                <th className="py-1.5 pr-2">Expected</th>
                <th className="py-1.5 pr-2">Measured</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {result.measurements.map((m, i) => (
                <tr key={i} className="border-b border-border/50">
                  <td className="py-1.5 pr-2 font-mono">{m.point}</td>
                  <td className="py-1.5 pr-2 font-mono">{m.net}</td>
                  <td className="py-1.5 pr-2 text-muted-foreground">{m.type}</td>
                  <td className="py-1.5 pr-2 text-muted-foreground">{m.expected}</td>
                  <td className={`py-1.5 pr-2 font-mono ${m.pass ? '' : 'text-destructive'}`}>
                    {m.measured}
                  </td>
                  <td className="py-1.5">
                    {m.pass ? (
                      <CheckCircle2 className="size-3.5 text-success" />
                    ) : (
                      <XCircle className="size-3.5 text-destructive" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div
            className={`mb-3 rounded-md border p-3 ${
              result.verdict === 'PASS'
                ? 'border-success/40 bg-success/5'
                : 'border-destructive/40 bg-destructive/5'
            }`}
          >
            <p className="mb-1 font-mono text-xs font-semibold">
              {result.verdict === 'PASS' ? '✓ PASS' : '✗ FAIL'}
              {result.failed_points?.length ? `, ${result.failed_points.join(', ')}` : ''}
            </p>
            <p className="text-xs text-muted-foreground">{result.diagnosis}</p>
            {result.root_cause && (
              <p className="mt-1.5 text-xs">
                <span className="font-semibold text-foreground">Root cause: </span>
                <span className="text-muted-foreground">{result.root_cause}</span>
              </p>
            )}
          </div>

          {result.eco && (
            <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
              <p className="mb-2 text-xs">
                <span className="font-semibold text-primary">Suggested ECO: </span>
                <span className="text-muted-foreground">{result.eco}</span>
              </p>
              <button
                type="button"
                onClick={() => onRevise(result.eco!)}
                className="flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
              >
                <GitBranch className="size-3.5" />
                Generate Rev B from this ECO
              </button>
            </div>
          )}
        </>
      )}

      {!result && !busy && (
        <p className="text-xs text-muted-foreground">
          Runs this board&apos;s own <code className="font-mono">fl1-testplan.json</code> , 
          pre-power short screen, power-up sequence, rail voltages, and bus activity, then
          diagnoses the results and proposes the fix. Pick a failure scenario to see the
          full closed loop: measure → diagnose → ECO → Rev B.
        </p>
      )}
    </div>
  )
}
