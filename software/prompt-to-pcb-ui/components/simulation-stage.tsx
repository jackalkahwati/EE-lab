'use client'

/**
 * Simulation stage — runs the physics sims and shows each result with its metric,
 * pass/fail, fidelity, and the tool that produced it. thermal + drop are REAL FEM
 * (scikit-fem); acoustics/RF/battery are analytic/surrogate, honestly labeled; the
 * high-fidelity solvers for those (Elmer/CalculiX/openEMS/OpenFOAM) are the
 * install-gated upgrade. Generic — the runner picks whichever sims the inputs support.
 */
import { useState, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { Loader2, Gauge, Check, X, Minus } from 'lucide-react'

type SimResult = {
  sim: string; physics?: string; metric?: string; value?: number; unit?: string
  limit?: number | null; pass?: boolean | null; fidelity?: string; tool?: string
  detail?: Record<string, unknown>; note?: string; error?: string
}
type SimAssessment = { kind: string; applicability: string; verdict: string; requirement?: string; detail: string }
type Result = {
  scipy: boolean; results: SimResult[]; solvers?: Record<string, string | null>
  plan?: { environment?: { class?: string; ambientC?: number; vibration?: boolean; sealed?: boolean } }
  assessment?: {
    assessments?: SimAssessment[]; gaps?: string[]
    summary?: { required: number; passed: number; tight: number; failed: number; gaps: number }
  }
}

function validResult(d: any): d is Result {
  if (!d || !Array.isArray(d.results) || !d.results.every((r: any) => r && typeof r.sim === 'string'
    && ['physics', 'metric', 'unit', 'fidelity', 'tool', 'note', 'error'].every(key => r[key] === undefined || typeof r[key] === 'string')
    && ['value', 'limit'].every(key => r[key] == null || (typeof r[key] === 'number' && Number.isFinite(r[key])))
    && (r.pass == null || typeof r.pass === 'boolean'))) return false
  if (d.assessment?.assessments !== undefined && (!Array.isArray(d.assessment.assessments)
    || !d.assessment.assessments.every((a: any) => a && ['kind', 'applicability', 'verdict', 'detail'].every(key => typeof a[key] === 'string')))) return false
  if (d.assessment?.gaps !== undefined && (!Array.isArray(d.assessment.gaps)
    || !d.assessment.gaps.every((gap: unknown) => typeof gap === 'string'))) return false
  return true
}

type Props = { spec: any; runId?: string; onBuilt?: () => void; generationDisabled?: boolean
  onBuildStart?: () => boolean | void | Promise<boolean | void>
  onBuildSettled?: (result: { status: 'passed' | 'failed' | 'unknown'; detail?: string; artifactAvailable?: boolean }) => void | Promise<void>
}

export function SimulationStage(props: Props) {
  return <SimulationArtifactView key={props.runId ?? 'draft'} {...props} />
}

function SimulationArtifactView({ spec, runId, onBuilt, onBuildStart, onBuildSettled, generationDisabled }: Props) {
  const [state, setState] = useState<'idle' | 'loading' | 'generating' | 'missing' | 'done' | 'error'>(runId ? 'loading' : 'idle')
  const [res, setRes] = useState<Result | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [operation, setOperation] = useState<'read' | 'generate'>('read')
  const request = useRef({ version: 0, generating: false })
  const readController = useRef<AbortController | null>(null)

  useEffect(() => {
    const scope = request.current
    const token = ++scope.version
    const controller = new AbortController()
    readController.current = controller
    setRes(null); setErr(null); setOperation('read')
    setState(runId ? 'loading' : 'idle')
    if (runId) fetch(`/runs/${runId}/disciplines/simulation.json`, { cache: 'no-store', signal: controller.signal })
      .then(async r => {
        if (r.status === 404) return null
        if (!r.ok) throw new Error(`Could not load simulation (${r.status}).`)
        const d = await r.json()
        if (!validResult(d)) throw new Error('The saved simulation artifact is invalid.')
        return d
      })
      .then(d => {
        if (scope.version !== token || controller.signal.aborted) return
        setRes(d); setState(d ? 'done' : 'missing')
      })
      .catch(e => {
        if (scope.version !== token || controller.signal.aborted) return
        setErr(String(e)); setState('error')
      })
    return () => { ++scope.version; controller.abort() }
  }, [runId, retry])

  async function run() {
    if (!spec || !runId || generationDisabled || request.current.generating) return
    const scope = request.current
    const token = ++scope.version
    scope.generating = true
    const start = onBuildStart
    const settled = onBuildSettled
    let submitted = false
    let outcome: Parameters<NonNullable<Props['onBuildSettled']>>[0] = { status: 'unknown', detail: 'Simulation request outcome unknown. Server work may continue.' }
    readController.current?.abort()
    setState('generating'); setErr(null); setOperation('generate')
    try {
      const permission = start?.()
      const allowed = permission && typeof (permission as Promise<unknown>).then === 'function' ? await permission : permission
      if (allowed === false || !(scope.version === token)) {
        outcome = { status: 'unknown', detail: 'Generation was not submitted.' }
        if (scope.version === token) { setErr('Generation was not started. Another action or history persistence prevented it.'); setState('error') }
        return
      }
      submitted = true
      const r = await fetch('/api/simulate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec, runId }),
      })
      const d = await r.json()
      if (d?.error) outcome = { status: 'failed', detail: String(d.error) }
      if (!r.ok || d?.error) throw new Error(d?.error || `Simulation failed (${r.status}).`)
      if (!validResult(d)) throw new Error('The generated simulation artifact is invalid.')
      const assessments = d.assessment?.assessments?.filter(a => a.applicability !== 'not_applicable') ?? []
      const failed = d.results.some(result => result.pass === false) || assessments.some(a => a.verdict === 'fail')
      const passed = d.results.length > 0 && d.results.every(result => result.pass === true && !result.error)
        && assessments.every(a => a.verdict === 'pass') && !d.assessment?.gaps?.length
      outcome = { status: failed ? 'failed' : passed ? 'passed' : 'unknown', detail: 'Simulation results returned; review fidelity and any unreported or skipped checks.', artifactAvailable: true }
      if (scope.version !== token) return
      setRes(d); setState('done'); onBuilt?.()
    } catch (e) {
      if (scope.version !== token) return
      setErr(String(e)); setState('error')
    } finally {
      if (!submitted) outcome = { status: 'unknown', detail: 'Generation was not submitted.' }
      try { await settled?.(outcome) } catch (e) {
        if (scope.version === token) { setErr(`Could not record generation outcome: ${String(e)}`); setState('error') }
      } finally { scope.generating = false }
    }
  }

  const Verdict = ({ p }: { p?: boolean | null }) =>
    p === true ? <Check className="size-3.5 text-emerald-500" />
      : p === false ? <X className="size-3.5 text-destructive" />
        : <Minus className="size-3 text-muted-foreground/50" />

  return (
    <div className="flex h-full flex-col overflow-y-auto p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">simulation · physics</span>
        <button type="button" onClick={run} disabled={!spec || !runId || generationDisabled || state === 'generating'}
          className="ml-auto flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {state === 'generating' ? <Loader2 className="size-3 animate-spin" /> : <Gauge className="size-3" />}
          {state === 'generating' ? 'Running…' : state === 'error' && operation === 'generate' ? 'Retry simulation' : res ? 'Re-run' : 'Run simulations'}
        </button>
      </div>

      {!spec && <p className="text-sm text-muted-foreground">Describe a product first.</p>}
      {state === 'idle' && spec && (
        <p className="text-sm text-muted-foreground">
          Run real physics simulations on the current design — thermal and drop are finite-element solves (scikit-fem), and the board + real enclosure CAD get TRUE 3D FEA (gmsh mesh, CalculiX modal solve). Acoustics, RF link and battery are analytic. Each result shows its fidelity and the tool that produced it.
        </p>
      )}
      {state === 'loading' && <p role="status" className="text-sm text-muted-foreground">Loading saved simulation…</p>}
      {state === 'generating' && <p role="status" className="text-sm text-muted-foreground">Running simulations…</p>}
      {state === 'missing' && <p role="status" className="text-sm text-muted-foreground">No saved simulation for this run.</p>}
      {(state === 'missing' || (state === 'error' && operation === 'read')) && <button type="button" onClick={() => setRetry(n => n + 1)} className="my-2 self-start rounded-md border border-border px-3 py-1 text-xs">Retry loading simulation</button>}
      {state === 'error' && <div role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{err}</div>}

      {res && state === 'done' && res.assessment && (res.assessment.assessments?.length || res.assessment.gaps?.length) ? (
        <div className="mb-3 rounded-md border border-border bg-secondary/30 p-2.5">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-foreground">Application requirements</span>
            {res.plan?.environment && (
              <span className="font-mono text-[10px] text-muted-foreground">
                {res.plan.environment.class} · {res.plan.environment.ambientC}°C ambient
                {res.plan.environment.vibration ? ' · vibration' : ''}{res.plan.environment.sealed ? ' · sealed' : ''}
              </span>
            )}
            {res.assessment.summary && (
              <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                {res.assessment.summary.required} required · {res.assessment.summary.passed} pass · {res.assessment.summary.failed} fail
                {res.assessment.summary.gaps ? ` · ${res.assessment.summary.gaps} gap` : ''}
              </span>
            )}
          </div>
          <div className="space-y-1">
            {res.assessment.assessments
              ?.filter((a) => a.applicability !== 'not_applicable')
              .map((a) => (
                <div key={a.kind} className="flex items-start gap-2 text-[11px]">
                  <span className={cn('mt-0.5 rounded-sm px-1 py-0.5 font-mono text-[8px] uppercase',
                    a.verdict === 'pass' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                      : a.verdict === 'tight' ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                        : a.verdict === 'fail' ? 'bg-destructive/15 text-destructive'
                          : a.verdict === 'no_data' ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                            : 'bg-secondary text-muted-foreground')}>
                    {a.verdict === 'no_data' ? 'gap' : a.verdict.replace('_', ' ')}
                  </span>
                  <span className="min-w-0">
                    <span className="font-medium capitalize text-foreground">{a.kind.replace('_', ' ')}</span>
                    <span className="text-muted-foreground/70"> ({a.applicability})</span>
                    <span className="text-muted-foreground"> — {a.detail}</span>
                  </span>
                </div>
              ))}
          </div>
          {res.assessment.gaps?.length ? (
            <div className="mt-1.5 text-[10px] text-amber-600 dark:text-amber-400">
              <p>{res.assessment.gaps.length} required check(s) could not run — verify inputs, don&apos;t assume pass.</p>
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {res.assessment.gaps.map((gap, index) => <li key={index}>{gap}</li>)}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {res && state === 'done' && (
        <div className="space-y-2">
          {res.results.length === 0 && <p role="status" className="text-sm text-muted-foreground">No simulation results are available. This is not a passing result.</p>}
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
                      ['fem', 'fem3d', 'spice', 'cfd', 'fem-acoustic', 'fdtd'].includes(r.fidelity ?? '') ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                        : r.fidelity === 'surrogate' || r.fidelity === 'gated' ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                          : 'bg-secondary text-muted-foreground')}>
                      {r.fidelity === 'fem' ? 'FEM ✓' : r.fidelity === 'fem3d' ? '3D FEA ✓'
                        : r.fidelity === 'spice' ? 'SPICE ✓' : r.fidelity === 'cfd' ? 'CFD ✓'
                          : r.fidelity === 'fem-acoustic' ? 'ACOUSTIC FEM ✓' : r.fidelity === 'fdtd' ? 'FDTD ✓'
                            : r.fidelity === 'gated' ? 'install-gated' : r.fidelity}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">{r.tool}</span>
                    {r.note && <span className="text-[10px] text-muted-foreground">· {r.note}</span>}
                  </div>
                </>
              )}
            </div>
          ))}
          <div className="rounded-md border border-border px-3 py-2 text-[11px] text-muted-foreground">
            <span className="text-foreground">Real FEM (scikit-fem)</span> for thermal + drop; <span className="text-foreground">real 3D FEA (gmsh + CalculiX)</span> for the board and the actual enclosure STEP; <span className="text-foreground">real SPICE (ngspice)</span> for the rail decoupling network; <span className="text-foreground">real CFD (OpenFOAM)</span> for natural convection; <span className="text-foreground">real acoustic FEM (Elmer)</span> for the cavity. Analytic/surrogate where a solver isn&apos;t wired (RF link budget, battery) — the runner only reports metrics it can compute, nothing faked.
            {res.solvers && (
              <span className="mt-1 block font-mono text-[10px]">
                solvers: {['gmsh', 'calculix', 'ngspice', 'openfoam', 'elmer', 'openems'].map((k) => `${k} ${res.solvers?.[k] ? '✓' : '—'}`).join(' · ')}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
