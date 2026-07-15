'use client'

/**
 * Industrial Design stage — the CENTER-pane visualization. The base layer is the
 * deterministic 4-quadrant to-scale SCAFFOLD (front · perspective · top-with-real-
 * board · side) — the geometric truth. On top of that a photorealistic 4-quadrant
 * render can be generated, conditioned by the rasterized scaffold so it matches
 * real proportions. Image billing may be capped, so the render is a GATED action:
 * it shows an honest "unavailable" state rather than faking a result. Nothing here
 * invents geometry — the scaffold is the mm values plotted.
 */
import { useState, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { Loader2, ImageIcon, Box } from 'lucide-react'
import type { IdBrief } from '@/lib/id-brief'
import { IdScaffold, ID_SCAFFOLD_SVG_ID } from '@/components/id-scaffold'

type RenderState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; url: string; provider?: string }
  | { status: 'unavailable'; message: string }
  | { status: 'error'; message: string }

/** Rasterize the on-screen scaffold SVG to a PNG data URL, inlining computed
 *  fill/stroke so the detached SVG keeps its styling (Tailwind classes don't
 *  survive serialization). Returns null if anything goes wrong — the render just
 *  proceeds without a reference then. */
async function rasterizeScaffold(): Promise<string | null> {
  try {
    const live = document.getElementById(ID_SCAFFOLD_SVG_ID) as SVGSVGElement | null
    if (!live) return null
    const clone = live.cloneNode(true) as SVGSVGElement
    const liveNodes = live.querySelectorAll('*')
    const cloneNodes = clone.querySelectorAll('*')
    liveNodes.forEach((n, i) => {
      const cs = getComputedStyle(n as Element)
      const c = cloneNodes[i] as SVGElement
      for (const prop of ['fill', 'stroke', 'fill-opacity', 'stroke-opacity', 'stroke-width', 'stroke-dasharray'] as const) {
        const v = cs.getPropertyValue(prop)
        if (v && v !== 'none') c.setAttribute(prop, v)
      }
    })
    const vb = live.viewBox.baseVal
    const w = vb?.width || live.clientWidth || 800
    const h = vb?.height || live.clientHeight || 800
    const xml = new XMLSerializer().serializeToString(clone)
    const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml)
    const img = new Image()
    img.width = w; img.height = h
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('svg load')); img.src = svgUrl })
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    // Dark canvas to match the app theme AND the render prompt: providers that
    // condition on this reference follow its background, so a white raster here
    // produced white concept sheets no matter what the prompt asked for.
    ctx.fillStyle = '#0f0f0f'; ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

