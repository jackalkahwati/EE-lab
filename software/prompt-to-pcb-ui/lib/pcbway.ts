/**
 * PCBWay Partner API client — REAL instant PCB quotes via the partner API
 * (https://api-partner.pcbway.com). Server-side only. Auth is a simple
 * `api-key` header (no signing/token exchange). Requires a PCBWay partner key
 * (apply via their API Cooperation program) in .env.local:
 *   PCBWAY_API_KEY
 * Nothing is ordered — this calls the quotation endpoint only.
 */
const BASE = process.env.PCBWAY_ENDPOINT || 'https://api-partner.pcbway.com'
const QUOTE_URI = '/api/Pcb/PcbQuotation'

export type PcbwayParams = {
  layers: number; width: number; length: number; qty: number; thickness?: number
}

export type PcbwayResult =
  | { ok: true; priceUsd: number | null; leadDays: number | null; currency: string; raw: any }
  | { ok: false; reason: 'unconfigured' | 'auth' | 'error'; message: string; httpStatus?: number }

export function pcbwayConfigured(): boolean {
  return Boolean(process.env.PCBWAY_API_KEY)
}

// PCBWay returns a priceList of build options (standard + express). Pick the
// cheapest option's price + its build days. Defensive to shape/casing drift.
function extractPrice(data: any): { priceUsd: number | null; leadDays: number | null } {
  const list = data?.priceList ?? data?.PriceList ?? []
  if (!Array.isArray(list) || !list.length) return { priceUsd: null, leadDays: null }
  const opts = list.map((o: any) => ({
    price: Number(o.Price ?? o.price),
    days: parseInt(String(o.BuildDays ?? o.buildDays ?? '').replace(/\D+/g, ''), 10),
  })).filter((o: any) => o.price > 0)
  if (!opts.length) return { priceUsd: null, leadDays: null }
  opts.sort((a: any, b: any) => a.price - b.price)
  return { priceUsd: opts[0].price, leadDays: Number.isFinite(opts[0].days) ? opts[0].days : null }
}

export async function pcbwayQuote(p: PcbwayParams): Promise<PcbwayResult> {
  if (!pcbwayConfigured()) return { ok: false, reason: 'unconfigured', message: 'PCBWAY_API_KEY not set in .env.local (apply via PCBWay API Cooperation)' }

  const body = JSON.stringify({
    Length: p.length, Width: p.width, Layers: p.layers, Qty: p.qty,
    Thickness: p.thickness ?? 1.6, Material: 'FR-4', BoardType: 'Single PCB',
    SurfaceFinish: 'HASL', SolderMask: 'Green', Silkscreen: 'White',
  })

  let res: Response
  try {
    res = await fetch(BASE + QUOTE_URI, {
      method: 'POST',
      headers: { 'api-key': process.env.PCBWAY_API_KEY as string, 'Content-Type': 'application/json' },
      body,
    })
  } catch (e: any) {
    return { ok: false, reason: 'error', message: `network: ${String(e?.message ?? e).slice(0, 120)}` }
  }

  const text = await res.text()
  let j: any = null
  try { j = JSON.parse(text) } catch { /* non-JSON */ }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: 'auth', httpStatus: res.status,
      message: (j?.ErrorText || 'PCBWay rejected the api-key — check partner approval / key.').toString().slice(0, 200) }
  }
  const status = (j?.Status ?? j?.status ?? '').toString().toLowerCase()
  if (!res.ok || status === 'error') {
    const msg = (j?.ErrorText || j?.errorText || text || `HTTP ${res.status}`).toString()
    // some APIs report an auth failure in-body with a 200
    const reason = /api[- ]?key|auth|token|permission|unauthor/i.test(msg) ? 'auth' : 'error'
    return { ok: false, reason, httpStatus: res.status, message: msg.slice(0, 200) }
  }

  const { priceUsd, leadDays } = extractPrice(j)
  return { ok: true, priceUsd, leadDays, currency: 'USD', raw: j }
}
