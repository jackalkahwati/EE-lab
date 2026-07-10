/**
 * Schematic generator — a REAL electrical schematic (symbols + routed wires)
 * from the run's actual netlist (ato.json → netlist.txt, net → pins), rendered
 * with netlistsvg's analog skin (ELK-routed). Server-side; nothing faked.
 *
 *   GET /api/schematic?run=<runDir>              -> full sheet (image/svg+xml)
 *   GET /api/schematic?run=<runDir>&block=<U..>  -> one block's sheet
 *   GET /api/schematic?run=<runDir>&blocks=1     -> JSON list of blocks
 *
 * Blocks are derived from the real connectivity: one per IC (the IC + every part
 * sharing a signal net with it), so drilling in shows that IC's sub-circuit.
 */
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { pinName } from '@/lib/ic-pinmaps'
import { isValidRunId, runAccess } from '@/lib/auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const require = createRequire(import.meta.url)
const netlistsvg = require('netlistsvg')

const RUNS = path.join(process.cwd(), 'public', 'runs')
const SKIN = path.join(process.cwd(), 'lib', 'schematic-skin.svg')
const cache = new Map<string, { mtime: number; svg: string }>()

type Pin = { ref: string; pin: string }
type Net = { name: string; pins: Pin[] }

function parseNetlist(text: string): Net[] {
  const nets: Net[] = []
  for (const raw of text.split('\n')) {
    const m = raw.match(/^(\S+)\s{2,}(.+)$/)
    if (!m || /^=|^Netlist/i.test(raw)) continue
    const pins = m[2].split(',').map((s) => s.trim()).filter(Boolean)
      .map((p) => { const [ref, pin] = p.split('.'); return { ref, pin: pin ?? '' } })
      .filter((p) => p.ref)
    if (pins.length) nets.push({ name: m[1], pins })
  }
  return nets
}

function isPowerNet(n: Net): boolean {
  const nm = n.name.replace(/[^\w+.]/g, '')
  return /^(\+?\d*v\d*|gnd|vcc|vdd|vbat|vin|vsys|agnd|dgnd|3v3|5v|vbus)$/i.test(nm) || n.pins.length >= 12
}

// one block per IC: the IC + every part sharing a SIGNAL net with it
function deriveBlocks(nets: Net[]): { id: string; refs: string[] }[] {
  const allRefs = [...new Set(nets.flatMap((n) => n.pins.map((p) => p.ref)))]
  const ics = allRefs.filter((r) => /^U/.test(r)).sort((a, b) => (+a.slice(1) || 0) - (+b.slice(1) || 0))
  return ics.map((ic) => {
    const members = new Set([ic])
    for (const n of nets) {
      const refs = n.pins.map((p) => p.ref)
      if (!refs.includes(ic)) continue
      if (isPowerNet(n)) {
        // on the IC's power/ground rails, pull in local passives (decoupling
        // caps, pull-ups) so they show on the sheet — but NOT other ICs or
        // connectors, which would drag the whole board into one block
        refs.forEach((r) => { if (/^(R|C|L|FB|D)/.test(r)) members.add(r) })
      } else {
        refs.forEach((r) => members.add(r)) // signal net: everything on it
      }
    }
    return { id: ic, refs: [...members] }
  })
}

function filterNets(nets: Net[], refSet: Set<string>): Net[] {
  return nets
    .map((n) => ({ name: n.name, pins: n.pins.filter((p) => refSet.has(p.ref)) }))
    .filter((n) => n.pins.length >= 1)
}

function buildRefPart(bom: any[], allRefs: string[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const l of bom) {
    const raw = String(l.ref ?? ''); const part = String(l.part ?? '')
    const rng = raw.match(/^([A-Za-z]+)(\d+)\s*(?:…|\.\.\.|\.\.)\s*[A-Za-z]*(\d+)/)
    if (rng) {
      const pre = rng[1], lo = +rng[2], hi = +rng[3]
      for (const r of allRefs) {
        const rm = r.match(/^([A-Za-z]+)(\d+)$/)
        if (rm && rm[1] === pre && +rm[2] >= lo && +rm[2] <= hi) map[r] = part
      }
    } else {
      for (const r of raw.split(/,\s*/)) { const t = r.trim(); if (/^[A-Za-z]+\d+$/.test(t)) map[t] = part }
    }
  }
  return map
}

// NOTE: netlistsvg matches a cell's `type` against the skin symbol's
// <s:alias val="…">, NOT its s:type. So these MUST be the skin aliases
// (r_v, c_v, l_v, d_v, xtal) or the cell falls back to the generic box.
function symType(ref: string): string {
  if (/^R/.test(ref)) return 'r_v'
  if (/^C/.test(ref)) return 'c_v'
  if (/^(L|FB)/.test(ref)) return 'l_v'
  if (/^D/.test(ref)) return 'd_v'
  if (/^Y/.test(ref)) return 'xtal'
  return 'generic'
}

// port names per two-terminal skin symbol (default A/B; diode is +/-)
const TWO_PIN_PORTS: Record<string, [string, string]> = { d_v: ['+', '-'] }

