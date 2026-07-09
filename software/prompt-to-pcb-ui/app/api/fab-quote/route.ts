/**
 * Live fab quote — currently JLCPCB only (the one fab whose Open API supports
 * real-time, self-serve price calculation and for which we hold credentials).
 * Other fabs have no public instant-quote API, so they stay as parametric
 * estimates in lib/fab-quotes.ts. Honest by construction: this returns a REAL
 * JLCPCB price when the account is configured + this server's IP is allowlisted,
 * otherwise it reports exactly why (unconfigured / ip_not_allowed / error).
 * Nothing is ordered — price calculation only.
 *
 *   POST /api/fab-quote  { width, height, layers, qty }
 */
import { jlcCalculate, jlcConfigured } from '@/lib/jlcpcb'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: Request) {
  let p: any = {}
  try { p = await req.json() } catch { /* */ }
  const width = Number(p.width), height = Number(p.height)
  const layers = Number(p.layers) || 2
  const qty = Number(p.qty) || 5
  if (!width || !height) return Response.json({ error: 'width and height (mm) required' }, { status: 400 })

  const jlc = await jlcCalculate({ layer: layers, width, length: height, qty,
    pcbColor: p.pcbColor, surfaceFinish: p.surfaceFinish })

  return Response.json({
    fab: 'jlcpcb',
    configured: jlcConfigured(),
    live: jlc.ok,
    ...(jlc.ok
      ? { priceUsd: jlc.priceUsd, leadDays: jlc.leadDays, currency: jlc.currency, raw: jlc.raw }
      : { reason: jlc.reason, message: jlc.message, httpStatus: jlc.httpStatus }),
  })
}
