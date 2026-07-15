'use client'

/**
 * Schematic — a REAL electrical schematic (symbols + routed wires) generated
 * server-side from the run's actual netlist (/api/schematic, netlistsvg + ELK).
 * Tabs across the top drill into per-block sheets: "Full" shows the whole board;
 * each other tab is one IC's sub-circuit (the IC + everything sharing a signal
 * net with it), derived from real connectivity. Pan/zoom viewport.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Maximize, Minus, Plus } from 'lucide-react'

type Block = { id: string; label: string; count: number }

export function BoardSchematic({ runDir }: { runDir: string | null }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [blocks, setBlocks] = useState<Block[]>([])
  const [sel, setSel] = useState('all')
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [err, setErr] = useState('')
  const [t, setT] = useState({ s: 1, x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number } | null>(null)

  const runParam = runDir ? encodeURIComponent(runDir) : ''
  const src = runDir ? `/api/schematic?run=${runParam}${sel !== 'all' ? `&block=${sel}` : ''}` : ''

  // block list
  useEffect(() => {
    setSel('all'); setBlocks([])
    if (!runDir) return
    fetch(`/api/schematic?run=${runParam}&blocks=1`)
      .then((r) => (r.ok ? r.json() : { blocks: [] }))
      .then((j) => setBlocks(Array.isArray(j.blocks) ? j.blocks : []))
      .catch(() => setBlocks([]))
  }, [runDir, runParam])

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
      const s = Math.min(8, Math.max(0.03, p.s * f))
      return { s, x: mx - (mx - p.x) * (s / p.s), y: my - (my - p.y) * (s / p.s) }
    })
  }

  return (
    <div className="relative flex h-full flex-col bg-[#0f0f0f]">
      {/* block tabs */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card px-2 py-1.5">
        <button type="button" onClick={() => setSel('all')}
          className={cn('shrink-0 rounded-sm px-2 py-0.5 font-mono text-[10px]',
            sel === 'all' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/50')}>
          Full sheet
        </button>
        <span className="shrink-0 text-border">|</span>
        {blocks.map((b) => (
          <button key={b.id} type="button" onClick={() => setSel(b.id)}
            title={`${b.label} · ${b.count} parts`}
            className={cn('shrink-0 rounded-sm px-2 py-0.5 font-mono text-[10px]',
              sel === b.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/50')}>
            {b.label}
          </button>
        ))}
        {blocks.length === 0 && <span className="px-1 font-mono text-[9px] text-muted-foreground">no blocks</span>}
      </div>

      <div
        ref={wrapRef}
        className="relative min-h-0 flex-1 overflow-hidden"
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
            key={src}
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

        {phase === 'loading' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="rounded bg-background/80 px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
              drawing {sel === 'all' ? 'the board' : sel} schematic…
            </span>
          </div>
        )}
        {phase === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center bg-background">
            <span className="text-xs text-muted-foreground">schematic unavailable{err ? ` — ${err}` : ''}</span>
          </div>
        )}

        <div className="absolute right-3 top-3 flex items-center gap-1">
          {[
            { I: Plus, act: () => setT((p) => ({ ...p, s: Math.min(8, p.s * 1.2) })), label: 'zoom in' },
            { I: Minus, act: () => setT((p) => ({ ...p, s: Math.max(0.03, p.s / 1.2) })), label: 'zoom out' },
            { I: Maximize, act: fit, label: 'fit' },
          ].map(({ I, act, label }) => (
            <button key={label} type="button" onClick={act} aria-label={label} title={label}
              className="rounded-sm border border-border bg-secondary/90 p-1.5 text-muted-foreground hover:text-foreground">
              <I className="size-3.5" />
            </button>
          ))}
        </div>
        <span className="pointer-events-none absolute bottom-2 left-3 font-mono text-[9px] text-muted-foreground">
          {sel === 'all' ? 'full board' : `${sel} block`} · symbols + wires from the netlist · drag to pan · scroll to zoom
        </span>
      </div>
    </div>
  )
}