function toYosys(nets: Net[], refPart: Record<string, string> = {}) {
  let bit = 2
  const netBit: Record<string, number> = {}
  nets.forEach((n) => (netBit[n.name] = bit++))
  const comps: Record<string, { pin: string; net: string }[]> = {}
  for (const n of nets) for (const p of n.pins) (comps[p.ref] ??= []).push({ pin: p.pin, net: n.name })
  const cells: Record<string, any> = {}
  for (const [ref, pins] of Object.entries(comps)) {
    // a two-terminal symbol (r_v/c_v/d_v…) needs exactly its A/B (or +/-) ports;
    // if the netlist only connects one pad, render it as the generic box instead
    // so the cell type and its ports agree (else netlistsvg crashes on the
    // missing port). e.g. a resistor with a single connected pad.
    const t = symType(ref) !== 'generic' && pins.length >= 2 ? symType(ref) : 'generic'
    const connections: Record<string, number[]> = {}
    const port_directions: Record<string, string> = {}
    if (t !== 'generic') {
      // two-terminal symbol: use the port names the skin symbol actually
      // defines (diodes are '+'/'-'; R/C/L/xtal are A/B) or netlistsvg crashes
      const [pa, pb] = TWO_PIN_PORTS[t] ?? ['A', 'B']
      connections[pa] = [netBit[pins[0].net]]; port_directions[pa] = 'input'
      connections[pb] = [netBit[pins[1].net]]; port_directions[pb] = 'output'
    } else {
      pins.forEach((p, i) => {
        // functional pin name for recognized ICs (SDA/SCL/VDD…), else the number
        let port = pinName(refPart[ref] ?? '', p.pin) || `P${p.pin || i + 1}`
        if (connections[port]) port = `${port}_${p.pin || i}` // dedup safety
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
  const url = new URL(req.url)
  const raw = (url.searchParams.get('run') ?? '').trim()
  const run = raw.split('/').filter(Boolean).pop() ?? ''
  const block = (url.searchParams.get('block') ?? '').trim()
  const wantList = url.searchParams.get('blocks') === '1'
  if (!isValidRunId(run)) {
    return Response.json({ error: 'invalid run' }, { status: 400 })
  }
  const auth = runAccess(req, run)
  if (auth.access === 'unauthenticated') {
    return Response.json({ error: 'sign in required' }, { status: 401 })
  }
  if (auth.access === 'forbidden') {
    return Response.json({ error: 'not your board' }, { status: 403 })
  }
  const atoPath = path.join(RUNS, run, 'data', 'ato.json')
  if (!fs.existsSync(atoPath)) {
    return Response.json({ error: `no netlist for run ${run}` }, { status: 404 })
  }
  // cache key tracks BOTH the netlist and the captured values, so adding/
  // updating values.json after a first render invalidates the cached SVG.
  const valPath = path.join(RUNS, run, 'data', 'values.json')
  const mtime = fs.statSync(atoPath).mtimeMs
    + (fs.existsSync(valPath) ? fs.statSync(valPath).mtimeMs : 0)

  let ato: any, netText = ''
  try {
    ato = JSON.parse(fs.readFileSync(atoPath, 'utf8'))
    netText = (ato.find((f: any) => /netlist/i.test(f.name))?.content) ?? ''
  } catch { /* handled below */ }
  if (!netText) return Response.json({ error: 'run has no netlist' }, { status: 422 })

  const nets = parseNetlist(netText)
  const allRefs = [...new Set(nets.flatMap((n) => n.pins.map((p) => p.ref)))]
  let refPart: Record<string, string> = {}
  try {
    const bom = JSON.parse(fs.readFileSync(path.join(RUNS, run, 'data', 'bom.json'), 'utf8'))
    if (Array.isArray(bom)) refPart = buildRefPart(bom, allRefs)
  } catch { /* refs only */ }
  // real electrical values captured at design time (ref -> "100nF"/"4.7k"),
  // written by compose.py. Present on runs generated after value capture; the
  // schematic prefers these over the package name, and falls back when absent.
  let refValue: Record<string, string> = {}
  try {
    const v = JSON.parse(fs.readFileSync(path.join(RUNS, run, 'data', 'values.json'), 'utf8'))
    if (v && typeof v === 'object' && !Array.isArray(v)) refValue = v
  } catch { /* no captured values — fall back to part name */ }

  const blocks = deriveBlocks(nets)

  // block list (JSON)
  if (wantList) {
    return Response.json({
      blocks: blocks.map((b) => ({
        id: b.id,
        label: refPart[b.id] ? `${b.id} · ${refPart[b.id]}` : b.id,
        count: b.refs.length,
      })),
      totalParts: allRefs.length,
    })
  }

  // which nets to render
  let renderNets = nets
  if (block && block !== 'all') {
    const blk = blocks.find((b) => b.id === block)
    if (!blk) return Response.json({ error: `unknown block ${block}` }, { status: 404 })
    renderNets = filterNets(nets, new Set(blk.refs))
  }

  const cacheKey = `${run}:${block || 'all'}`
  const hit = cache.get(cacheKey)
  if (hit && hit.mtime === mtime) {
    return new Response(hit.svg, { headers: { 'content-type': 'image/svg+xml' } })
  }
  try {
    const yosys = toYosys(renderNets, refPart)
    const skin = fs.readFileSync(SKIN, 'utf8')
    let svg: string = await new Promise((resolve, reject) =>
      netlistsvg.render(skin, yosys, (err: any, out: string) => (err ? reject(err) : resolve(out))))
    // rewrite type labels → real ref (from class="cell_<ref>"), value → part name
    svg = svg.replace(/<text\b([^>]*)>([^<]*)<\/text>/g, (full, attrs) => {
      const m = attrs.match(/cell_([A-Za-z0-9]+)/)
      if (!m) return full
      if (/s:attribute="ref"/.test(attrs)) return `<text${attrs}>${m[1]}</text>`
      // prefer the real electrical value (10k/100nF); fall back to part name
      if (/s:attribute="value"/.test(attrs)) return `<text${attrs}>${(refValue[m[1]] ?? refPart[m[1]] ?? '').slice(0, 20)}</text>`
      return full
    })
    cache.set(cacheKey, { mtime, svg })
    return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } })
  } catch (e: any) {
    return Response.json({ error: 'schematic render failed', detail: String(e?.message ?? e).slice(0, 300) },
                        { status: 500 })
  }
}
