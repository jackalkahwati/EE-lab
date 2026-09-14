'use client'

/**
 * Chip-scale electronics stage — the tscircuit-backed board module. The product
 * engine emits a code-defined board; tscircuit autoroutes it in-process and this
 * shows the real routed board (SVG), its true size, and how much smaller it is
 * than the standard flroute pipeline. Its dimensions flow into the mechanical
 * fit-check + redesign loop. Honest: only "routed" with traces AND zero errors.
 */
import { useState, useEffect, useRef } from 'react'
import { boardVerdict } from '@/lib/verdict'
import { cn } from '@/lib/utils'
import { Loader2, CircuitBoard } from 'lucide-react'
import { llmHeaders } from '@/components/llm-settings'
import { BoardSchematic } from '@/components/board-schematic'
import { Board3D } from '@/components/board-3d'

type Result = {
  ok: boolean
  imported?: boolean
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

function importedBoard(d: any): boolean {
  return d?.imported === true && d.boardSource === 'manual-import' && d.manualImport?.kind === 'pcb'
}

function validBoard(d: any): d is Result {
  return d && Number.isFinite(d.boardMm?.w) && d.boardMm.w > 0
    && Number.isFinite(d.boardMm?.h) && d.boardMm.h > 0
}

type Props = {
  spec: any; runId?: string; asElectronics?: boolean; generationDisabled?: boolean
  onBuildStart?: () => boolean | void | Promise<boolean | void>
  onBuildSettled?: (result: { status: 'passed' | 'failed' | 'unknown'; detail?: string; artifactAvailable?: boolean }) => void | Promise<void>
  /** Invalidates persisted facts after an explicit attempt settles, even on error. */
  onBuilt?: () => void
}

export function ChipScaleStage(props: Props) {
  return <ChipScaleArtifactView key={props.runId ?? 'draft'} {...props} />
}

function ChipScaleArtifactView({ spec, runId, asElectronics, generationDisabled, onBuildStart, onBuildSettled, onBuilt }: Props) {
  const [state, setState] = useState<'idle' | 'loading' | 'generating' | 'missing' | 'done' | 'error'>(runId ? 'loading' : 'idle')
  const [res, setRes] = useState<Result | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [showCode, setShowCode] = useState(false)
  // the built board is a tabbed workspace: start on the 3D PCBA, tab to the 2D
  // routed layout, the schematic, or the build report (DRC + redesign loop).
  const [view, setView] = useState<'pcba' | 'layout' | 'schematic' | 'report'>('pcba')

  const [retry, setRetry] = useState(0)
  const [operation, setOperation] = useState<'read' | 'generate'>('read')
  const [keepCapabilities, setKeepCapabilities] = useState(false)
  const request = useRef({ version: 0, generating: false })
  const readController = useRef<AbortController | null>(null)

  useEffect(() => {
    const scope = request.current
    const token = ++scope.version
    const controller = new AbortController()
    readController.current = controller
    setRes(null); setErr(null); setOperation('read')
    setState(runId ? 'loading' : 'idle')
    if (runId) {
      fetch(`/runs/${runId}/electronics/chipscale-board.json`, { cache: 'no-store', signal: controller.signal })
        .then(async (r) => {
          if (r.status === 404) return null
          if (!r.ok) throw new Error(`Could not load board (${r.status}).`)
          const d = await r.json()
          if (importedBoard(d)) {
            const mm = d.boardMm
            return { ok: true, imported: true, components: Number.isFinite(d.components) ? d.components : undefined,
              boardMm: Array.isArray(mm) && mm.length === 2 && mm.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0) ? { w: mm[0], h: mm[1] } : null }
          }
          if (!validBoard(d)) throw new Error('The saved board artifact is invalid.')
          return { ...d, svgUrl: `/runs/${runId}/electronics/chipscale.svg?t=${runId}` }
        })
        .then((d) => {
          if (scope.version !== token || controller.signal.aborted) return
          setRes(d); setState(d ? 'done' : 'missing')
        })
        .catch((e) => {
          if (scope.version !== token || controller.signal.aborted) return
          setErr(String(e)); setState('error')
        })
    }
    // Do not cancel paid generation when a panel closes. Ignore its response.
    return () => { ++scope.version; controller.abort() }
  }, [runId, retry])

  async function run(opts?: { keepCapabilities?: boolean }) {
    if (!spec || !runId || generationDisabled || request.current.generating) return
    const scope = request.current
    const token = ++scope.version
    scope.generating = true
    const start = onBuildStart
    const settled = onBuildSettled
    let submitted = false
    let outcome: Parameters<NonNullable<Props['onBuildSettled']>>[0] = { status: 'unknown', detail: 'Board request outcome unknown. Server work may continue.' }
    readController.current?.abort()
    setState('generating'); setErr(null); setOperation('generate')
    setKeepCapabilities(opts?.keepCapabilities === true)
    try {
      const permission = start?.()
      const allowed = permission && typeof (permission as Promise<unknown>).then === 'function' ? await permission : permission
      if (allowed === false || !(scope.version === token)) {
        outcome = { status: 'unknown', detail: 'Generation was not submitted.' }
        if (scope.version === token) { setErr('Generation was not started. Another action or history persistence prevented it.'); setState('error') }
        return
      }
      submitted = true
      const r = await fetch('/api/electronics-cs', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ spec, runId, keepCapabilities: opts?.keepCapabilities === true }),
      })
      const d = await r.json()
      if (d?.error) outcome = { status: 'failed', detail: String(d.error) }
      if (!r.ok || (d.error && !d.boardMm)) throw new Error(d.error || `Generation failed (${r.status}).`)
      if (!validBoard(d)) throw new Error('The generated board artifact is invalid.')
      const verdict = boardVerdict(d)
      outcome = { status: verdict.state === 'passed' ? 'passed' : verdict.state === 'failed' ? 'failed' : 'unknown', detail: verdict.detail, artifactAvailable: true }
      if (scope.version !== token) return
      setRes(d); setState('done')
    } catch (e) {
      if (scope.version !== token) return
      setErr(String(e)); setState('error')
    } finally {
      if (!submitted) outcome = { status: 'unknown', detail: 'Generation was not submitted.' }
      try { await settled?.(outcome) } catch (e) {
        if (scope.version === token) { setErr(`Could not record generation outcome: ${String(e)}`); setState('error') }
      } finally { scope.generating = false }
      if (submitted && scope.version === token) onBuilt?.()
    }
  }

  const errCount = res?.errors ? Object.values(res.errors).reduce((a, b) => a + b, 0) : 0
  const canRun = !!spec && !!runId
  const verdict = boardVerdict(res)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">{asElectronics ? 'electronics · bespoke chip-down board' : 'chip-scale electronics · tscircuit'}</span>
        {res && !res.imported && state === 'done' && (
          <div className="flex max-w-full shrink-0 overflow-x-auto rounded-sm border border-border">
            {(([['pcba', 'PCBA'], ['layout', 'Layout'], ['schematic', 'Schematic'], ['report', 'Report']]) as const).map(([v, label]) => (
              <button key={v} type="button" onClick={() => setView(v)}
                className={cn('px-2.5 py-0.5 text-[11px]',
                  view === v ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {label}
              </button>
            ))}
          </div>
        )}
        <button type="button" onClick={() => run(state === 'error' && operation === 'generate' ? { keepCapabilities } : undefined)} disabled={!canRun || generationDisabled || state === 'generating'} title={generationDisabled ? 'Generation is managed by the active pipeline.' : undefined}
          className="ml-auto flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {state === 'generating' ? <Loader2 className="size-3 animate-spin" /> : <CircuitBoard className="size-3" />}
          {state === 'generating' ? 'Generating…' : state === 'error' && operation === 'generate' ? 'Retry generation' : res ? 'Regenerate' : asElectronics ? 'Design the electronics' : 'Generate chip-scale board'}
        </button>
      </div>

      {!canRun && <div className="p-5"><p className="text-sm text-muted-foreground">Describe a product on the left first — then the electronics are synthesized as a real bare-chip board.</p></div>}
      {state === 'idle' && canRun && (
        <div className="p-5"><p className="text-sm text-muted-foreground">
          The product engine emits a code-defined board; <span className="text-foreground">tscircuit</span> autoroutes it in-process into an earbud-scale board. Its real size flows into the fit-check + redesign loop.
        </p></div>
      )}
      {state === 'loading' && <div role="status" className="p-5 text-sm text-muted-foreground">Loading saved board…</div>}
      {state === 'generating' && <div className="p-5"><p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> emitting + autorouting the board…</p></div>}
      {state === 'missing' && <div role="status" className="p-5 text-sm text-muted-foreground">No saved chip-scale board for this run.</div>}
      {state === 'error' && <div className="p-5"><div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{err}</div></div>}
      {(state === 'missing' || (state === 'error' && operation === 'read')) && (
        <button type="button" onClick={() => setRetry((n) => n + 1)} className="mx-5 mb-3 self-start rounded-md border border-border px-3 py-1 text-xs">Retry loading board</button>
      )}

      {res?.imported && state === 'done' && (
        <div className="space-y-3 overflow-auto p-5 text-sm">
          <h2 className="font-semibold">Imported PCB</h2>
          <p className="text-muted-foreground">Original KiCad board retained. Import is not engineering approval; no new synthesis or 3D export is started by opening this view.</p>
          <p>{res.boardMm ? `${res.boardMm.w} × ${res.boardMm.h} mm` : 'Board dimensions unavailable'}{res.components !== undefined ? ` · ${res.components} components` : ''}</p>
          <a className="inline-block rounded-md border border-border px-3 py-2" href={`/runs/${runId}/variant.kicad_pcb`} download>Download imported KiCad board</a>
          <p className="text-xs text-muted-foreground">Use Files and Checks to inspect the saved analysis. Imported boards do not include the generated chip-scale layout or schematic.</p>
        </div>
      )}
      {res && !res.imported && state === 'done' && (
        <div className="min-h-0 flex-1">
          {/* PCBA — the real populated chip-scale board in 3D (/api/board3d resolves
              this run's chipscale.kicad_pcb with 3D component models attached) */}
          {view === 'pcba' && (
            <div className="h-full w-full bg-[#0a0a0a]">
              <Board3D basePath={`/runs/${runId}/board`}
                fallback={<div className="flex h-full flex-col items-center justify-center gap-3 p-5 text-center text-xs text-muted-foreground">
                  <p>PCBA preview unavailable. Inspect the saved layout or board report instead.</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <button type="button" onClick={() => setView('layout')} className="rounded-md border border-border px-3 py-2 text-foreground">Open Layout</button>
                    <button type="button" onClick={() => setView('report')} className="rounded-md border border-border px-3 py-2 text-foreground">Open Report</button>
                  </div>
                </div>} />
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
            verdict.state === 'passed' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400')}>
            {verdict.headline}: {verdict.detail} ·
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
                      disabled={!canRun || generationDisabled}
                      title={generationDisabled ? 'Generation is managed by the active pipeline.' : undefined}
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
