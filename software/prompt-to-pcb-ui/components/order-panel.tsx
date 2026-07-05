'use client'

import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { Download, ShoppingCart, CircuitBoard, Cpu, Boxes } from 'lucide-react'

const QUANTITIES = [5, 10, 25, 50, 100] as const

/** Algorithmic PCB-fab quote (JLCPCB-style): board area × layer factor × qty
 *  discount + tooling. Reference model, a live fab API would replace it. */
function pcbQuote(wMm: number, hMm: number, layers: number, qty: number) {
  const areaCm2 = (wMm / 10) * (hMm / 10)
  const layerMult = layers >= 6 ? 2.6 : layers >= 4 ? 1.7 : 1.0
  const qtyMult =
    qty >= 100 ? 0.6 : qty >= 50 ? 0.7 : qty >= 25 ? 0.82 : qty >= 10 ? 0.92 : 1.0
  const perBoard = areaCm2 * 0.09 * layerMult * qtyMult
  return { perBoard, total: 12 + perBoard * qty }
}

/** Turnkey SMT assembly: per-placement + tooling, amortized over the run. */
function assemblyQuote(components: number, qty: number) {
  const perBoard = components * 0.05
  return { perBoard, total: 25 + perBoard * qty }
}

function Row({
  icon,
  label,
  sub,
  perBoard,
  total,
}: {
  icon: React.ReactNode
  label: string
  sub: string
  perBoard: number
  total: number
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="text-muted-foreground">{icon}</span>
        <div className="flex flex-col">
          <span className="text-xs font-medium text-foreground">{label}</span>
          <span className="font-mono text-[10px] text-muted-foreground">{sub}</span>
        </div>
      </div>
      <div className="text-right">
        <div className="font-mono text-xs tabular-nums text-foreground">
          ${total.toFixed(2)}
        </div>
        <div className="font-mono text-[10px] tabular-nums text-muted-foreground">
          ${perBoard.toFixed(2)}/bd
        </div>
      </div>
    </div>
  )
}

export function OrderPanel({
  boardW,
  boardH,
  layers,
  components,
  bomTotal,
  fabZip,
}: {
  boardW: number
  boardH: number
  layers: number
  components: number
  bomTotal: number
  fabZip?: string | null
}) {
  const [qty, setQty] = useState<number>(10)
  const [assembly, setAssembly] = useState(true)

  const { pcb, asm, parts, grand } = useMemo(() => {
    const pcb = pcbQuote(boardW, boardH, layers, qty)
    const asm = assemblyQuote(components, qty)
    const parts = { perBoard: bomTotal, total: bomTotal * qty }
    const grand = pcb.total + parts.total + (assembly ? asm.total : 0)
    return { pcb, asm, parts, grand }
  }, [boardW, boardH, layers, components, bomTotal, qty, assembly])

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="mx-auto w-full max-w-2xl p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-foreground">Order this board</h2>
          <span className="font-mono text-[10px] text-muted-foreground">
            {Math.round(boardW)}×{Math.round(boardH)}mm · {layers}-layer · {components} parts
          </span>
        </div>

        {/* quantity */}
        <div className="mb-3 flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            Quantity
          </span>
          <div className="flex gap-1">
            {QUANTITIES.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setQty(q)}
                className={cn(
                  'rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors',
                  q === qty
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground',
                )}
              >
                {q}
              </button>
            ))}
          </div>
        </div>

        {/* line items */}
        <div className="rounded-md border border-border bg-card px-3">
          <Row
            icon={<CircuitBoard className="size-4" />}
            label="PCB fabrication"
            sub={`${layers}-layer · ${Math.round(boardW)}×${Math.round(boardH)}mm · ENIG`}
            perBoard={pcb.perBoard}
            total={pcb.total}
          />
          <button
            type="button"
            onClick={() => setAssembly((v) => !v)}
            className="flex w-full items-center justify-between gap-3 border-b border-border/60 py-2.5 text-left"
          >
            <div className="flex items-center gap-2.5">
              <span
                className={cn(
                  'flex size-4 items-center justify-center rounded-[3px] border',
                  assembly ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                )}
              >
                {assembly && <span className="text-[9px] leading-none">✓</span>}
              </span>
              <Boxes className="size-4 text-muted-foreground" />
              <div className="flex flex-col">
                <span className="text-xs font-medium text-foreground">
                  Turnkey SMT assembly
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {components} placements · solder paste + reflow
                </span>
              </div>
            </div>
            <div className="text-right">
              <div
                className={cn(
                  'font-mono text-xs tabular-nums',
                  assembly ? 'text-foreground' : 'text-muted-foreground line-through',
                )}
              >
                ${asm.total.toFixed(2)}
              </div>
              <div className="font-mono text-[10px] tabular-nums text-muted-foreground">
                ${asm.perBoard.toFixed(2)}/bd
              </div>
            </div>
          </button>
          <Row
            icon={<Cpu className="size-4" />}
            label="Components (BOM)"
            sub={`parts subtotal · ${components} components`}
            perBoard={parts.perBoard}
            total={parts.total}
          />
          <div className="flex items-center justify-between py-3">
            <span className="text-sm font-semibold text-foreground">
              Total · {qty} boards
            </span>
            <span className="font-mono text-lg font-semibold tabular-nums text-primary">
              ${grand.toFixed(2)}
            </span>
          </div>
        </div>

        {/* actions */}
        <div className="mt-3 flex items-center gap-2">
          {fabZip && (
            <a
              href={fabZip}
              download
              className="flex items-center gap-1.5 rounded-sm border border-border px-3 py-2 font-mono text-[11px] text-foreground transition-colors hover:border-primary/40 hover:text-primary"
            >
              <Download className="size-3.5" />
              Fab package
            </a>
          )}
          <button
            type="button"
            className="flex flex-1 items-center justify-center gap-2 rounded-sm bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            <ShoppingCart className="size-4" />
            Place order · ${grand.toFixed(2)}
          </button>
        </div>
        <p className="mt-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
          Quote is a reference estimate (PCB area × layers × qty). Live pricing
          and one-click checkout connect a fab account (JLCPCB / PCBWay) + payment
         , gerbers, BOM and pick-and-place are already generated and attached.
        </p>
      </div>
    </div>
  )
}
