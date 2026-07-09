/**
 * Live fab quotes — the fabs whose APIs support real-time, self-serve price
 * calculation and for which an integration exists: JLCPCB (Open API, HMAC) and
 * PCBWay (Partner API, api-key). Other fabs have NO public instant-quote API,
 * so they stay as parametric estimates in lib/fab-quotes.ts. Honest by
 * construction: each fab returns a REAL price when its account/key is
 * configured (and, for JLCPCB, the server IP is allowlisted + PCB permission
 * granted), otherwise it reports exactly why. Nothing is ordered.
 *
 *   POST /api/fab-quote  { width, height, layers, qty }
 *   -> { fabs: { jlcpcb: {...}, pcbway: {...} } }  each: {live, priceUsd, leadDays} | {live:false, reason, message}
 */
import { jlcCalculate } from '@/lib/jlcpcb'
import { pcbwayQuote } from '@/lib/pcbway'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: Request) {
  let p: any = {}
  try { p = await req.json() } catch { /* */ }
  const width = Number(p.width), height = Number(p.height)
  const layers = Number(p.layers) || 2
  const qty = Number(p.qty) || 5
  if (!width || !height) return Response.json({ error: 'width and height (mm) required' }, { status: 400 })

  const [jlc, pcbway] = await Promise.all([
    jlcCalculate({ layer: layers, width, length: height, qty, pcbColor: p.pcbColor, surfaceFinish: p.surfaceFinish }),
    pcbwayQuote({ layers, width, length: height, qty }),
  ])

  return Response.json({
    fabs: {
      jlcpcb: jlc.ok
        ? { live: true, priceUsd: jlc.priceUsd, leadDays: jlc.leadDays, currency: jlc.currency }
        : { live: false, reason: jlc.reason, message: jlc.message },
      pcbway: pcbway.ok
        ? { live: true, priceUsd: pcbway.priceUsd, leadDays: pcbway.leadDays, currency: pcbway.currency }
        : { live: false, reason: pcbway.reason, message: pcbway.message },
    },
  })
}
