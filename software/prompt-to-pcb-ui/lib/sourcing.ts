/**
 * Live distributor sourcing (Phase 4) — honestly gated like lib/image-gen:
 * when no distributor key is configured every caller gets
 * {available:false, reason}, the UI says "live sourcing gated", and the
 * supply-chain doc keeps its "not live-sourced" caveat. Nothing is ever
 * quoted that didn't come from a distributor API.
 *
 * Providers (first configured wins):
 *   MOUSER_API_KEY   — Mouser Search API (free key, REST)
 *   NEXAR_TOKEN      — Octopart/Nexar GraphQL (paid)
 * Results cache 24 h in data/sourcing-cache.json (quotes drift slowly; a
 * stale-but-dated quote beats hammering rate limits).
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

export type Offer = {
  distributor: string
  stock: number | null
  priceBreaks: { qty: number; usd: number }[]
  leadDays: number | null
  url?: string
}

export type PartQuote = {
  available: true
  provider: string
  mpn: string
  manufacturer?: string
  description?: string
  offers: Offer[]
  fetchedAt: string
} | {
  available: false
  reason: string
}

const CACHE = path.join(process.cwd(), 'data', 'sourcing-cache.json')
const TTL_MS = 24 * 3600 * 1000

export function sourcingProvider(): { name: string; key: string } | null {
  if (process.env.MOUSER_API_KEY) return { name: 'mouser', key: process.env.MOUSER_API_KEY }
  if (process.env.NEXAR_TOKEN) return { name: 'nexar', key: process.env.NEXAR_TOKEN }
  return null
}

export function gatedReason(): string {
  return 'live sourcing is install-gated — set MOUSER_API_KEY (free at mouser.com/api-hub) or NEXAR_TOKEN in .env.local'
}

async function readCache(): Promise<Record<string, PartQuote>> {
  try { return JSON.parse(await fs.readFile(CACHE, 'utf8')) } catch { return {} }
}

async function writeCache(all: Record<string, PartQuote>) {
  await fs.mkdir(path.dirname(CACHE), { recursive: true })
  await fs.writeFile(CACHE, JSON.stringify(all))
}

async function mouserLookup(mpn: string, key: string): Promise<PartQuote> {
  const r = await fetch(`https://api.mouser.com/api/v1/search/partnumber?apiKey=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ SearchByPartRequest: { mouserPartNumber: mpn, partSearchOptions: 'string' } }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) return { available: false, reason: `Mouser HTTP ${r.status}` }
  const d = await r.json()
  const parts = d?.SearchResults?.Parts ?? []
  if (!parts.length) return { available: false, reason: `no Mouser results for ${mpn}` }
  const p = parts[0]
  const breaks = (p.PriceBreaks ?? []).map((b: any) => ({
    qty: Number(b.Quantity) || 1,
    usd: Number(String(b.Price ?? '').replace(/[^0-9.]/g, '')) || 0,
  }))
  return {
    available: true,
    provider: 'mouser',
    mpn: String(p.ManufacturerPartNumber ?? mpn),
    manufacturer: p.Manufacturer ? String(p.Manufacturer) : undefined,
    description: p.Description ? String(p.Description) : undefined,
    offers: [{
      distributor: 'Mouser',
      stock: p.AvailabilityInStock != null ? Number(p.AvailabilityInStock) : null,
      priceBreaks: breaks,
      leadDays: p.LeadTime ? parseInt(String(p.LeadTime), 10) * 7 || null : null,
      url: p.ProductDetailUrl ? String(p.ProductDetailUrl) : undefined,
    }],
    fetchedAt: new Date().toISOString(),
  }
}

/** Look one MPN up (cache-first). Gated → {available:false} immediately. */
export async function lookupPart(mpn: string): Promise<PartQuote> {
  const provider = sourcingProvider()
  if (!provider) return { available: false, reason: gatedReason() }
  const key = `${provider.name}:${mpn.trim().toUpperCase()}`
  const cache = await readCache()
  const hit = cache[key]
  if (hit && hit.available && Date.now() - Date.parse(hit.fetchedAt) < TTL_MS) return hit
  let quote: PartQuote
  try {
    quote = provider.name === 'mouser'
      ? await mouserLookup(mpn, provider.key)
      : { available: false, reason: 'nexar client not wired yet — use MOUSER_API_KEY' }
  } catch (e) {
    return { available: false, reason: `lookup failed: ${String(e).slice(0, 120)}` }
  }
  if (quote.available) {
    cache[key] = quote
    await writeCache(cache)
  }
  return quote
}

/**
 * Live-sourcing block for the supply-chain doc prompt — quotes real
 * distributor numbers when a provider is configured, '' otherwise (the doc
 * then keeps its honest "not live-sourced" caveat).
 */
export async function sourcingPromptBlock(mpns: string[]): Promise<string> {
  if (!sourcingProvider() || !mpns.length) return ''
  const lines: string[] = []
  for (const mpn of mpns.slice(0, 4)) {
    const q = await lookupPart(mpn)
    if (q.available && q.offers[0]) {
      const o = q.offers[0]
      const p1 = o.priceBreaks[0]
      lines.push(`- ${q.mpn}: ${o.distributor} stock ${o.stock ?? '?'}, ` +
        `${p1 ? `$${p1.usd} @ ${p1.qty}` : 'price n/a'}${o.leadDays ? `, ~${o.leadDays}d lead` : ''} (fetched ${q.fetchedAt.slice(0, 10)})`)
    }
  }
  if (!lines.length) return ''
  return `\n\nLIVE DISTRIBUTOR DATA (real quotes, fetched from the API — use these ` +
    `numbers verbatim and cite the fetch date; do NOT add the "not live-sourced" caveat ` +
    `for these parts):\n${lines.join('\n')}`
}
