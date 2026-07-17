'use client'

/**
 * Client button island for the (server-rendered) pricing page. Kept separate so
 * the page can import lib/plans (which pulls in server-only lib/auth) without
 * dragging node:fs into a client bundle. All data arrives as plain props.
 */
import { useState } from 'react'

export function PricingCta({
  tierId,
  cta,
  featured,
  salesEmail,
}: {
  tierId: string
  cta: string
  featured?: boolean
  salesEmail: string
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function onClick() {
    setError('')
    if (tierId === 'free') {
      window.location.href = '/'
      return
    }
    // Studio + Enterprise are sales-assisted (no self-serve Stripe price yet);
    // only Pro self-serves. This also prevents Studio from hitting the Pro price.
    if (tierId === 'studio' || tierId === 'enterprise') {
      const tier = tierId.charAt(0).toUpperCase() + tierId.slice(1)
      window.location.href = `mailto:${salesEmail}?subject=${encodeURIComponent(`FirstLight ${tier} inquiry`)}`
      return
    }
    setBusy(true)
    try {
      const r = await fetch('/api/billing/checkout', { method: 'POST' })
      const d = await r.json()
      if (r.ok && d.url) window.location.href = d.url
      else setError(d.error || 'Checkout is not available yet.')
    } catch {
      setError('Could not reach checkout. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-5">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className={`w-full rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50 ${
          featured
            ? 'bg-primary text-primary-foreground hover:bg-primary/90'
            : 'border border-border hover:bg-muted'
        }`}
      >
        {busy ? 'Redirecting…' : cta}
      </button>
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </div>
  )
}
