'use client'

/**
 * Catalog — the service-catalog analog. Three sections: board-program
 * TEMPLATES you can start in Compose, the COMPONENT & PACKAGE capability
 * registry (real, with honest evidence states), and COMPLIANCE export.
 * Evidence states are rendered verbatim — architecture_only / routed_in_sandbox
 * / blocked are never dressed up as built or validated.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

type Any = Record<string, any>

// Real, stable board-program templates (C7). Each starts a genuine Compose run.
const TEMPLATES = [
  { name: 'Environmental Telemetry Node', cls: 'MCU + I2C sensor + LoRa/GNSS optional', prompt: 'environmental telemetry node with an MCU, a BME280 sensor, a debug header and test points' },
  { name: 'Industrial IO Controller', cls: 'MCU + CAN/RS485 + GPIO + protection', prompt: 'industrial IO controller with an MCU, CAN transceiver, GPIO expansion, power protection and status LEDs' },
  { name: 'Lab Instrument Interface', cls: 'MCU + relay/control + ADC + board-ID', prompt: 'lab instrument interface board with an MCU, relay control outputs, an ADC current monitor, board-ID EEPROM and test points' },
  { name: 'DUT Power Monitor', cls: 'power in/out + current sense + ADC + protection', prompt: 'DUT power monitor with a power inlet, current sense resistor, voltage divider, ADC and protection' },
  { name: 'Calibration / Reference', cls: 'voltage reference + ADC + EEPROM', prompt: 'calibration reference board with a voltage reference, an ADC, EEPROM and test points' },
  { name: 'Adapter / Breakout', cls: 'connectors + power + level shifting', prompt: 'adapter breakout board with connectors, power input, level shifting and test points' },
  { name: 'Validation Coupon', cls: 'power rails + test structures', prompt: 'validation coupon board with power rails, test structures and test points' },
  { name: 'USB-FS Data Logger', cls: 'MCU + USB full-speed + sensor + storage', prompt: 'USB full-speed data logger with an MCU, a USB-C connector, a sensor and storage' },
]

const EVIDENCE_STYLE: Record<string, string> = {
  package_classified: 'text-muted-foreground',
  manufacturing_package_supported_with_review: 'text-emerald-500',
  routed_in_sandbox: 'text-sky-400',
  blocked: 'text-destructive',
  architecture_only: 'text-amber-500',
}

export default function CatalogPage() {
  const [reg, setReg] = useState<Any | null>(null)
  useEffect(() => {
    fetch('/runs/fl1-backplane-v1/data/compose-package-capability-registry.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null)).then(setReg).catch(() => setReg(null))
  }, [])

  const entries: Any[] = reg?.entries ?? []
  const byTier = [1, 2, 3].map((t) => ({ tier: t, rows: entries.filter((e) => e.tier === t) }))

  return (
    <div className="min-h-screen bg-background p-4 text-xs text-foreground">
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-base font-semibold">Catalog</h1>
        <span className="text-muted-foreground">templates · capability · compliance</span>
      </div>

      {/* Templates */}
      <div className="mb-4">
        <h2 className="mb-2 text-xs font-semibold">Board-program templates</h2>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {TEMPLATES.map((t) => (
            <Link key={t.name} href={`/compose?prompt=${encodeURIComponent(t.prompt)}`}
              className="flex flex-col rounded-md border border-border bg-card/40 p-3 transition-colors hover:border-primary/40 hover:bg-primary/5">
              <span className="text-xs font-semibold leading-tight">{t.name}</span>
              <span className="mt-1 flex-1 text-[10px] text-muted-foreground">{t.cls}</span>
              <span className="mt-2 font-mono text-[9px] text-primary">start in Compose →</span>
            </Link>
          ))}
        </div>
        <p className="mt-1.5 text-[9px] text-muted-foreground">
          Templates instantiate real Compose runs through the full gate chain —
          unsupported variants block honestly, they are not faked.
        </p>
      </div>

      {/* Component & package capability */}
      <div className="mb-4">
        <h2 className="mb-2 text-xs font-semibold">
          Component &amp; package capability
          {entries.length > 0 && <span className="ml-2 font-mono text-[10px] text-muted-foreground">{entries.length} families</span>}
        </h2>
        {entries.length === 0 && (
          <p className="rounded-md border border-border p-3 text-muted-foreground">Capability registry not loaded.</p>
        )}
        {entries.length > 0 && (
          <div className="grid gap-3 lg:grid-cols-3">
            {byTier.map(({ tier, rows }) => (
              <div key={tier} className="rounded-md border border-border">
                <div className="border-b border-border px-3 py-2 text-xs font-semibold">
                  Tier {tier}
                  <span className="ml-2 font-mono text-[9px] text-muted-foreground">
                    {tier === 1 ? 'common low-risk' : tier === 2 ? 'chip-down product' : 'advanced (gated)'}
                  </span>
                </div>
                <div className="max-h-72 divide-y divide-border overflow-y-auto">
                  {rows.map((e) => (
                    <div key={e.family} className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{e.family}</span>
                        <span className={cn('shrink-0 font-mono text-[9px]', EVIDENCE_STYLE[e.evidence_state] ?? 'text-muted-foreground')}>
                          {e.evidence_state?.replace(/_/g, ' ')}
                        </span>
                      </div>
                      {e.run_evidence?.length > 0 && (
                        <div className="truncate text-[9px] text-muted-foreground">evidence: {e.run_evidence.join(', ')}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Compliance export */}
      <div>
        <h2 className="mb-2 text-xs font-semibold">Compliance &amp; evidence export</h2>
        <div className="rounded-md border border-border p-3 text-[11px] text-muted-foreground">
          Every board exports a review-required evidence pack (intent → copper →
          DRC/ERC → package → validation workflow → blocked claims) from its
          detail page. Org- and program-level compliance bundles aggregate those
          packs and are available to <span className="font-mono text-foreground">security_auditor</span>.
          Nothing in a pack asserts physical validation unless real evidence
          exists in the ledger.
        </div>
      </div>
    </div>
  )
}
