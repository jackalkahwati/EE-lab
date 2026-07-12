'use client'

/**
 * Industrial Design scaffold — a standardized 4-quadrant, to-scale orthographic
 * sheet drawn deterministically from the ID brief's envelope (front · ¾ iso ·
 * top-down · side). The real electronics board footprint is nested in the
 * top-down view, so the form visibly wraps the achievable geometry.
 *
 * This is the geometric TRUTH of the industrial design: no model, no image, just
 * the mm values plotted. It is (a) shown behind the photorealistic render, and
 * (b) rasterized to condition that render, and (c) the same geometry the
 * mechanical/CAD module will build from. All four views share one mm->px scale
 * so they read as a consistent spec sheet.
 */
import type { IdBrief } from '@/lib/id-brief'

const COS30 = Math.cos(Math.PI / 6)
const SIN30 = 0.5

/** id used so the parent can find + rasterize this SVG for image conditioning. */
export const ID_SCAFFOLD_SVG_ID = 'id-scaffold-svg'

export function IdScaffold({
  brief,
  boardMm,
  className,
}: {
  brief: IdBrief
  boardMm?: { wMm: number; hMm: number }
  className?: string
}) {
  const e = brief.envelopeMm ?? {}
  const x = e.x ?? 0
  const y = e.y ?? 0
  const zRaw = e.z ?? 0
  if (!(x > 0 && y > 0)) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">No envelope dimensions in this brief.</div>
  }
  const z = zRaw > 0 ? zRaw : Math.max(6, Math.min(x, y) * 0.3)

  const CELL = 190 // px budget per view
  const PAD = 30 // px padding inside each cell (labels live here)
  const S = CELL / Math.max(x, y, z) // one shared mm->px scale
  const cw = CELL + PAD * 2
  const ch = CELL + PAD * 2
  const W = cw * 2
  const H = ch * 2

  // center point of a grid cell (col 0|1, row 0|1)
  const cx = (col: number) => col * cw + cw / 2
  const cy = (row: number) => row * ch + ch / 2
  const rr = (w: number, h: number) => Math.min(w, h) * 0.08 // corner radius px

  // --- orthographic rounded-rect view, centered in its cell ---
  const OrthoRect = ({
    col, row, wMm, hMm, label, inner,
  }: {
    col: number; row: number; wMm: number; hMm: number; label: string
    inner?: { wMm: number; hMm: number; label: string }
  }) => {
    const w = wMm * S
    const h = hMm * S
    const ox = cx(col) - w / 2
    const oy = cy(row) - h / 2
    return (
      <g>
        <rect x={ox} y={oy} width={w} height={h} rx={rr(w, h)}
          className="fill-primary/5 stroke-primary" strokeWidth={1.2} />
        {inner && inner.wMm > 0 && inner.hMm > 0 && (
          <rect
            x={cx(col) - (inner.wMm * S) / 2} y={cy(row) - (inner.hMm * S) / 2}
            width={inner.wMm * S} height={inner.hMm * S} rx={2}
            className="fill-emerald-500/15 stroke-emerald-500" strokeWidth={1} strokeDasharray="4 3" />
        )}
        <text x={cx(col)} y={row * ch + 18} textAnchor="middle"
          className="fill-muted-foreground" style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
          {label}
        </text>
        <text x={cx(col)} y={(row + 1) * ch - 10} textAnchor="middle"
          className="fill-muted-foreground" style={{ fontSize: 10, fontFamily: 'ui-monospace, monospace' }}>
          {Math.round(wMm)} × {Math.round(hMm)} mm
          {inner ? `  ·  ${inner.label} ${Math.round(inner.wMm)}×${Math.round(inner.hMm)}` : ''}
        </text>
      </g>
    )
  }

  // --- ¾ isometric box in the top-right cell ---
  const iso = (u: number, v: number, w: number) => ({
    px: (u - v) * COS30 * S,
    py: ((u + v) * SIN30 - w) * S,
  })
  const isoPts = [
    iso(0, 0, 0), iso(x, 0, 0), iso(x, y, 0), iso(0, y, 0),
    iso(0, 0, z), iso(x, 0, z), iso(x, y, z), iso(0, y, z),
  ]
  const minPx = Math.min(...isoPts.map((p) => p.px))
  const maxPx = Math.max(...isoPts.map((p) => p.px))
  const minPy = Math.min(...isoPts.map((p) => p.py))
  const maxPy = Math.max(...isoPts.map((p) => p.py))
  const isoTx = cx(1) - (minPx + maxPx) / 2
  const isoTy = cy(0) - (minPy + maxPy) / 2
  const P = isoPts.map((p) => `${(p.px + isoTx).toFixed(1)},${(p.py + isoTy).toFixed(1)}`)
  // faces: top (4,5,6,7), front (0,1,5,4), right (1,2,6,5)
  const face = (idx: number[]) => idx.map((i) => P[i]).join(' ')

  return (
    <svg
      id={ID_SCAFFOLD_SVG_ID}
      viewBox={`0 0 ${W} ${H}`}
      className={className}
      style={{ maxWidth: '100%', maxHeight: '100%' }}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x={0} y={0} width={W} height={H} className="fill-background" />
      <OrthoRect col={0} row={0} wMm={x} hMm={z} label="FRONT" />
      {/* iso */}
      <g>
        <polygon points={face([4, 5, 6, 7])} className="fill-primary/10 stroke-primary" strokeWidth={1.2} />
        <polygon points={face([0, 1, 5, 4])} className="fill-primary/5 stroke-primary" strokeWidth={1.2} />
        <polygon points={face([1, 2, 6, 5])} className="fill-primary/[0.03] stroke-primary" strokeWidth={1.2} />
        <text x={cx(1)} y={0 * ch + 18} textAnchor="middle"
          className="fill-muted-foreground" style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
          PERSPECTIVE
        </text>
        <text x={cx(1)} y={1 * ch - 10} textAnchor="middle"
          className="fill-muted-foreground" style={{ fontSize: 10, fontFamily: 'ui-monospace, monospace' }}>
          {Math.round(x)} × {Math.round(y)} × {Math.round(z)} mm
        </text>
      </g>
      <OrthoRect col={0} row={1} wMm={x} hMm={y} label="TOP"
        inner={boardMm ? { wMm: boardMm.wMm, hMm: boardMm.hMm, label: 'board' } : undefined} />
      <OrthoRect col={1} row={1} wMm={y} hMm={z} label="SIDE" />
    </svg>
  )
}
