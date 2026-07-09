'use client'

/**
 * Schematic — a REAL connectivity view built from the run's actual netlist
 * (net → connected pins, from ato.json / netlist.txt). Components are nodes,
 * signal nets are edges; power/ground rails are shown as labels (not drawn to
 * every pin) so the graph stays readable. Force-laid-out, colored by ref type.
 * This is honest: it's the real connectivity, not a hand-authored symbol
 * schematic (auto-placing symbols + wires is a separate, hard problem).
 */
import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import type { RealBoard } from '@/lib/real-board'

type Pin = { ref: string; pin: string }
type Net = { name: string; pins: Pin[] }

const POWER = /^(\+?\d*v\d*|gnd|vcc|vdd|vbat|vin|vsys|agnd|dgnd|3v3|5v|vbus)$/i
const isPower = (n: Net) => POWER.test(n.name.replace(/[^\w+.]/g, '')) || n.pins.length >= 12

// ref prefix → type + color
const TYPE: [RegExp, string, string][] = [
  [/^U/, 'IC', '#60a5fa'], [/^R/, 'R', '#34d399'], [/^C/, 'C', '#fbbf24'],
  [/^J/, 'conn', '#c084fc'], [/^K/, 'relay', '#f87171'], [/^D/, 'D', '#f472b6'],
  [/^Q/, 'Q', '#fb923c'], [/^(L|FB)/, 'L', '#22d3ee'], [/^Y/, 'xtal', '#a3e635'],
  [/^TP/, 'TP', '#94a3b8'], [/^FO/, 'fid', '#64748b'],
]
const typeOf = (ref: string) => TYPE.find(([re]) => re.test(ref)) ?? [/./, 'misc', '#94a3b8']

function parseNetlist(text: string): Net[] {
  const nets: Net[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    // "NETNAME    R30.2, U30.1, ..."  (skip header / separator / blank lines)
    const m = line.match(/^(\S+)\s{2,}(.+)$/)
    if (!m || /^=|^Netlist/i.test(line)) continue
    const pins = m[2].split(',').map((p) => p.trim()).filter(Boolean)
      .map((p) => { const [ref, pin] = p.split('.'); return { ref, pin: pin ?? '' } })
      .filter((p) => p.ref)
    if (pins.length) nets.push({ name: m[1], pins })
  }
  return nets
}

// deterministic Fruchterman-Reingold-ish layout
function layout(ids: string[], edges: [string, string][], W: number, H: number) {
  const N = ids.length || 1
  const pos: Record<string, { x: number; y: number }> = {}
  ids.forEach((id, i) => {
    const a = (2 * Math.PI * i) / N
    pos[id] = { x: W / 2 + Math.cos(a) * W * 0.36, y: H / 2 + Math.sin(a) * H * 0.36 }
  })
  const k = Math.sqrt((W * H) / N) * 0.9
  const adj = edges.filter(([a, b]) => a !== b)
  for (let it = 0; it < 260; it++) {
    const disp: Record<string, { x: number; y: number }> = {}
    ids.forEach((id) => (disp[id] = { x: 0, y: 0 }))
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      const a = pos[ids[i]], b = pos[ids[j]]
      let dx = a.x - b.x, dy = a.y - b.y
      let d = Math.hypot(dx, dy) || 0.01
      const f = (k * k) / d
      dx = (dx / d) * f; dy = (dy / d) * f
      disp[ids[i]].x += dx; disp[ids[i]].y += dy
      disp[ids[j]].x -= dx; disp[ids[j]].y -= dy
    }
    for (const [a, b] of adj) {
      const pa = pos[a], pb = pos[b]; if (!pa || !pb) continue
      let dx = pa.x - pb.x, dy = pa.y - pb.y
      let d = Math.hypot(dx, dy) || 0.01
      const f = (d * d) / k
      dx = (dx / d) * f; dy = (dy / d) * f
      disp[a].x -= dx; disp[a].y -= dy
      disp[b].x += dx; disp[b].y += dy
    }
    const t = (1 - it / 260) * (k * 0.6)
    for (const id of ids) {
      const dp = disp[id]; const dl = Math.hypot(dp.x, dp.y) || 0.01
      pos[id].x += (dp.x / dl) * Math.min(dl, t)
      pos[id].y += (dp.y / dl) * Math.min(dl, t)
      // gravity to center
      pos[id].x += (W / 2 - pos[id].x) * 0.01
      pos[id].y += (H / 2 - pos[id].y) * 0.01
    }
  }
  return pos
}

