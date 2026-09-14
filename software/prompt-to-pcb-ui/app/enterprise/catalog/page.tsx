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

type CapabilityEntry = { family: string; tier: number; evidence_state: string; run_evidence?: string[] }
type RegistryState =
  | { status: 'loading' }
  | { status: 'ready'; entries: CapabilityEntry[] }
  | { status: 'missing' | 'error'; message: string }

function isCapabilityEntry(value: unknown): value is CapabilityEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.family === 'string' && typeof entry.tier === 'number'
    && typeof entry.evidence_state === 'string'
    && (entry.run_evidence === undefined || (Array.isArray(entry.run_evidence)
      && entry.run_evidence.every(item => typeof item === 'string')))
}

// Stable board-program drafts (C7). /start handles the private fragment handoff.
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
  const [registry, setRegistry] = useState<RegistryState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let current = true
    let timedOut = false
    setRegistry({ status: 'loading' })
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 15000)
    async function load() {
      try {
        const response = await fetch('/runs/fl1-backplane-v1/data/compose-package-capability-registry.json', {
          cache: 'no-store', signal: controller.signal,
        })
        if (response.status === 404) {
          if (current) setRegistry({ status: 'missing', message: 'The capability registry is not available. Templates are still available above.' })
          return
        }
        if (!response.ok) throw new Error(`Capability registry request failed (HTTP ${response.status}).`)
        const data: unknown = await response.json()
        if (!data || typeof data !== 'object' || !('entries' in data)
          || !Array.isArray(data.entries) || !data.entries.every(isCapabilityEntry)) {
          throw new Error('The capability registry response could not be read.')
        }
        controller.signal.throwIfAborted()
        if (current) setRegistry({ status: 'ready', entries: data.entries })
      } catch {
        if (current) setRegistry({ status: 'error', message: timedOut
          ? 'The capability registry took too long to respond. Try again.'
          : 'Could not load the capability registry. Check your connection and try again.' })
      } finally { clearTimeout(timeout) }
    }
    void load()
    return () => { current = false; clearTimeout(timeout); controller.abort() }
  }, [attempt])

  const entries = registry.status === 'ready' ? registry.entries : []
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
            <Link key={t.name} href={`/start#prompt=${encodeURIComponent(t.prompt)}`} prefetch={false}
              className="flex flex-col rounded-md border border-border bg-card/40 p-3 transition-colors hover:border-primary/40 hover:bg-primary/5">
              <span className="text-xs font-semibold leading-tight">{t.name}</span>
              <span className="mt-1 flex-1 text-[10px] text-muted-foreground">{t.cls}</span>
              <span className="mt-2 font-mono text-[9px] text-primary">start in Compose →</span>
            </Link>
          ))}
        </div>
        <p className="mt-1.5 text-[9px] text-muted-foreground">
          Templates open a draft for review in Compose. Nothing is submitted until
          you choose to start. Unsupported variants still block at the existing gates.
        </p>
      </div>

      {/* Component & package capability */}
      <div className="mb-4">
        <h2 className="mb-2 text-xs font-semibold">
          Component &amp; package capability
          {entries.length > 0 && <span className="ml-2 font-mono text-[10px] text-muted-foreground">{entries.length} families</span>}
        </h2>
        {registry.status === 'loading' && (
          <p role="status" className="rounded-md border border-border p-3 text-muted-foreground">Loading capability registry…</p>
        )}
        {(registry.status === 'missing' || registry.status === 'error') && (
          <div className="rounded-md border border-border p-3">
            <p role={registry.status === 'error' ? 'alert' : 'status'} className="text-muted-foreground">{registry.message}</p>
            <button type="button" onClick={() => setAttempt(value => value + 1)}
              className="mt-2 rounded-sm bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
              Try again
            </button>
          </div>
        )}
        {registry.status === 'ready' && entries.length === 0 && (
          <p className="rounded-md border border-border p-3 text-muted-foreground">No capability families are listed in this registry.</p>
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
                      <div className="font-mono text-[11px] break-words">{e.family}</div>
                      <div className={cn('font-mono text-[9px]', EVIDENCE_STYLE[e.evidence_state] ?? 'text-muted-foreground')}>
                        {e.evidence_state?.replace(/_/g, ' ')}
                      </div>
                      {e.run_evidence && e.run_evidence.length > 0 && (
                        <div className="mt-0.5 text-[9px] text-muted-foreground break-words">evidence: {e.run_evidence.join(', ')}</div>
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
