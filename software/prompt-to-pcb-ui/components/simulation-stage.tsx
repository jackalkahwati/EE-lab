'use client'

/**
 * Simulation stage — runs the physics sims and shows each result with its metric,
 * pass/fail, fidelity, and the tool that produced it. thermal + drop are REAL FEM
 * (scikit-fem); acoustics/RF/battery are analytic/surrogate, honestly labeled; the
 * high-fidelity solvers for those (Elmer/CalculiX/openEMS/OpenFOAM) are the
 * install-gated upgrade. Generic — the runner picks whichever sims the inputs support.
 */
import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { Loader2, Gauge, Check, X, Minus } from 'lucide-react'

type SimResult = {
  sim: string; physics?: string; metric?: string; value?: number; unit?: string
  limit?: number | null; pass?: boolean | null; fidelity?: string; tool?: string
  detail?: Record<string, unknown>; note?: string; error?: string
}
type Result = { scipy: boolean; results: SimResult[] }

export function SimulationStage({ spec, runId, onBuilt }: { spec: any; runId?: string; onBuilt?: () => void }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [res, setRes] = useState<Result | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Load a persisted sim result on mount (written by /api/simulate) so the
  // orchestrator's run shows without re-running.
  useEffect(() => {
    if (!runId) return
    let off = false
    fetch(`/runs/${runId}/disciplines/simulation.json`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!off && d && Array.isArray(d.results)) { setRes(d); setState('done') } })
      .catch(() => {})
    return () => { off = true }
  }, [runId])

  async function run() {
    if (!spec) return
    setState('loading'); setErr(null)
    try {
      const r = await fetch('/api/simulate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec, runId }),
      })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      setRes(d); setState('done'); onBuilt?.()
    } catch (e) { setErr(String(e)); setState('error') }
  }

  const Verdict = ({ p }: { p?: boolean | null }) =>
    p === true ? <Check className="size-3.5 text-emerald-500" />
      : p === false ? <X className="size-3.5 text-destructive" />
        : <Minus className="size-3 text-muted-foreground/50" />

  return (
    <div className="flex h-full flex-col overflow-y-auto p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">simulation · physics</span>
        <button type="button" onClick={run} disabled={!spec || state === 'loading'}
          className="ml-auto flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {state === 'loading' ? <Loader2 className="size-3 animate-spin" /> : <Gauge className="size-3" />}
          {res ? 'Re-run' : 'Run simulations'}
        </button>
      </div>

      {!spec && <p className="text-sm text-muted-foreground">Describe a product first.</p>}
      {state === 'idle' && spec && (
        <p className="text-sm text-muted-foreground">
          Run real physics simulations on the current design — thermal and drop are genuine finite-element solves (scikit-fem); acoustics, RF link and battery are analytic. Each result shows its fidelity and the tool that produced it.
        </p>
      )}
      {state === 'error' && <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{err}</div>}

      {res && state === 'done' && (
        <div className="space-y-2">
          {res.results.map((r) => (
            <div key={r.sim} className="rounded-md border border-border p-2.5">
              {r.error ? (
                <div className="text-[12px] text-muted-foreground"><span className="font-medium capitalize text-foreground">{r.sim}</span> — skipped: {r.error}</div>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <Verdict p={r.pass} />
                    <span className="text-[13px] font-medium capitalize text-foreground">{r.sim}</span>
                    <span className="text-[12px] text-muted-foreground">{r.metric}</span>
                    <span className="ml-auto font-mono text-[13px] text-foreground">{r.value} {r.unit}{r.limit != null ? <span className="text-muted-foreground"> / {r.limit}</span> : null}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 pl-6">
                    <span className={cn('rounded-sm px-1 py-0.5 font-mono text-[9px] uppercase',
                      r.fidelity === 'fem' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                        : r.fidelity === 'surrogate' ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                          : 'bg-secondary text-muted-foreground')}>
                      {r.fidelity === 'fem' ? 'FEM ✓' : r.fidelity}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">{r.tool}</span>
                    {r.note && <span className="text-[10px] text-muted-foreground">· {r.note}</span>}
                  </div>
                </>
              )}
            </div>
          ))}
          <div className="rounded-md border border-border px-3 py-2 text-[11px] text-muted-foreground">
            <span className="text-foreground">Real FEM (scikit-fem)</span> for thermal + drop; analytic/surrogate for acoustics, RF and battery. The next-fidelity upgrade for the analytic domains is 3D FEA/FDTD — <span className="text-foreground">Elmer · CalculiX · openEMS · OpenFOAM</span> (gmsh present for meshing) — install-gated. The runner only reports metrics it can compute, nothing faked.
          </div>
        </div>
      )}
    </div>
  )
}