export function BoardSchematic({ real }: { real: RealBoard | null }) {
  const [hover, setHover] = useState<string | null>(null)
  const netText = real?.ato?.find((f: any) => /netlist/i.test(f.name))?.content ?? ''

  const model = useMemo(() => {
    const nets = parseNetlist(netText)
    if (!nets.length) return null
    const signal = nets.filter((n) => !isPower(n))
    const power = nets.filter(isPower)
    const ids = Array.from(new Set(nets.flatMap((n) => n.pins.map((p) => p.ref)))).sort()
    // edges: star each signal net to its first component (keeps it readable)
    const edges: [string, string][] = []
    const edgeNet: Record<string, string> = {}
    for (const n of signal) {
      const comps = Array.from(new Set(n.pins.map((p) => p.ref)))
      for (let i = 1; i < comps.length; i++) {
        edges.push([comps[0], comps[i]])
        edgeNet[`${comps[0]}|${comps[i]}`] = n.name
      }
    }
    // power rails per component (for labels)
    const railOf: Record<string, string[]> = {}
    for (const n of power) for (const p of new Set(n.pins.map((x) => x.ref)))
      (railOf[p] ??= []).push(n.name)
    const W = 1000, H = 1000
    const pos = layout(ids, edges, W, H)
    // net membership per component (for hover)
    const compNets: Record<string, Set<string>> = {}
    for (const n of nets) for (const p of new Set(n.pins.map((x) => x.ref)))
      (compNets[p] ??= new Set()).add(n.name)
    return { ids, edges, edgeNet, railOf, pos, W, H, signal, power, compNets }
  }, [netText])

  if (!model) return <p className="p-3 text-xs text-muted-foreground">No netlist for this run — Schematic needs a composed board.</p>

  const { ids, edges, edgeNet, railOf, pos, W, H, signal, power, compNets } = model
  const neighbors = hover
    ? new Set(edges.filter(([a, b]) => a === hover || b === hover).flatMap(([a, b]) => [a, b]))
    : null

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-[10px] text-muted-foreground">
        <span className="font-semibold text-foreground">Schematic</span>
        <span>{ids.length} parts · {signal.length} signal nets · {power.length} power rails</span>
        <span className="ml-auto font-mono text-[9px]">from real netlist (net → pins)</span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden bg-[#0a0d12]">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full">
          {edges.map(([a, b], i) => {
            const on = !hover || a === hover || b === hover
            return (
              <line key={i} x1={pos[a].x} y1={pos[a].y} x2={pos[b].x} y2={pos[b].y}
                stroke={on ? '#3b4756' : '#1a2029'} strokeWidth={on && hover ? 1.4 : 0.7} />
            )
          })}
          {ids.map((id) => {
            const [, , color] = typeOf(id)
            const dim = neighbors && !neighbors.has(id) && id !== hover
            const rail = railOf[id]
            return (
              <g key={id} transform={`translate(${pos[id].x},${pos[id].y})`}
                onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover(null)}
                style={{ cursor: 'pointer', opacity: dim ? 0.25 : 1 }}>
                <circle r={id === hover ? 8 : 5.5} fill={color as string}
                  stroke={rail?.some((r) => /gnd/i.test(r)) ? '#0a0d12' : '#0a0d12'} strokeWidth={1} />
                <text x={9} y={3.5} fontSize={id === hover ? 13 : 10}
                  fill={id === hover ? '#e5e7eb' : '#8a93a0'} className="font-mono">{id}</text>
              </g>
            )
          })}
        </svg>
      </div>
      {/* legend + hover detail */}
      <div className="border-t border-border px-3 py-2 text-[10px]">
        {hover ? (
          <div>
            <span className="font-mono font-semibold text-foreground">{hover}</span>
            <span className="ml-2 text-muted-foreground">{typeOf(hover)[1]}</span>
            {railOf[hover]?.length ? <span className="ml-2 text-amber-500">power: {railOf[hover].join(', ')}</span> : null}
            <div className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground">
              nets: {[...(compNets[hover] ?? [])].slice(0, 14).join(' · ')}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
            {['IC', 'R', 'C', 'conn', 'relay', 'xtal'].map((t) => {
              const c = TYPE.find(([, name]) => name === t)?.[2] ?? '#94a3b8'
              return <span key={t} className="flex items-center gap-1"><span className="inline-block size-2 rounded-full" style={{ background: c }} />{t}</span>
            })}
            <span className="ml-auto">hover a part to trace its nets</span>
          </div>
        )}
      </div>
    </div>
  )
}
