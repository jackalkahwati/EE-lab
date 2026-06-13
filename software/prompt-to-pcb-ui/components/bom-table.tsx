'use client'

import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { BOM_LINES, type BomLine } from '@/lib/firstlight'
import { Search, Download } from 'lucide-react'

export function BomTable({ lines }: { lines?: BomLine[] | null }) {
  const data = lines ?? BOM_LINES
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return data
    return data.filter(
      (l) =>
        l.ref.toLowerCase().includes(q) ||
        l.part.toLowerCase().includes(q) ||
        l.lcsc.toLowerCase().includes(q),
    )
  }, [query, data])

  const totalComponents = data.reduce((s, l) => s + l.qty, 0)

  const exportCsv = () => {
    const header = 'Ref,Part,LCSC,Qty,Unit Price,Line Type'
    const rows = data.map(
      (l) =>
        `"${l.ref}","${l.part}",${l.lcsc},${l.qty},${l.unitPrice},${l.lineType}`,
    )
    const blob = new Blob([[header, ...rows].join('\n')], {
      type: 'text/csv',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'bom.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ref, part, LCSC #…"
            className="w-full rounded-sm border border-border bg-secondary py-1.5 pl-7 pr-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none"
            aria-label="Search BOM"
          />
        </div>
        <button
          type="button"
          onClick={exportCsv}
          className="flex items-center gap-1.5 rounded-sm border border-border bg-secondary px-2.5 py-1.5 font-mono text-[10px] text-foreground transition-colors hover:border-primary/40 hover:text-primary"
        >
          <Download className="size-3" />
          CSV export
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-card">
            <tr className="border-b border-border text-left font-mono text-[10px] tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-medium">REF</th>
              <th className="px-3 py-2 font-medium">PART</th>
              <th className="px-3 py-2 font-medium">LCSC #</th>
              <th className="px-3 py-2 text-right font-medium">QTY</th>
              <th className="px-3 py-2 text-right font-medium">UNIT $</th>
              <th className="px-3 py-2 font-medium">LINE</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((line) => (
              <tr
                key={line.ref}
                className="border-b border-border/50 hover:bg-secondary/50"
              >
                <td className="px-3 py-1.5 font-mono text-primary">
                  {line.ref}
                </td>
                <td className="px-3 py-1.5 text-foreground">{line.part}</td>
                <td className="px-3 py-1.5 font-mono text-muted-foreground">
                  {line.lcsc}
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums text-foreground">
                  {line.qty}
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums text-foreground">
                  {line.unitPrice > 0 ? line.unitPrice.toFixed(3) : '—'}
                </td>
                <td className="px-3 py-1.5">
                  <span
                    className={cn(
                      'rounded-sm border px-1.5 py-0.5 font-mono text-[10px] leading-none',
                      line.lineType === 'ordered'
                        ? 'border-success/40 bg-success/10 text-success'
                        : 'border-primary/40 bg-primary/10 text-primary',
                    )}
                  >
                    {line.lineType}
                  </span>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-8 text-center font-mono text-muted-foreground"
                >
                  no matching BOM lines
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="border-t border-border px-3 py-2">
        <p className="font-mono text-[10px] text-muted-foreground">
          {totalComponents} components · {data.length} BOM lines ·{' '}
          {lines ? 'from atopile default.bom.csv' : 'all real parts'}
        </p>
      </div>
    </div>
  )
}
