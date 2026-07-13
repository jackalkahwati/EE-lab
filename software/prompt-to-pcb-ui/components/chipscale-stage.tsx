'use client'

/**
 * Chip-scale electronics stage — the tscircuit-backed board module. The product
 * engine emits a code-defined board; tscircuit autoroutes it in-process and this
 * shows the real routed board (SVG), its true size, and how much smaller it is
 * than the standard flroute pipeline. Its dimensions flow into the mechanical
 * fit-check + redesign loop. Honest: only "routed" with traces AND zero errors.
 */
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Loader2, CircuitBoard } from 'lucide-react'
import { llmHeaders } from '@/components/llm-settings'

type Result = {
  ok: boolean
  boardMm?: { w: number; h: number } | null
  areaMm2?: number | null
  components?: number
  routedTraces?: number
  realFootprints?: number
  drc?: {
    available: boolean
    reason?: string
    kicadVersion?: string
    ruleProfile?: string
    errors?: number
    warnings?: number
    errorTypes?: Record<string, number>
    sample?: string[]
  } | null
  drcRepair?: {
    converged: boolean
    iterations: { iter: number; strategy: string; profile: string; errors: number; unrouted?: number }[]
    winningStrategy: string
    errorsFirst: number
    errorsBest: number
    unrouted?: number
    fixes: string[]
    verdict: string | null
  } | null
  errors?: Record<string, number>
  svgUrl?: string | null
  code?: string
  error?: string
}

