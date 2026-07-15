'use client'

/**
 * Chip-scale electronics stage — the tscircuit-backed board module. The product
 * engine emits a code-defined board; tscircuit autoroutes it in-process and this
 * shows the real routed board (SVG), its true size, and how much smaller it is
 * than the standard flroute pipeline. Its dimensions flow into the mechanical
 * fit-check + redesign loop. Honest: only "routed" with traces AND zero errors.
 */
import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { Loader2, CircuitBoard } from 'lucide-react'
import { llmHeaders } from '@/components/llm-settings'
import { BoardSchematic } from '@/components/board-schematic'
import { Board3D } from '@/components/board-3d'

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
    groundPlane?: { assigned: number; unconnected: number | null; stitched?: number; skipped?: number; errors: number | null } | null
    fixes: string[]
    verdict: string | null
    designConvergence?: {
      triggered: boolean
      replans: number
      converged: boolean
      change: string
      note?: string | null
      droppedCapabilities?: string[]
      before: { parts: number; drc: number | null }
      after: { parts: number; drc: number | null }
    } | null
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
  // the built board is a tabbed workspace: start on the 3D PCBA, tab to the 2D
  // routed layout, the schematic, or the build report (DRC + redesign loop).
  const [view, setView] = useState<'pcba' | 'layout' | 'schematic' | 'report'>('pcba')

  // Load the already-built chip-scale board on mount (persisted by /api/electronics-cs
  // as chipscale-board.json) so the stage shows the real board when the full-pipeline
  // orchestrator built it via the API — before, the stage only reflected a board when
  // ITS OWN button was clicked, so after an auto-run this view sat empty.
  useEffect(() => {
    if (!runId) return
    let off = false
    fetch(`/runs/${runId}/electronics/chipscale-board.json`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (off || !d?.boardMm?.w) return
        setRes({
          ok: (d.drc?.errors ?? 1) === 0,
          boardMm: d.boardMm, areaMm2: d.areaMm2, components: d.components,
          routedTraces: d.routedTraces, realFootprints: d.realFootprints,
          drc: d.drc ?? null, drcRepair: d.drcRepair ?? null,
          svgUrl: `/runs/${runId}/electronics/chipscale.svg?t=${runId}`,
        })
        setState('done')
      })
      .catch(() => {})
    return () => { off = true }
  }, [runId])

  async function run(opts?: { keepCapabilities?: boolean }) {
    if (!spec || !runId) return
    setState('loading'); setErr(null)
    try {
      const r = await fetch('/api/electronics-cs', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ spec, runId, keepCapabilities: opts?.keepCapabilities === true }),
      })
      const d = await r.json()
      if (d.error && !d.boardMm) throw new Error(d.error)
      setRes(d); setState('done')
    } catch (e) { setErr(String(e)); setState('error') }
  }

  const errCount = res?.errors ? Object.values(res.errors).reduce((a, b) => a + b, 0) : 0
  const canRun = !!spec && !!runId

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">{asElectronics ? 'electronics · bespoke chip-down board' : 'chip-scale electronics · tscircuit'}</span>
        {res && state === 'done' && (
          <div className="flex overflow-hidden rounded-sm border border-border">
            {(([['pcba', 'PCBA'], ['layout', 'Layout'], ['schematic', 'Schematic'], ['report', 'Report']]) as const).map(([v, label]) => (
              <button key={v} type="button" onClick={() => setView(v)}
                className={cn('px-2.5 py-0.5 text-[11px]',
                  view === v ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {label}
              </button>
            ))}
          </div>
        )}
        <button type="button" onClick={() => run()} disabled={!canRun || state === 'loading'}
          className="ml-auto flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {state === 'loading' ? <Loader2 className="size-3 animate-spin" /> : <CircuitBoard className="size-3" />}
          {res ? 'Regenerate' : asElectronics ? 'Design the electronics' : 'Generate chip-scale board'}
        </button>
      </div>

      {!canRun && <div className="p-5"><p className="text-sm text-muted-foreground">Describe a product on the left first — then the electronics are synthesized as a real bare-chip board.</p></div>}
      {state === 'idle' && canRun && (
        <div className="p-5"><p className="text-sm text-muted-foreground">
          The product engine emits a code-defined board; <span className="text-foreground">tscircuit</span> autoroutes it in-process into an earbud-scale board. Its real size flows into the fit-check + redesign loop.
        </p></div>
      )}
      {state === 'loading' && <div className="p-5"><p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> emitting + autorouting the board…</p></div>}
      {state === 'error' && <div className="p-5"><div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{err}</div></div>}

      {res && state === 'done' && (
        <div className="min-h-0 flex-1">
          {/* PCBA — the real populated chip-scale board in 3D (/api/board3d resolves
              this run's chipscale.kicad_pcb with 3D component models attached) */}
          {view === 'pcba' && (
            <div className="h-full w-full bg-[#0a0a0a]">
              <Board3D basePath={`/runs/${runId}/board`}
                fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">rendering the PCBA…</div>} />
            </div>
          )}
          {/* Layout — the 2D routed board (copper) */}
          {view === 'layout' && (
            <div className="flex h-full items-center justify-center overflow-auto bg-[#0f0f0f] p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={res.svgUrl ?? ''} alt="chip-scale PCB layout" className="max-h-full w-auto" />
            </div>
          )}
          {/* Schematic — the generated chip-scale schematic */}
          {view === 'schematic' && (
            /* netlist-driven schematic with per-block sub-sheets (tabs) and
               pan/zoom — the flat tscircuit SVG had neither. */
            <div className="h-full">
              <BoardSchematic runDir={runId ? `/runs/${runId}` : null} />
            </div>
          )}
          {/* Report — routing verdict, real KiCad DRC, redesign loop */}
          {view === 'report' && (
          <div className="h-full space-y-3 overflow-y-auto p-5">
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
                    {res.drcRepair.groundPlane && (
                      <div className="mt-0.5">
                        <span className="font-medium">Ground plane (pcbnew):</span>{' '}
                        {res.drcRepair.groundPlane.assigned} pins bonded to a real GND zone
                        {res.drcRepair.groundPlane.stitched
                          ? `, ${res.drcRepair.groundPlane.stitched} via tented via-in-pad`
                          : ''}
                        {res.drcRepair.groundPlane.unconnected
                          ? `, ${res.drcRepair.groundPlane.unconnected} not reached${res.drcRepair.groundPlane.skipped ? ` (${res.drcRepair.groundPlane.skipped} via-in-pad skipped to hold hole_clearance)` : ''}`
                          : ' — every ground pin on the plane ✓'}
                        {res.drcRepair.groundPlane.errors ? `, ${res.drcRepair.groundPlane.errors} zone DRC error(s)` : ''}
                      </div>
                    )}
                    {Array.isArray(res.drcRepair.fixes) && res.drcRepair.fixes.length > 0 && (
                      <div className="mt-0.5 opacity-80">fixes: {res.drcRepair.fixes.join('; ')}</div>
                    )}
                    {res.drcRepair.verdict && !res.drcRepair.converged && (
                      <div className="mt-0.5 opacity-90">{res.drcRepair.verdict}</div>
                    )}
                  </div>
                )}
                {(res.drcRepair?.designConvergence?.droppedCapabilities?.length ?? 0) > 0 && (
                  <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px]">
                    <div className="font-medium text-amber-600 dark:text-amber-400">⚠ Capability dropped to fit at this size</div>
                    <div className="mt-0.5 opacity-90">
                      To route clean at the current size budget, the design re-plan removed:{' '}
                      <span className="font-medium">{res.drcRepair!.designConvergence!.droppedCapabilities!.join(', ')}</span>.
                      {' '}You can keep it on a larger board instead.
                    </div>
                    <button
                      onClick={() => run({ keepCapabilities: true })}
                      disabled={!canRun}
                      className="mt-1.5 rounded border border-amber-500/50 px-2 py-1 text-[11px] font-medium hover:bg-amber-500/20 disabled:opacity-50"
                    >
                      Rebuild keeping it (larger board) →
                    </button>
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
          {res.errors && errCount > 0 && (
            <div className="text-[11px] text-amber-600 dark:text-amber-400">issues: {Object.entries(res.errors).map(([k, v]) => `${k}×${v}`).join(', ')} (reported, not hidden)</div>
          )}
          {res.code && (
            <button type="button" onClick={() => setShowCode((s) => !s)}
              className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">
              {showCode ? 'Hide code' : 'Show code'}
            </button>
          )}
          {showCode && (
            <pre className="max-h-[40vh] overflow-auto rounded-md border border-border bg-secondary/30 p-2 font-mono text-[10px] text-muted-foreground">{res.code}</pre>
          )}
          </div>
          )}
        </div>
      )}
    </div>
  )
}
