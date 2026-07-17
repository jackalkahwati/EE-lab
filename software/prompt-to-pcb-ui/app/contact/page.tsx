'use client'

/**
 * Public "Talk to us" contact form for Studio & Enterprise leads. Reads ?plan=
 * to prefill which tier they're asking about. Posts to /api/contact, which
 * stores the lead, notifies the team, and auto-replies with a booking link.
 */
import { Suspense, useEffect, useState } from 'react'

function ContactForm() {
  const [plan, setPlan] = useState('')
  const [sent, setSent] = useState(false)
  const [booking, setBooking] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('plan') || ''
    setPlan(p)
  }, [])

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')
    setBusy(true)
    const f = new FormData(e.currentTarget)
    try {
      const r = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: f.get('name'),
          email: f.get('email'),
          company: f.get('company'),
          plan: f.get('plan'),
          message: f.get('message'),
          website: f.get('website'), // honeypot
        }),
      })
      const d = await r.json()
      if (r.ok && d.ok) {
        setBooking(d.booking || '')
        setSent(true)
      } else setError(d.error || 'Something went wrong. Try again.')
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <div className="rounded-xl border border-border p-6 text-center">
        <h2 className="text-lg font-semibold">Thanks — we&rsquo;ll be in touch.</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {booking
            ? 'Want to skip the wait? Grab a time that works for you below.'
            : 'We got your note and will reach out shortly.'}
        </p>
        {booking && (
          <a href={booking} target="_blank" rel="noreferrer"
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            Book a time now
          </a>
        )}
        <div className="mt-4">
          <a href="/" className="text-sm text-primary hover:underline">Back to FirstLight</a>
        </div>
      </div>
    )
  }

  const label = plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : ''

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-muted-foreground">Name</span>
          <input name="name" required autoComplete="name"
            className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-primary/60" />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">Work email</span>
          <input name="email" type="email" required autoComplete="email"
            className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-primary/60" />
        </label>
      </div>
      <label className="block text-sm">
        <span className="text-muted-foreground">Company</span>
        <input name="company" autoComplete="organization"
          className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-primary/60" />
      </label>
      <label className="block text-sm">
        <span className="text-muted-foreground">What are you building?</span>
        <textarea name="message" rows={4}
          className="mt-1 w-full resize-y rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-primary/60" />
      </label>
      <input type="hidden" name="plan" value={plan} />
      {/* honeypot — bots fill this; humans never see it */}
      <input type="text" name="website" tabIndex={-1} autoComplete="off"
        className="absolute left-[-9999px]" aria-hidden="true" />

      {error && <p className="text-sm text-red-500">{error}</p>}

      <button type="submit" disabled={busy}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
        {busy ? 'Sending…' : `Talk to us${label ? ` about ${label}` : ''}`}
      </button>
    </form>
  )
}

export default function ContactPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-14">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Talk to us</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Tell us what you&rsquo;re building and we&rsquo;ll get you set up — Studio
          seats for a team, or a private Enterprise deployment.
        </p>
      </header>
      <Suspense>
        <ContactForm />
      </Suspense>
    </main>
  )
}