export function ChipScaleStage({ spec, runId, asElectronics }: { spec: any; runId?: string; asElectronics?: boolean }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [res, setRes] = useState<Result | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [showCode, setShowCode] = useState(false)

  async function run() {
    if (!spec || !runId) return
    setState('loading'); setErr(null)
    try {
      const r = await fetch('/api/electronics-cs', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ spec, runId }),
      })
      const d = await r.json()
      if (d.error && !d.boardMm) throw new Error(d.error)
      setRes(d); setState('done')
    } catch (e) { setErr(String(e)); setState('error') }
  }

  const errCount = res?.errors ? Object.values(res.errors).reduce((a, b) => a + b, 0) : 0
  const canRun = !!spec && !!runId

  return (
    <div className="flex h-full flex-col overflow-y-auto p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">{asElectronics ? 'electronics · bespoke chip-down board' : 'chip-scale electronics · tscircuit'}</span>
        {res?.code && (
          <button type="button" onClick={() => setShowCode((s) => !s)}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">
            {showCode ? 'Hide code' : 'Show code'}
          </button>
        )}
        <button type="button" onClick={run} disabled={!canRun || state === 'loading'}
          className="ml-auto flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {state === 'loading' ? <Loader2 className="size-3 animate-spin" /> : <CircuitBoard className="size-3" />}
          {res ? 'Regenerate' : asElectronics ? 'Design the electronics' : 'Generate chip-scale board'}
        </button>
      </div>

      {!canRun && <p className="text-sm text-muted-foreground">Describe a product on the left first — then the electronics are synthesized as a real bare-chip board.</p>}
      {state === 'idle' && canRun && (
        <p className="text-sm text-muted-foreground">
          The product engine emits a code-defined board; <span className="text-foreground">tscircuit</span> autoroutes it in-process into an earbud-scale board. Its real size flows into the fit-check + redesign loop.
        </p>
      )}
      {state === 'loading' && <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> emitting + autorouting the board…</p>}
      {state === 'error' && <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{err}</div>}

      {res && state === 'done' && (
        <div className="space-y-3">
          <div className={cn('rounded-md border px-3 py-2 text-[13px]',
            res.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400')}>
            {res.ok ? '✓ routed clean' : `routed with ${errCount} placement/DRC issue(s)`} —
            <span className="font-mono"> {res.boardMm?.w}×{res.boardMm?.h}mm ({res.areaMm2}mm²)</span>,
            {' '}{res.components} components, {res.routedTraces} traces
          </div>
          <div className="rounded-md border border-border p-2 text-[11px] text-muted-foreground">
            vs the standard flroute pipeline (~153×112mm ≈ 17,100mm²): <span className="text-foreground">~{res.areaMm2 ? Math.round(17100 / res.areaMm2) : '?'}× smaller area</span>. Chip-scale (tscircuit, MIT, in-process).{' '}
            {res.realFootprints
              ? <span className="text-emerald-600 dark:text-emerald-400">{res.realFootprints} part{res.realFootprints > 1 ? 's' : ''} on REAL LCSC footprints (easyeda2kicad); the rest generic.</span>
              : <span>Generic footprints — no LCSC parts resolved this run.</span>}
          </div>

          {res.drc && (
            res.drc.available ? (
              <div className={cn('rounded-md border px-3 py-2 text-[12px]',
                res.drc.errors === 0 ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400')}>
                <div className="font-medium">
                  Real KiCad DRC ({res.drc.kicadVersion}) · {res.drc.ruleProfile}: {' '}
                  {res.drc.errors === 0 ? '✓ 0 errors' : `${res.drc.errors} error${res.drc.errors === 1 ? '' : 's'}`}
                  {res.drc.warnings ? `, ${res.drc.warnings} warning${res.drc.warnings === 1 ? '' : 's'}` : ''}
                </div>
                {!!res.drc.errorTypes && Object.keys(res.drc.errorTypes).length > 0 && (
                  <div className="mt-1 text-[11px]">{Object.entries(res.drc.errorTypes).map(([k, v]) => `${k}×${v}`).join(' · ')}</div>
                )}
                {!!res.drc.sample?.length && (
                  <ul className="mt-1 list-disc pl-4 text-[11px] opacity-90">
                    {res.drc.sample.slice(0, 3).map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                )}
                {res.drcRepair && Array.isArray(res.drcRepair.iterations) && res.drcRepair.iterations.length > 0 && (
                  <div className="mt-1.5 border-t border-current/20 pt-1.5 text-[11px]">
                    <span className="font-medium">Redesign loop{res.drcRepair.converged ? ' ✓ converged' : ''}:</span>{' '}
                    {res.drcRepair.iterations.map((it) => `${it.errors}`).join(' → ')} errors across {res.drcRepair.iterations.length} strateg{res.drcRepair.iterations.length === 1 ? 'y' : 'ies'}
                    {res.drcRepair.converged
                      ? ` — clean via "${res.drcRepair.winningStrategy}".`
                      : ` — best "${res.drcRepair.winningStrategy}"${res.drcRepair.unrouted ? `, ${res.drcRepair.unrouted} net(s) unrouted` : ''}.`}
                    {Array.isArray(res.drcRepair.fixes) && res.drcRepair.fixes.length > 0 && (
                      <div className="mt-0.5 opacity-80">fixes: {res.drcRepair.fixes.join('; ')}</div>
                    )}
                    {res.drcRepair.verdict && !res.drcRepair.converged && (
                      <div className="mt-0.5 opacity-90">{res.drcRepair.verdict}</div>
                    )}
                  </div>
                )}
                <div className="mt-1 text-[10px] opacity-70">Same design-rule check a fab runs — not tscircuit&apos;s own router check.</div>
              </div>
            ) : (
              <div className="rounded-md border border-border px-3 py-2 text-[11px] text-muted-foreground">
                Real KiCad DRC unavailable ({res.drc.reason}) — showing tscircuit&apos;s router check only.
              </div>
            )
          )}
          {res.svgUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={res.svgUrl} alt="chip-scale PCB" className="mx-auto max-h-[46vh] w-auto rounded-md border border-border bg-white p-2" />
          )}
          {res.errors && errCount > 0 && (
            <div className="text-[11px] text-amber-600 dark:text-amber-400">issues: {Object.entries(res.errors).map(([k, v]) => `${k}×${v}`).join(', ')} (reported, not hidden)</div>
          )}
          {showCode && (
            <pre className="max-h-[40vh] overflow-auto rounded-md border border-border bg-secondary/30 p-2 font-mono text-[10px] text-muted-foreground">{res.code}</pre>
          )}
        </div>
      )}
    </div>
  )
}
