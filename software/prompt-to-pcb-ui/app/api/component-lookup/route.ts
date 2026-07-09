/**
 * Live component data — refreshes real stock / pricing / alternates for a set of
 * MPNs from the Nexar (Octopart) API. HONESTY: this returns REAL distributor
 * data ONLY when a Nexar credential is configured; with no key it says so
 * (configured:false) rather than inventing inventory. Set NEXAR_CLIENT_ID +
 * NEXAR_CLIENT_SECRET (OAuth client-credentials) — or a NEXAR_TOKEN bearer — in
 * .env.local. Nothing is ordered; this is data only.
 *
 *   POST /api/component-lookup  { mpns: string[] }
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

let cachedToken: { token: string; exp: number } | null = null

async function nexarToken(): Promise<string | null> {
  if (process.env.NEXAR_TOKEN) return process.env.NEXAR_TOKEN
  const id = process.env.NEXAR_CLIENT_ID, secret = process.env.NEXAR_CLIENT_SECRET
  if (!id || !secret) return null
  if (cachedToken && cachedToken.exp > Date.now() + 30_000) return cachedToken.token
  const res = await fetch('https://identity.nexar.com/connect/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: 'supply.domain' }),
  })
  if (!res.ok) return null
  const j = await res.json()
  cachedToken = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 }
  return j.access_token
}

const QUERY = `query ($q: String!) {
  supSearchMpn(q: $q, limit: 1) {
    results { part {
      mpn manufacturer { name }
      medianPrice1000 { price currency }
      totalAvailQty
      sellers(authorizedOnly: true) { company { name } offers { inventoryLevel prices { quantity price currency } } }
      similarParts { mpn manufacturer { name } }
    } }
  }
}`

async function lookup(token: string, mpn: string) {
  const res = await fetch('https://api.nexar.com/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: QUERY, variables: { q: mpn } }),
  })
  if (!res.ok) return { mpn, error: `HTTP ${res.status}` }
  const j = await res.json()
  const part = j?.data?.supSearchMpn?.results?.[0]?.part
  if (!part) return { mpn, found: false }
  const bestOffer = (part.sellers ?? []).flatMap((s: any) =>
    (s.offers ?? []).map((o: any) => ({ seller: s.company?.name, stock: o.inventoryLevel, price: o.prices?.[0]?.price })))
    .filter((o: any) => o.stock > 0).sort((a: any, b: any) => (a.price ?? 1e9) - (b.price ?? 1e9))[0]
  return {
    mpn: part.mpn, found: true,
    manufacturer: part.manufacturer?.name,
    stock: part.totalAvailQty ?? bestOffer?.stock ?? 0,
    priceUsd: part.medianPrice1000?.price ?? bestOffer?.price ?? null,
    seller: bestOffer?.seller ?? null,
    alternates: (part.similarParts ?? []).slice(0, 3).map((p: any) => p.mpn),
  }
}

export async function POST(req: Request) {
  let mpns: string[] = []
  try { mpns = (await req.json()).mpns } catch { /* */ }
  mpns = (Array.isArray(mpns) ? mpns : []).filter(Boolean).slice(0, 40)
  if (!mpns.length) return Response.json({ error: 'no mpns' }, { status: 400 })

  const token = await nexarToken()
  if (!token) {
    return Response.json({ configured: false,
      note: 'live lookup not configured — set NEXAR_CLIENT_ID + NEXAR_CLIENT_SECRET (or NEXAR_TOKEN) in .env.local' })
  }
  try {
    const results = await Promise.all(mpns.map((m) => lookup(token, m).catch((e) => ({ mpn: m, error: String(e?.message ?? e).slice(0, 80) }))))
    return Response.json({ configured: true, results })
  } catch (e: any) {
    return Response.json({ error: 'lookup failed', detail: String(e?.message ?? e).slice(0, 200) }, { status: 500 })
  }
}
