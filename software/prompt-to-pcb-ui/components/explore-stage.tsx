'use client'

/**
 * Explore stage — the generic "design-of-N" view. Runs /api/optimize (product
 * engine -> Design Problem -> domain-blind optimizer) and shows the candidate
 * cloud, the Pareto frontier, the selected design, and — honestly — the
 * objectives nothing could score yet. Works for ANY product; nothing here is
 * earbud-specific.
 */
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Loader2, Sparkles, RefreshCw } from 'lucide-react'
import { llmHeaders } from '@/components/llm-settings'
import type { ProductSpec } from '@/lib/product-spec'

type Redesign = {
  converged: boolean
  status: string
  iterations: { iter: number; applied: string[]; resolved: string[]; remaining: string[] }[]
  remaining: string[]
  capabilityGaps: { violation: string; module: string; gap: string }[]
}

type Obj = { name: string; direction: 'min' | 'max'; unit?: string }
type Point = { id: string; values: Record<string, string | number>; scores: Record<string, number>; pareto: boolean; selected: boolean }
type Result = {
  scoredObjectives: Obj[]
  unscoredObjectives: string[]
  totalCombinations: number
  sampledCount: number
  paretoCount: number
  selected: { values: Record<string, string | number>; scores: Record<string, number>; detail: { objective: string; fidelity: string; confidence: number }[] } | null
  points: Point[]
}

function Scatter({ points, xObj, yObj }: { points: Point[]; xObj: Obj; yObj: Obj }) {
  const W = 460
  const H = 320
  const pad = 44
  const xs = points.map((p) => p.scores[xObj.name]).filter((v) => v != null)
  const ys = points.map((p) => p.scores[yObj.name]).filter((v) => v != null)
  const xlo = Math.min(...xs), xhi = Math.max(...xs)
  const ylo = Math.min(...ys), yhi = Math.max(...ys)
  const sx = (v: number) => pad + ((v - xlo) / (xhi - xlo || 1)) * (W - pad * 2)
  const sy = (v: number) => H - pad - ((v - ylo) / (yhi - ylo || 1)) * (H - pad * 2)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-xl" style={{ maxHeight: '46vh' }}>
      {/* axes */}
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} className="stroke-border" strokeWidth={1} />
      <line x1={pad} y1={pad} x2={pad} y2={H - pad} className="stroke-border" strokeWidth={1} />
      <text x={W / 2} y={H - 8} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 11 }}>
        {xObj.name} {xObj.direction === 'min' ? '↓ better' : '↑ better'}
      </text>
      <text x={12} y={H / 2} textAnchor="middle" transform={`rotate(-90 12 ${H / 2})`} className="fill-muted-foreground" style={{ fontSize: 11 }}>
        {yObj.name} {yObj.direction === 'min' ? '↓ better' : '↑ better'}
      </text>
      {/* all candidates */}
      {points.map((p) =>
        p.scores[xObj.name] == null || p.scores[yObj.name] == null ? null : (
          <circle
            key={p.id}
            cx={sx(p.scores[xObj.name])}
            cy={sy(p.scores[yObj.name])}
            r={p.selected ? 6 : p.pareto ? 4 : 2.5}
            className={cn(
              p.selected ? 'fill-emerald-500 stroke-emerald-300' : p.pareto ? 'fill-primary' : 'fill-muted-foreground/30',
            )}
            strokeWidth={p.selected ? 2 : 0}
          />
        ),
      )}
    </svg>
  )
}

