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
import { useState } from 'react'
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
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h)
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

      {/* visualization: photorealistic render on top, scaffold as the base/truth */}
      <div className="mt-4 min-h-0 flex-1">
        {showingRender ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={render.url} alt={`${brief.product} concept render`} className="mx-auto max-h-[52vh] w-auto rounded-md border border-border" />
        ) : (
          <IdScaffold brief={brief} boardMm={boardMm} className="mx-auto max-h-[52vh] w-full" />
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
