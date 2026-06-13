'use client'

import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import type { Run } from '@/lib/firstlight'
import type { RealBoardJson } from '@/lib/real-board'
import { RealBoardCanvas } from '@/components/real-board-canvas'

const LAYERS = [
  { id: 'F.Cu', color: '#e8a33d', opacity: 0.95 },
  { id: 'In1.Cu', color: '#c98c2e', opacity: 0.55 },
  { id: 'In2.Cu', color: '#a37226', opacity: 0.45 },
  { id: 'B.Cu', color: '#7d581f', opacity: 0.6 },
] as const

type LayerId = (typeof LAYERS)[number]['id']

/* deterministic PRNG so the mock board is stable across renders */
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface RelayPos {
  x: number
  y: number
}

function useBoardGeometry() {
  return useMemo(() => {
    const relays: RelayPos[] = []
    // 8 cols x 11 rows of relay footprints in the matrix region
    for (let row = 0; row < 11; row++) {
      for (let col = 0; col < 8; col++) {
        relays.push({ x: 14 + col * 17.2, y: 28 + row * 12.6 })
      }
    }

    const rand = mulberry32(1337)
    const traces: Record<LayerId, string[]> = {
      'F.Cu': [],
      'In1.Cu': [],
      'In2.Cu': [],
      'B.Cu': [],
    }

    // generate manhattan-style traces from relays toward driver column / mcu
    for (let i = 0; i < relays.length; i++) {
      const r = relays[i]
      const layer = LAYERS[Math.floor(rand() * 4)].id
      const x0 = r.x + 6
      const y0 = r.y + 3.5
      const midX = x0 + 4 + rand() * 14
      const endY = 28 + rand() * 126
      const endX = 158 + rand() * 30
      traces[layer].push(
        `M ${x0.toFixed(1)} ${y0.toFixed(1)} H ${midX.toFixed(1)} V ${endY.toFixed(1)} H ${endX.toFixed(1)}`,
      )
    }
    // mcu fanout
    for (let i = 0; i < 22; i++) {
      const layer = LAYERS[i % 4].id
      const y = 120 + (i % 11) * 3.2
      traces[layer].push(
        `M 168 ${y.toFixed(1)} H ${(150 - (i % 7) * 8).toFixed(1)} V ${(y - 18 - (i % 5) * 6).toFixed(1)}`,
      )
    }

    // ratsnest: unrouted airwires (straight lines)
    const rats: { x1: number; y1: number; x2: number; y2: number }[] = []
    for (let i = 0; i < 24; i++) {
      const a = relays[Math.floor(rand() * relays.length)]
      rats.push({
        x1: a.x + 6,
        y1: a.y + 3.5,
        x2: 160 + rand() * 28,
        y2: 115 + rand() * 45,
      })
    }

    return { relays, traces, rats }
  }, [])
}