export function IdStageView({
  brief, boardMm, runId,
}: {
  brief: IdBrief; boardMm?: { wMm: number; hMm: number }; runId?: string
}) {
  const [render, setRender] = useState<RenderState>({ status: 'idle' })
  const [showScaffold, setShowScaffold] = useState(false)
  const autoTried = useRef<string | null>(null)

  // Auto-render: load a persisted render on mount, else generate one once (the
  // render then persists, so opening Design shows a real photorealistic render by
  // default instead of the wireframe scaffold). Guarded to once per run.
  useEffect(() => {
    if (!runId) return
    let off = false
    fetch(`/runs/${runId}/id/render.json`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (off) return
        if (d && d.url) { setRender({ status: 'done', url: `${d.url}?t=${runId}`, provider: d.provider }); return }
        if (autoTried.current !== runId) { autoTried.current = runId; generate() }
      })
      .catch(() => {})
    return () => { off = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])

  async function generate() {
    setRender({ status: 'loading' })
    const scaffoldPng = await rasterizeScaffold()
    try {
      const r = await fetch('/api/id-render', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brief, boardMm, runId, scaffoldPng: scaffoldPng ?? undefined }),
      })
      const d = await r.json()
      if (d.ok) setRender({ status: 'done', url: d.url, provider: d.provider })
      else if (d.reason === 'unavailable') setRender({ status: 'unavailable', message: d.message || 'image generation is unavailable' })
      else setRender({ status: 'error', message: d.message || 'render failed' })
    } catch (e) {
      setRender({ status: 'error', message: String(e) })
    }
  }

  const showingRender = render.status === 'done' && !showScaffold
  // The scaffold is the honest fallback: show it visibly only when the render is
  // unavailable/errored, or when the user explicitly toggles it on a done render.
  // In idle/loading we show a neutral placeholder instead (not the wireframe).
  const scaffoldIsFallback =
    render.status === 'unavailable' || render.status === 'error' || (render.status === 'done' && showScaffold)

  return (
    <div className="flex h-full flex-col overflow-y-auto p-5">
      {/* header */}
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">industrial design</span>
        {boardMm ? (
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] text-emerald-600 dark:text-emerald-400">
            wraps real {Math.round(boardMm.wMm)}×{Math.round(boardMm.hMm)} board
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          {render.status === 'done' && (
            <button type="button" onClick={() => setShowScaffold((s) => !s)}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">
              <Box className="size-3" /> {showScaffold ? 'Show render' : 'Show scaffold'}
            </button>
          )}
          <button type="button" onClick={generate} disabled={render.status === 'loading'}
            className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {render.status === 'loading' ? <Loader2 className="size-3 animate-spin" /> : <ImageIcon className="size-3" />}
            {render.status === 'done' ? 'Regenerate' : 'Generate render'}
          </button>
        </div>
      </div>
      <h2 className="text-lg font-semibold text-foreground">{brief.product}</h2>
      {brief.formFactor && <p className="text-sm text-muted-foreground">{brief.formFactor}</p>}

      {/* visualization: photorealistic render on top; scaffold is the honest
          fallback (unavailable/error) or an explicit opt-in, never the initial view.
          While idle/loading we show a neutral placeholder. The scaffold SVG stays
          mounted (hidden when not the fallback) so rasterizeScaffold() can still
          read it for render conditioning. */}
      <div className="mt-4">
        <div className="mb-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
          concept — four views (front · perspective · top · side)
        </div>
        {/* Fixed-height dark panel like the PCBA/CAD viewers: the image is
            object-contain INSIDE it (letterboxed on the scene background), so
            it can never overflow and overlap the copy below it. */}
        <div className="h-[52vh] w-full overflow-hidden rounded-md border border-border bg-[#0f0f0f]">
          {showingRender && render.status === 'done' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={render.url} alt={`${brief.product} concept render`} className="h-full w-full object-contain" />
          ) : scaffoldIsFallback ? (
            <IdScaffold brief={brief} boardMm={boardMm} className="h-full w-full" />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">generating render…</span>
            </div>
          )}
        </div>
        {/* Keep the scaffold mounted (hidden) whenever it isn't the visible fallback,
            so rasterizeScaffold() can read the live SVG for render conditioning. */}
        {!scaffoldIsFallback && (
          <div className="hidden" aria-hidden="true">
            <IdScaffold brief={brief} boardMm={boardMm} className="mx-auto max-h-[52vh] w-full" />
          </div>
        )}
      </div>

      {/* render status line */}
      {render.status === 'unavailable' && (
        <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-400">
          Photorealistic render unavailable — image generation billing is capped (Gemini + OpenAI). The to-scale scaffold above is the real geometry; clear billing on either provider to enable renders.
        </div>
      )}
      {render.status === 'error' && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          Render failed: {render.message}
        </div>
      )}
      {render.status === 'done' && (
        <div className="mt-2 text-[10px] text-muted-foreground">
          concept render · {render.provider} · illustrative, not a dimensioned drawing (the scaffold is the metric truth)
        </div>
      )}

      {/* CMF + rationale */}
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3">
        {brief.cmf?.material && <span className="text-xs text-muted-foreground">{brief.cmf.material}</span>}
        {brief.cmf?.finish && <span className="text-xs text-muted-foreground">· {brief.cmf.finish}</span>}
        {brief.cmf?.color && <span className="text-xs text-muted-foreground">· {brief.cmf.color}</span>}
        {brief.aesthetic && (
          <span className="ml-auto rounded-full border border-border px-2 py-0.5 text-[11px] italic text-muted-foreground">{brief.aesthetic}</span>
        )}
      </div>
      {brief.rationale && <p className="mt-2 text-[13px] italic leading-relaxed text-muted-foreground">{brief.rationale}</p>}
    </div>
  )
}
