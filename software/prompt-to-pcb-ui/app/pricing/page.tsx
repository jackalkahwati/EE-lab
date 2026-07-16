'use client'

/**
 * Pricing page — renders the three tiers from lib/plans.ts. Pro kicks off the
 * Stripe subscription checkout; Enterprise opens a sales email. Free just points
 * back into the app. Prices come from the config (single source of truth).
 */
import { useState } from 'react'
import { PLANS, SALES_EMAIL, type PlanTier } from '@/lib/plans'

export default function PricingPage() {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function onCta(tier: PlanTier) {
    setError('')
    if (tier.id === 'free') {
      window.location.href = '/'
      return
    }
    if (tier.id === 'enterprise') {
      window.location.href = `mailto:${SALES_EMAIL}?subject=${encodeURIComponent('FirstLight Enterprise inquiry')}`
      return
    }
    // Pro → Stripe subscription checkout
    setBusy(tier.id)
    try {
      const r = await fetch('/api/billing/checkout', { method: 'POST' })
      const d = await r.json()
      if (r.ok && d.url) {
        window.location.href = d.url
      } else {
        setError(d.error || 'Checkout is not available yet.')
      }
    } catch {
      setError('Could not reach checkout. Try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-12">
      <header className="mb-2 text-center">
        <h1 className="text-2xl font-semibold">Pricing</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Bring your own model key — you only pay for platform runs, never for inference.
        </p>
      </header>

      {error && (
        <p className="mx-auto mb-4 max-w-md rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-center text-sm text-red-500">
          {error}
        </p>
      )}

      <div className="mt-8 grid gap-5 md:grid-cols-3">
        {PLANS.map((tier) => (
          <div
            key={tier.id}
            className={`flex flex-col rounded-xl border p-5 ${
              tier.featured ? 'border-primary shadow-lg' : 'border-border'
            }`}
          >
            {tier.featured && (
              <span className="mb-2 self-start rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                Most popular
              </span>
            )}
            <h2 className="text-lg font-semibold">{tier.name}</h2>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="text-3xl font-bold">{tier.price}</span>
              <span className="text-xs text-muted-foreground">{tier.cadence}</span>
            </div>
            <p className="mt-1 text-sm font-medium text-primary">{tier.runs}</p>

            <ul className="mt-4 flex-1 space-y-2 text-sm">
              {tier.features.map((f) => (
                <li key={f} className="flex gap-2">
                  <span className="text-primary">✓</span>
                  <span className="text-muted-foreground">{f}</span>
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={() => onCta(tier)}
              disabled={busy === tier.id}
              className={`mt-5 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50 ${
                tier.featured
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'border border-border hover:bg-muted'
              }`}
            >
              {busy === tier.id ? 'Redirecting…' : tier.cta}
            </button>
          </div>
        ))}
      </div>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        Prices in USD. Enterprise is a custom annual quote — {SALES_EMAIL}.
      </p>
    </main>
  )
}
