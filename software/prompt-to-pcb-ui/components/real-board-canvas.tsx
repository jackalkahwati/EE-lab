'use client'

import { useEffect, useRef, useState } from 'react'
import { ZoomIn, ZoomOut, Maximize } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Board3D } from '@/components/board-3d'
import type { Run } from '@/lib/firstlight'
import type { RealBoardJson } from '@/lib/real-board'

/**
 * Renders the REAL board from kicad-cli exports in public/board/.
 * Each copper layer is a negative B&W SVG used as a luminance mask over a
 * tinted div, so the app palette applies to true KiCad geometry.
 */
const LAYERS = [
  { id: 'F.Cu', color: '#e8a33d', opacity: 0.95 },
  { id: 'In1.Cu', color: '#c98c2e', opacity: 0.55 },
  { id: 'In2.Cu', color: '#a37226', opacity: 0.45 },
  { id: 'B.Cu', color: '#7d581f', opacity: 0.6 },
] as const

type LayerId = (typeof LAYERS)[number]['id']
type ViewMode = 'copper' | '3d'

function MaskedLayer({
  src,
  color,
  opacity,
}: {
  src: string
  color: string
  opacity: number
}) {
  return (
    <div
      className="absolute inset-0"
      style={{
        backgroundColor: color,
        opacity,
        maskImage: `url(${src})`,
        maskSize: '100% 100%',
        maskRepeat: 'no-repeat',
        maskMode: 'luminance',
        WebkitMaskImage: `url(${src})`,
        WebkitMaskSize: '100% 100%',
        WebkitMaskRepeat: 'no-repeat',
      }}
    />
  )
}

const MIN_ZOOM = 1
const MAX_ZOOM = 12

/**
 * Scroll-to-zoom + drag-to-pan wrapper for the raytraced 3D renders, so the
 * board can be inspected up close. Double-click zooms in; again resets.
 */
