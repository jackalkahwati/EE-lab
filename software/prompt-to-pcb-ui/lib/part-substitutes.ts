/**
 * Sourcing auto-substitution. For BOM lines the sourcing engine left `generic`
 * (placeholder passives) or `no-match` (couldn't resolve to a real MPN), suggest
 * a concrete, real part. HONESTY: suggestions are well-known real parts or
 * standard series — never invented MPNs; where nothing can be verified we say
 * "needs engineer selection" rather than guess. Nothing is auto-ordered; a human
 * confirms the substitution.
 */
export type Sourcing = {
  ref: string; part: string; status: string
  ok: boolean            // already in-stock with a real MPN
  suggest?: string       // the substitution (real MPN / series) or review note
  confidence?: 'drop-in' | 'series' | 'review'
}

// well-known chips → a real, verifiable drop-in (MPN; LCSC only where certain)
const KNOWN: { re: RegExp; sub: string; conf: 'drop-in' }[] = [
  { re: /RP2040/i, sub: 'Raspberry Pi RP2040 · LCSC C2040 (QFN-56)', conf: 'drop-in' },
  { re: /W25Q16/i, sub: 'Winbond W25Q16JVSSIQ (16 Mb SPI flash, SOIC-8) — verify stock', conf: 'drop-in' },
  { re: /W25Q(32|64|128)/i, sub: 'Winbond W25Q-series JVSSIQ (SOIC-8) — verify capacity/stock', conf: 'drop-in' },
  { re: /24LC02/i, sub: 'Microchip 24LC02B-I/SN (2 Kb I²C EEPROM) — verify stock', conf: 'drop-in' },
  { re: /ULN2803/i, sub: 'TI ULN2803A / equivalent Darlington array — verify stock', conf: 'drop-in' },
  { re: /74HC595/i, sub: 'Nexperia 74HC595PW,118 — verify stock', conf: 'drop-in' },
]

// package/class placeholders → the standard jellybean series (value chosen by EE)
const PASSIVE: { re: RegExp; sub: string; conf: 'series' }[] = [
  { re: /Resistor 0402/i, sub: 'Yageo RC0402 thick-film 1% (choose value)', conf: 'series' },
  { re: /Resistor 0603/i, sub: 'Yageo RC0603 thick-film 1% (choose value)', conf: 'series' },
  { re: /Capacitor 0402/i, sub: 'Samsung CL05 / Murata GRM155 X7R (choose value + voltage)', conf: 'series' },
  { re: /Capacitor 0603/i, sub: 'Samsung CL10 / Murata GRM188 X7R (choose value + voltage)', conf: 'series' },
  { re: /Pin header 2\.?54/i, sub: 'Amphenol/DNP 2.54mm header (choose pin count)', conf: 'series' },
  { re: /Crystal/i, sub: 'Abracon ABM8 / ECS SMD crystal (choose frequency + load)', conf: 'series' },
  { re: /(TestPoint|fiducial|MountingHole)/i, sub: 'bare copper/pad — no purchased part needed', conf: 'series' },
]

export function resolveSourcing(bom: any[]): Sourcing[] {
  return (bom ?? []).map((l) => {
    const part = String(l.part ?? '')
    const base = { ref: String(l.ref ?? ''), part, status: String(l.sourcingStatus ?? 'unknown') }
    if (l.sourcingStatus === 'in-stock') return { ...base, ok: true }
    const k = KNOWN.find((x) => x.re.test(part))
    if (k) return { ...base, ok: false, suggest: k.sub, confidence: k.conf }
    const p = PASSIVE.find((x) => x.re.test(part))
    if (p) return { ...base, ok: false, suggest: p.sub, confidence: p.conf }
    return { ...base, ok: false, suggest: 'no verified catalog match — needs engineer selection', confidence: 'review' }
  })
}
