/**
 * Fab-house quote ESTIMATES. These are parametric estimates from each fab's
 * PUBLISHED pricing (board area × layer factor × quantity) — NOT live API
 * quotes (we hold no fab accounts/keys, and several fabs have no public quote
 * API). Use them to shortlist, then get a binding quote on the fab's own site
 * via the provided link. Compose never places an order.
 */
export type FabQuote = {
  id: string; name: string; region: string; url: string
  minQty: number; leadDays: number; note: string; estUsd: number
}

type FabDef = {
  id: string; name: string; region: string; url: string; minQty: number
  leadDays: number; note: string; base: number; perCm2: number
  layerMult: Record<number, number>
}

// published-pricing-derived coefficients (order-of-magnitude, for comparison)
const FABS: FabDef[] = [
  { id: 'jlcpcb', name: 'JLCPCB', region: 'CN', url: 'https://jlcpcb.com/quote', minQty: 5, leadDays: 7,
    note: 'lowest cost, fast; PCBA available', base: 2, perCm2: 0.06, layerMult: { 2: 1, 4: 2.6, 6: 5 } },
  { id: 'nextpcb', name: 'NextPCB', region: 'CN', url: 'https://www.nextpcb.com/pcb-quote', minQty: 5, leadDays: 7,
    note: 'low-cost China alternative', base: 2, perCm2: 0.06, layerMult: { 2: 1, 4: 2.5, 6: 5 } },
  { id: 'seeed', name: 'Seeed Fusion', region: 'CN', url: 'https://www.seeedstudio.com/fusion_pcb.html', minQty: 5, leadDays: 8,
    note: 'China; assembly + enclosure', base: 4.9, perCm2: 0.07, layerMult: { 2: 1, 4: 2.4, 6: 4.5 } },
  { id: 'pcbway', name: 'PCBWay', region: 'CN', url: 'https://www.pcbway.com/orderonline.aspx', minQty: 5, leadDays: 7,
    note: 'broad options, advanced stackups', base: 5, perCm2: 0.07, layerMult: { 2: 1, 4: 2.4, 6: 4.5 } },
  { id: 'lion', name: 'LION Circuits', region: 'IN', url: 'https://www.lioncircuits.com/', minQty: 5, leadDays: 9,
    note: 'India; quick-turn prototyping', base: 6, perCm2: 0.12, layerMult: { 2: 1, 4: 2.3, 6: 4 } },
  { id: 'aisler', name: 'AISLER', region: 'EU', url: 'https://aisler.net/', minQty: 3, leadDays: 10,
    note: 'EU-made, quality, 3-up', base: 0, perCm2: 0.55, layerMult: { 2: 1, 4: 2, 6: 3 } },
  { id: 'oshpark', name: 'OSH Park', region: 'US', url: 'https://oshpark.com/', minQty: 3, leadDays: 12,
    note: 'US-made, purple, 3-up; premium', base: 0, perCm2: 0.78, layerMult: { 2: 1, 4: 2, 6: 3 } },
  { id: 'macrofab', name: 'MacroFab', region: 'US', url: 'https://macrofab.com/', minQty: 1, leadDays: 12,
    note: 'US; turnkey assembly focus', base: 20, perCm2: 0.9, layerMult: { 2: 1, 4: 1.8, 6: 3 } },
]

function qtyScale(minQty: number, qty: number): number {
  if (qty <= minQty) return 1
  return 1 + ((qty - minQty) / minQty) * 0.55 // ~55% marginal per extra batch (volume discount)
}

export function quoteAll(wMm: number, hMm: number, layers: number, qty: number): FabQuote[] {
  const cm2 = (wMm / 10) * (hMm / 10)
  return FABS.map((f) => {
    const lm = f.layerMult[layers] ?? (f.layerMult[4] ?? 2) * (layers / 4)
    const est = (f.base + cm2 * f.perCm2 * lm) * qtyScale(f.minQty, qty)
    return {
      id: f.id, name: f.name, region: f.region, url: f.url,
      minQty: f.minQty, leadDays: f.leadDays, note: f.note,
      estUsd: Math.round(est * 100) / 100,
    }
  }).sort((a, b) => a.estUsd - b.estUsd)
}