function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [t, setT] = useState({ s: 1, x: 0, y: 0 })
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null)

  // zoom toward a point (cx, cy) in container coordinates
  const zoomAt = (cx: number, cy: number, factor: number) => {
    setT((t) => {
      const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, t.s * factor))
      if (s === t.s) return t
      if (s <= MIN_ZOOM) return { s: 1, x: 0, y: 0 }
      const k = s / t.s
      return { s, x: cx - (cx - t.x) * k, y: cy - (cy - t.y) * k }
    })
  }
  const zoomAtCenter = (factor: number) => {
    const r = ref.current?.getBoundingClientRect()
    if (r) zoomAt(r.width / 2, r.height / 2, factor)
  }

  // native listener: React's synthetic onWheel is passive, so it can't
  // preventDefault and the page would scroll while zooming
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.002))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div
      ref={ref}
      className={cn(
        'relative h-full w-full touch-none select-none overflow-hidden',
        t.s > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in',
      )}
      onPointerDown={(e) => {
        if (t.s <= 1) return
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { px: e.clientX, py: e.clientY, x: t.x, y: t.y }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d) setT((t) => ({ ...t, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }))
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={(e) => {
        if (t.s > 1) setT({ s: 1, x: 0, y: 0 })
        else {
          const r = e.currentTarget.getBoundingClientRect()
          zoomAt(e.clientX - r.left, e.clientY - r.top, 3)
        }
      }}
    >
      <div
        className="flex h-full w-full items-center justify-center p-4"
        style={{
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`,
          transformOrigin: '0 0',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} draggable={false} className="max-h-full max-w-full rounded-sm" />
      </div>

      {/* zoom controls */}
      <div className="absolute right-3 top-3 flex items-center gap-1">
        {[
          { label: 'Zoom in', icon: ZoomIn, act: () => zoomAtCenter(1.5) },
          { label: 'Zoom out', icon: ZoomOut, act: () => zoomAtCenter(1 / 1.5) },
          { label: 'Reset zoom', icon: Maximize, act: () => setT({ s: 1, x: 0, y: 0 }) },
        ].map(({ label, icon: I, act }) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            title={label}
            onClick={act}
            className="rounded-sm border border-border bg-secondary/90 p-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <I className="size-3.5" />
          </button>
        ))}
        {t.s > 1 && (
          <span className="rounded-sm border border-border bg-secondary/90 px-1.5 py-1 font-mono text-[10px] leading-none text-foreground">
            {t.s.toFixed(1)}×
          </span>
        )}
      </div>
      <span className="pointer-events-none absolute bottom-2 right-3 font-mono text-[9px] text-muted-foreground/60">
        scroll to zoom · drag to pan · double-click to reset
      </span>
    </div>
  )
}

/** Zoomable raytraced PNGs — the pre-3D view, kept as the fallback when a run
 *  has no .kicad_pcb to build a real 3D model from. */
function PhotoFallback({ basePath }: { basePath: string }) {
  const [side, setSide] = useState<'top' | 'bottom'>('top')
  return (
    <div className="relative h-full w-full">
      <ZoomableImage
        key={side}
        src={`${basePath}/render-${side}.png`}
        alt={`KiCad raytraced render, ${side} side`}
      />
      <div className="absolute left-3 top-3 flex items-center gap-1">
        {(['top', 'bottom'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            aria-pressed={side === s}
            className={cn(
              'rounded-sm border px-2 py-1 font-mono text-[10px] leading-none transition-colors',
              side === s
                ? 'border-primary/40 bg-primary/10 text-foreground'
                : 'border-border bg-secondary/90 text-muted-foreground',
            )}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

export function RealBoardCanvas({
  run,
  board,
  basePath = '/board',
}: {
  run: Run
  board: RealBoardJson
  // where this run's artifacts live: '/board' (shared latest) or '/runs/<id>/board'
  basePath?: string
}) {
  const [visibleLayers, setVisibleLayers] = useState<Set<LayerId>>(
    () => new Set(LAYERS.map((l) => l.id)),
  )
  const [silk, setSilk] = useState(false)
  const [view, setView] = useState<ViewMode>('copper')

  const toggleLayer = (id: LayerId) => {
    setVisibleLayers((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const aspect = board.boardSize.wMm / board.boardSize.hMm

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5">
          {(['copper', '3d'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setView(m)}
              aria-pressed={view === m}
              className={cn(
                'rounded-sm border px-2 py-1 font-mono text-[10px] leading-none transition-colors',
                view === m
                  ? 'border-primary/40 bg-primary/10 text-foreground'
                  : 'border-border bg-secondary text-muted-foreground',
              )}
            >
              {m === 'copper' ? 'layers' : '3D'}
            </button>
          ))}
          {view === 'copper' && (
            <>
              <span className="mx-1 h-4 w-px bg-border" />
              {LAYERS.map((layer) => (
                <button
                  key={layer.id}
                  type="button"
                  onClick={() => toggleLayer(layer.id)}
                  aria-pressed={visibleLayers.has(layer.id)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-sm border px-2 py-1 font-mono text-[10px] leading-none transition-colors',
                    visibleLayers.has(layer.id)
                      ? 'border-primary/40 bg-primary/10 text-foreground'
                      : 'border-border bg-secondary text-muted-foreground',
                  )}
                >
                  <span
                    className="size-2 rounded-[1px]"
                    style={{
                      backgroundColor: layer.color,
                      opacity: visibleLayers.has(layer.id) ? 1 : 0.3,
                    }}
                  />
                  {layer.id}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setSilk((v) => !v)}
                aria-pressed={silk}
                className={cn(
                  'rounded-sm border px-2 py-1 font-mono text-[10px] leading-none transition-colors',
                  silk
                    ? 'border-primary/40 bg-primary/10 text-foreground'
                    : 'border-border bg-secondary text-muted-foreground',
                )}
              >
                silk
              </button>
            </>
          )}
        </div>
        <span className="rounded-sm border border-border bg-secondary px-2 py-1 font-mono text-[10px] leading-none text-foreground">
          REAL · {run.metrics.netsRouted}/{run.metrics.netsTotal} nets ·{' '}
          {board.tracks} tracks · {board.vias} vias
        </span>
      </div>

      <div
        className={cn(
          'flex flex-1 items-center justify-center overflow-hidden bg-[#07090c]',
          view === 'copper' && 'p-4',
        )}
      >
        {view === 'copper' ? (
          <div
            className="relative max-h-full w-full max-w-4xl rounded-sm bg-[#10130d]"
            style={{ aspectRatio: `${aspect}` }}
            role="img"
            aria-label={`Real PCB copper: ${run.metrics.boardSize}, ${board.layers} layers`}
          >
            {/* board outline */}
            <MaskedLayer src={`${basePath}/Edge.Cuts.svg`} color="#9aa3ae" opacity={0.9} />
            {/* copper, bottom-up */}
            {[...LAYERS]
              .reverse()
              .map(
                (layer) =>
                  visibleLayers.has(layer.id) && (
                    <MaskedLayer
                      key={layer.id}
                      src={`${basePath}/${layer.id}.svg`}
                      color={layer.color}
                      opacity={layer.opacity}
                    />
                  ),
              )}
            {silk && (
              <MaskedLayer src={`${basePath}/F.SilkS.svg`} color="#d7dde6" opacity={0.55} />
            )}
          </div>
        ) : (
          <Board3D basePath={basePath} fallback={<PhotoFallback basePath={basePath} />} />
        )}
      </div>
    </div>
  )
}