export function ExploreStage({ spec, request, runId }: { spec: ProductSpec | null; request?: string; runId?: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [res, setRes] = useState<Result | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [rd, setRd] = useState<Redesign | null>(null)
  const [rdState, setRdState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')

  async function runRedesign() {
    if (!spec) return
    setRdState('loading')
    try {
      const r = await fetch('/api/redesign', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ spec, runId }),
      })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      setRd(d as Redesign); setRdState('done')
    } catch { setRdState('error') }
  }

  async function run() {
    if (!spec) return
    setState('loading'); setErr(null)
    try {
      const r = await fetch('/api/optimize', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ spec, request }),
      })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      setRes(d as Result); setState('done')
    } catch (e) { setErr(String(e)); setState('error') }
  }

  const scored = res?.scoredObjectives ?? []
  const xObj = scored[0]
  const yObj = scored[1] ?? scored[0]

  return (
    <div className="flex h-full flex-col overflow-y-auto p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">explore · design-of-N</span>
        <button type="button" onClick={run} disabled={!spec || state === 'loading'}
          className="ml-auto flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {state === 'loading' ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
          {res ? 'Re-run exploration' : 'Run exploration'}
        </button>
      </div>

      {!spec && <p className="text-sm text-muted-foreground">No product spec yet — describe a product on the left first.</p>}
      {state === 'idle' && spec && (
        <p className="text-sm text-muted-foreground">
          Generate many candidate designs, score them on the objectives we can evaluate, and pick the best off the Pareto frontier. Un-modeled objectives are flagged honestly.
        </p>
      )}
      {state === 'error' && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{err}</div>}

      {res && state === 'done' && (
        <div className="space-y-4">
          <div className="font-mono text-[11px] text-muted-foreground">
            {res.sampledCount} of {res.totalCombinations.toLocaleString()} candidates · {res.paretoCount} on the Pareto frontier
          </div>

          {xObj && yObj ? (
            <Scatter points={res.points} xObj={xObj} yObj={yObj} />
          ) : (
            <div className="text-sm text-muted-foreground">No scorable objectives — add evaluators to plot a frontier.</div>
          )}

          {res.selected && (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/[0.06] p-3">
              <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold text-foreground">
                <span className="size-2.5 rounded-full bg-emerald-500" /> selected design
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                {Object.entries(res.selected.values).map(([k, v]) => `${k}=${v}`).join(' · ')}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {res.selected.detail.map((d) => (
                  <span key={d.objective} className="rounded-sm border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                    {d.objective} = {res.selected!.scores[d.objective]} <span className="text-muted-foreground">({d.fidelity})</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {res.unscoredObjectives.length > 0 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-400">
              Not yet scored (no evaluator): {res.unscoredObjectives.join(', ')}. These objectives are carried honestly, not estimated — they light up when their evaluator plugin is added.
            </div>
          )}
        </div>
      )}

      {/* redesign loop — feedback controller */}
      {spec && (
        <div className="mt-5 border-t border-border pt-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">redesign loop · feedback</span>
            <button type="button" onClick={runRedesign} disabled={rdState === 'loading'}
              className="ml-auto flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] text-foreground hover:bg-secondary/50 disabled:opacity-50">
              {rdState === 'loading' ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              Run redesign loop
            </button>
          </div>
          {rdState === 'idle' && <p className="text-[12px] text-muted-foreground">Gather violations (fit + sim FAILs), attempt fixes, and converge — or honestly report the capability gaps that block convergence.</p>}
          {rdState === 'error' && <p className="text-[12px] text-destructive">Redesign loop failed.</p>}
          {rd && rdState === 'done' && (
            <div className="space-y-2">
              <div className={cn('inline-block rounded-sm px-2 py-0.5 font-mono text-[10px] uppercase',
                rd.converged ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-destructive/15 text-destructive')}>
                {rd.status}
              </div>
              {rd.iterations.map((it) => (
                <div key={it.iter} className="rounded-md border border-border p-2 text-[11px]">
                  <div className="font-mono text-[9px] uppercase text-muted-foreground">iteration {it.iter}</div>
                  {it.applied.length > 0 && <div className="text-emerald-600 dark:text-emerald-400">applied: {it.applied.join(' · ')}</div>}
                  {it.resolved.length > 0 && <div className="text-muted-foreground">resolved: {it.resolved.join(', ')}</div>}
                  {it.remaining.length > 0 && <div className="text-amber-600 dark:text-amber-400">still open: {it.remaining.join(' · ')}</div>}
                </div>
              ))}
              {rd.capabilityGaps.length > 0 && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
                  <div className="font-semibold">Blocked by capability gaps (honest):</div>
                  {rd.capabilityGaps.map((g, i) => (
                    <div key={i} className="mt-0.5">· <span className="font-mono">{g.module}</span>: {g.gap}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
