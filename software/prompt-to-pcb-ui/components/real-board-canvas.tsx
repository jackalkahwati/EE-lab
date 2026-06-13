'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
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
type ViewMode = 'copper' | 'photo-top' | 'photo-bottom'

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

export function RealBoardCanvas({
  run,
  board,
}: {
  run: Run
  board: RealBoardJson
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
          {(['copper', 'photo-top', 'photo-bottom'] as const).map((m) => (
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
              {m === 'copper' ? 'layers' : m.replace('photo-', '3D ')}
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

      <div className="flex flex-1 items-center justify-center overflow-hidden bg-[#07090c] p-4">
        {view === 'copper' ? (
          <div
            className="relative max-h-full w-full max-w-4xl rounded-sm bg-[#10130d]"
            style={{ aspectRatio: `${aspect}` }}
            role="img"
            aria-label={`Real PCB copper: ${run.metrics.boardSize}, ${board.layers} layers`}
          >
            {/* board outline */}
            <MaskedLayer src="/board/Edge.Cuts.svg" color="#9aa3ae" opacity={0.9} />
            {/* copper, bottom-up */}
            {[...LAYERS]
              .reverse()
              .map(
                (layer) =>
                  visibleLayers.has(layer.id) && (
                    <MaskedLayer
                      key={layer.id}
                      src={`/board/${layer.id}.svg`}
                      color={layer.color}
                      opacity={layer.opacity}
                    />
                  ),
              )}
            {silk && (
              <MaskedLayer src="/board/F.SilkS.svg" color="#d7dde6" opacity={0.55} />
            )}
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/board/render-${view === 'photo-top' ? 'top' : 'bottom'}.png`}
            alt={`KiCad raytraced render, ${view === 'photo-top' ? 'top' : 'bottom'} side`}
            className="max-h-full max-w-full rounded-sm"
          />
        )}
      </div>
    </div>
  )
}
