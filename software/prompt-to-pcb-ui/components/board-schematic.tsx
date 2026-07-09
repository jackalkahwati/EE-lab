'use client'

/**
 * Schematic — a REAL electrical schematic (component symbols + routed wires)
 * generated server-side from the run's actual netlist by /api/schematic
 * (netlistsvg + ELK, analog skin). Shown in a pan/zoom viewport because the
 * auto-laid-out sheet is wide. Nothing faked — every symbol/wire is the
 * composed board's real connectivity.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'

export function BoardSchematic({ runDir }: { runDir: string | null }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [err, setErr] = useState('')
  const [t, setT] = useState({ s: 1, x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number } | null>(null)

  const src = runDir ? `/api/schematic?run=${encodeURIComponent(runDir)}` : ''

  const fit = useCallback(() => {
    const wrap = wrapRef.current, img = imgRef.current
    if (!wrap || !img || !img.naturalWidth) return
    const s = Math.min(wrap.clientWidth / img.naturalWidth, wrap.clientHeight / img.naturalHeight) * 0.96
    setT({ s, x: (wrap.clientWidth - img.naturalWidth * s) / 2, y: (wrap.clientHeight - img.naturalHeight * s) / 2 })
  }, [])

  useEffect(() => { setPhase('loading') }, [src])

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const rect = wrapRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    setT((p) => {
      const f = e.deltaY < 0 ? 1.12 : 1 / 1.12
      const s = Math.min(8, Math.max(0.05, p.s * f))
      return { s, x: mx - (mx - p.x) * (s / p.s), y: my - (my - p.y) * (s / p.s) }
    })
  }

  return (
    <div className="relative flex h-full flex-col bg-[#f7f7f4]">
      <div
        ref={wrapRef}
        className="min-h-0 flex-1 overflow-hidden"
        onWheel={onWheel}
        onMouseDown={(e) => { drag.current = { x: e.clientX - t.x, y: e.clientY - t.y } }}
        onMouseMove={(e) => { if (drag.current) setT((p) => ({ ...p, x: e.clientX - drag.current!.x, y: e.clientY - drag.current!.y })) }}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
        style={{ cursor: drag.current ? 'grabbing' : 'grab' }}
      >
        {src && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={imgRef}
            src={src}
            alt="schematic"
            draggable={false}
            onLoad={() => { setPhase('ready'); fit() }}
            onError={async () => {
              setPhase('error')
              try { const r = await fetch(src); const j = await r.json(); setErr(j.error ?? '') } catch { /* */ }
            }}
            style={{ transformOrigin: '0 0', transform: `translate(${t.x}px,${t.y}px) scale(${t.s})`, maxWidth: 'none' }}
          />
        )}
      </div>

      {phase === 'loading' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded bg-background/80 px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
            drawing schematic from the netlist…
          </span>
        </div>
      )}
      {phase === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center bg-background">
          <span className="text-xs text-muted-foreground">schematic unavailable{err ? ` — ${err}` : ''}</span>
        </div>
      )}

      {/* controls */}
      <div className="absolute right-3 top-3 flex items-center gap-1">
        {[
          { I: Plus, act: () => setT((p) => ({ ...p, s: Math.min(8, p.s * 1.2) })), label: 'zoom in' },
          { I: Minus, act: () => setT((p) => ({ ...p, s: Math.max(0.05, p.s / 1.2) })), label: 'zoom out' },
          { I: Maximize, act: fit, label: 'fit' },
        ].map(({ I, act, label }) => (
          <button key={label} type="button" onClick={act} aria-label={label} title={label}
            className="rounded-sm border border-border bg-secondary/90 p-1.5 text-muted-foreground hover:text-foreground">
            <I className="size-3.5" />
          </button>
        ))}
      </div>
      <span className="pointer-events-none absolute bottom-2 left-3 font-mono text-[9px] text-neutral-400">
        real schematic · symbols + wires from the netlist · drag to pan · scroll to zoom
      </span>
    </div>
  )
}