export function BoardCanvas({
  run,
  realBoard,
}: {
  run: Run
  realBoard?: RealBoardJson | null
}) {
  const [visibleLayers, setVisibleLayers] = useState<Set<LayerId>>(
    () => new Set(LAYERS.map((l) => l.id)),
  )
  const [ratsnest, setRatsnest] = useState(true)
  const { relays, traces, rats } = useBoardGeometry()

  if (run.real && realBoard) {
    return <RealBoardCanvas run={run} board={realBoard} />
  }

  const toggleLayer = (id: LayerId) => {
    setVisibleLayers((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5">
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
          <span className="mx-1 h-4 w-px bg-border" />
          <button
            type="button"
            onClick={() => setRatsnest((v) => !v)}
            aria-pressed={ratsnest}
            className={cn(
              'rounded-sm border px-2 py-1 font-mono text-[10px] leading-none transition-colors',
              ratsnest
                ? 'border-primary/40 bg-primary/10 text-foreground'
                : 'border-border bg-secondary text-muted-foreground',
            )}
          >
            ratsnest
          </button>
        </div>
        <span className="rounded-sm border border-border bg-secondary px-2 py-1 font-mono text-[10px] leading-none text-foreground">
          {run.metrics.netsRouted}/{run.metrics.netsTotal} nets ·{' '}
          {run.metrics.copperDefects} copper defects
        </span>
      </div>

      <div className="flex flex-1 items-center justify-center overflow-hidden bg-[#07090c] p-4">
        <svg
          viewBox="-6 -6 212 187"
          className="max-h-full w-full max-w-4xl"
          role="img"
          aria-label="PCB board preview: 200 by 175 millimeter board with 8 by 11 relay matrix"
        >
          {/* board substrate */}
          <rect
            x="0"
            y="0"
            width="200"
            height="175"
            rx="2"
            fill="#10130d"
            stroke="#e8a33d"
            strokeOpacity="0.5"
            strokeWidth="0.6"
          />
          {/* grid */}
          {Array.from({ length: 19 }, (_, i) => (
            <line
              key={`gv${i}`}
              x1={(i + 1) * 10}
              y1="0"
              x2={(i + 1) * 10}
              y2="175"
              stroke="#ffffff"
              strokeOpacity="0.03"
              strokeWidth="0.3"
            />
          ))}
          {Array.from({ length: 16 }, (_, i) => (
            <line
              key={`gh${i}`}
              x1="0"
              y1={(i + 1) * 10.9}
              x2="200"
              y2={(i + 1) * 10.9}
              stroke="#ffffff"
              strokeOpacity="0.03"
              strokeWidth="0.3"
            />
          ))}

          {/* mounting holes */}
          {[
            [5, 5],
            [195, 5],
            [5, 170],
            [195, 170],
          ].map(([x, y]) => (
            <circle
              key={`mh${x}-${y}`}
              cx={x}
              cy={y}
              r="1.8"
              fill="none"
              stroke="#e8a33d"
              strokeOpacity="0.6"
              strokeWidth="0.5"
            />
          ))}

          {/* traces per layer */}
          {LAYERS.map(
            (layer) =>
              visibleLayers.has(layer.id) && (
                <g key={layer.id} fill="none">
                  {traces[layer.id].map((d, i) => (
                    <path
                      key={i}
                      d={d}
                      stroke={layer.color}
                      strokeOpacity={layer.opacity * 0.55}
                      strokeWidth="0.45"
                    />
                  ))}
                </g>
              ),
          )}

          {/* ratsnest airwires */}
          {ratsnest && (
            <g>
              {rats.map((r, i) => (
                <line
                  key={i}
                  x1={r.x1}
                  y1={r.y1}
                  x2={r.x2}
                  y2={r.y2}
                  stroke="#79818f"
                  strokeOpacity="0.35"
                  strokeWidth="0.25"
                  strokeDasharray="1 1"
                />
              ))}
            </g>
          )}

          {/* relay footprints 8x11 */}
          {relays.map((r, i) => (
            <g key={i}>
              <rect
                x={r.x}
                y={r.y}
                width="12"
                height="7"
                fill="#161a10"
                stroke="#e8a33d"
                strokeOpacity="0.45"
                strokeWidth="0.35"
              />
              {/* pads */}
              {[1.5, 4.5, 7.5, 10.5].map((px) => (
                <g key={px}>
                  <rect
                    x={r.x + px - 0.6}
                    y={r.y - 0.8}
                    width="1.2"
                    height="1.4"
                    fill="#e8a33d"
                    fillOpacity="0.8"
                  />
                  <rect
                    x={r.x + px - 0.6}
                    y={r.y + 6.4}
                    width="1.2"
                    height="1.4"
                    fill="#e8a33d"
                    fillOpacity="0.8"
                  />
                </g>
              ))}
            </g>
          ))}

          {/* MCU block */}
          <rect
            x="160"
            y="112"
            width="14"
            height="14"
            fill="#161a10"
            stroke="#e8a33d"
            strokeOpacity="0.6"
            strokeWidth="0.4"
          />
          <text
            x="167"
            y="120.5"
            textAnchor="middle"
            fontSize="3"
            fill="#e8a33d"
            fillOpacity="0.9"
            fontFamily="monospace"
          >
            U1
          </text>

          {/* driver column */}
          {Array.from({ length: 11 }, (_, i) => (
            <rect
              key={`drv${i}`}
              x="160"
              y={28 + i * 7.2}
              width="9"
              height="4.5"
              fill="#161a10"
              stroke="#e8a33d"
              strokeOpacity="0.4"
              strokeWidth="0.3"
            />
          ))}

          {/* USB-C */}
          <rect
            x="178"
            y="140"
            width="9"
            height="4"
            rx="1.5"
            fill="#1c212c"
            stroke="#e8a33d"
            strokeOpacity="0.6"
            strokeWidth="0.4"
          />
          <text
            x="182.5"
            y="148.5"
            textAnchor="middle"
            fontSize="2.6"
            fill="#79818f"
            fontFamily="monospace"
          >
            J1 USB-C
          </text>

          {/* 24V terminal */}
          <rect
            x="178"
            y="156"
            width="12"
            height="7"
            fill="#1c212c"
            stroke="#e8a33d"
            strokeOpacity="0.6"
            strokeWidth="0.4"
          />
          <text
            x="184"
            y="167.5"
            textAnchor="middle"
            fontSize="2.6"
            fill="#79818f"
            fontFamily="monospace"
          >
            J2 24V
          </text>

          {/* edge connector */}
          <rect
            x="40"
            y="169"
            width="60"
            height="4"
            fill="#1c212c"
            stroke="#e8a33d"
            strokeOpacity="0.5"
            strokeWidth="0.4"
          />

          {/* dimensions */}
          <text
            x="100"
            y="-2"
            textAnchor="middle"
            fontSize="3.2"
            fill="#79818f"
            fontFamily="monospace"
          >
            200.0 mm
          </text>
          <text
            x="-2"
            y="87"
            textAnchor="middle"
            fontSize="3.2"
            fill="#79818f"
            fontFamily="monospace"
            transform="rotate(-90 -2 87)"
          >
            175.0 mm
          </text>
        </svg>
      </div>
    </div>
  )
}
