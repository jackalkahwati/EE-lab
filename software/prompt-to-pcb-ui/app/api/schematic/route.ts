/**
 * Schematic generator — a REAL electrical schematic (symbols + routed wires)
 * from the run's actual netlist. Reads ato.json → netlist.txt (net → pins),
 * converts to a Yosys-style netlist, and renders it with netlistsvg's analog
 * skin (resistor / capacitor / inductor / diode / crystal symbols + generic IC
 * boxes, orthogonally routed by ELK). Server-side; nothing faked — every symbol
 * and wire comes from the composed board's connectivity.
 *
 *   GET /api/schematic?run=<runDir>  ->  image/svg+xml
 */
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// require() the CJS lib at runtime (default ESM import resolves to undefined for
// this externalized package); mirrors the working plain-node usage.
const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const netlistsvg = require('netlistsvg')

const RUNS = path.join(process.cwd(), 'public', 'runs')
const SKIN = path.join(process.cwd(), 'node_modules', 'netlistsvg', 'lib', 'analog.svg')
const cache = new Map<string, { mtime: number; svg: string }>()

function symType(ref: string): string {
  if (/^R/.test(ref)) return 'resistor_v'
  if (/^C/.test(ref)) return 'capacitor_v'
  if (/^(L|FB)/.test(ref)) return 'inductor_v'
  if (/^D/.test(ref)) return 'diode_v'
  if (/^Y/.test(ref)) return 'xtal'
  return 'generic'
}

function toYosys(netlistText: string, refPart: Record<string, string> = {}) {
  const nets: { name: string; pins: { ref: string; pin: string }[] }[] = []
  for (const raw of netlistText.split('\n')) {
    const m = raw.match(/^(\S+)\s{2,}(.+)$/)
    if (!m || /^=|^Netlist/i.test(raw)) continue
    const pins = m[2].split(',').map((s) => s.trim()).filter(Boolean)
      .map((p) => { const [ref, pin] = p.split('.'); return { ref, pin: pin ?? '' } })
      .filter((p) => p.ref)
    if (pins.length) nets.push({ name: m[1], pins })
  }
  let bit = 2
  const netBit: Record<string, number> = {}
  nets.forEach((n) => (netBit[n.name] = bit++))
  const comps: Record<string, { pin: string; net: string }[]> = {}
  for (const n of nets) for (const p of n.pins) (comps[p.ref] ??= []).push({ pin: p.pin, net: n.name })

  const cells: Record<string, any> = {}
  for (const [ref, pins] of Object.entries(comps)) {
    const t = symType(ref)
    const connections: Record<string, number[]> = {}
    const port_directions: Record<string, string> = {}
    if (t !== 'generic' && pins.length >= 2) {
      connections.A = [netBit[pins[0].net]]; port_directions.A = 'input'
      connections.B = [netBit[pins[1].net]]; port_directions.B = 'output'
    } else {
      pins.forEach((p, i) => {
        const port = `P${p.pin || i + 1}`
        connections[port] = [netBit[p.net]]
        port_directions[port] = i % 2 ? 'output' : 'input'
      })
    }
    cells[ref] = { type: t, port_directions, connections }
  }
  const netnames: Record<string, any> = {}
  for (const [name, b] of Object.entries(netBit)) netnames[name] = { bits: [b], hide_name: 0 }
  return { modules: { top: { ports: {}, cells, netnames } } }
}

export async function GET(req: Request) {
  // runDir arrives as "/runs/<name>" (or a bare name) — take the basename
  const raw = (new URL(req.url).searchParams.get('run') ?? '').trim()
  const run = raw.split('/').filter(Boolean).pop() ?? ''
  if (!run || !/^[A-Za-z0-9._-]+$/.test(run)) {
    return Response.json({ error: 'invalid run' }, { status: 400 })
  }
  const atoPath = path.join(RUNS, run, 'data', 'ato.json')
  if (!fs.existsSync(atoPath)) {
    return Response.json({ error: `no netlist for run ${run}` }, { status: 404 })
  }
  const mtime = fs.statSync(atoPath).mtimeMs
  const hit = cache.get(run)
  if (hit && hit.mtime === mtime) {
    return new Response(hit.svg, { headers: { 'content-type': 'image/svg+xml' } })
  }
  try {
    const ato = JSON.parse(fs.readFileSync(atoPath, 'utf8'))
    const netText = (ato.find((f: any) => /netlist/i.test(f.name))?.content) ?? ''
    if (!netText) return Response.json({ error: 'run has no netlist' }, { status: 422 })
    // map each ref → its part name from the BOM (grouped refs like "R30, R31")
    const refPart: Record<string, string> = {}
    try {
      const bom = JSON.parse(fs.readFileSync(path.join(RUNS, run, 'data', 'bom.json'), 'utf8'))
      for (const l of (Array.isArray(bom) ? bom : []))
        for (const r of String(l.ref).split(/,\s*/)) if (r) refPart[r] = l.part
    } catch { /* no bom → refs only */ }
    const yosys = toYosys(netText, refPart)
    const skin = fs.readFileSync(SKIN, 'utf8')
    let svg: string = await new Promise((resolve, reject) =>
      netlistsvg.render(skin, yosys, (err: any, out: string) => (err ? reject(err) : resolve(out))))
    // netlistsvg labels every part with its symbol TYPE (resistor_v / generic);
    // rewrite each label to the real reference (encoded in class="cell_<ref>"),
    // and the value line to the part name from the BOM.
    svg = svg.replace(/<text\b([^>]*)>([^<]*)<\/text>/g, (full, attrs) => {
      const m = attrs.match(/cell_([A-Za-z0-9]+)/)
      if (!m) return full
      if (/s:attribute="ref"/.test(attrs)) return `<text${attrs}>${m[1]}</text>`
      if (/s:attribute="value"/.test(attrs)) return `<text${attrs}>${(refPart[m[1]] ?? '').slice(0, 20)}</text>`
      return full
    })
    cache.set(run, { mtime, svg })
    return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } })
  } catch (e: any) {
    return Response.json({ error: 'schematic render failed', detail: String(e?.message ?? e).slice(0, 300) },
                        { status: 500 })
  }
}
