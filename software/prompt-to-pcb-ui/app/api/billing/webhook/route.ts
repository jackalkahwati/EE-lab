/**
 * Stripe webhook: flips the account to Pro on completed checkout.
 *
 * Signature verification uses STRIPE_WEBHOOK_SECRET (whsec_...) per Stripe's
 * v1 scheme (HMAC-SHA256 over `${t}.${payload}`). Without the secret set the
 * endpoint refuses, never trust an unsigned upgrade request.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { grantCreditsOnce, updateUser } from '@/lib/auth'

export const dynamic = 'force-dynamic'

function verify(payload: string, sigHeader: string | null, secret: string): boolean {
  if (!sigHeader) return false
  const pairs = sigHeader.split(',').map((kv) => kv.trim().split('=', 2))
  const t = pairs.find(([key]) => key === 't')?.[1]
  const signatures = pairs.filter(([key]) => key === 'v1').map(([, value]) => value)
  const timestamp = Number(t)
  if (!t || !Number.isSafeInteger(timestamp) || signatures.length === 0) return false
  // Stripe recommends rejecting old signed payloads to limit replay attacks.
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 5 * 60) return false
  const expect = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')
  const a = Buffer.from(expect)
  return signatures.some((signature) => {
    const b = Buffer.from(signature)
    return a.length === b.length && timingSafeEqual(a, b)
  })
}

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'webhook not configured' }, { status: 503 })
  }
  const payload = await req.text()
  if (!verify(payload, req.headers.get('stripe-signature'), secret)) {
    return NextResponse.json({ error: 'bad signature' }, { status: 400 })
  }

  let event: { type?: string; data?: { object?: Record<string, unknown> } }
  try {
    event = JSON.parse(payload)
  } catch {
    return NextResponse.json({ error: 'bad payload' }, { status: 400 })
  }

  if (
    event.type === 'checkout.session.completed'
    || event.type === 'checkout.session.async_payment_succeeded'
  ) {
    const obj = event.data?.object ?? {}
    const email =
      (obj.client_reference_id as string) ||
      ((obj.customer_details as Record<string, unknown>)?.email as string) ||
      (obj.customer_email as string)
    const meta = (obj.metadata as Record<string, unknown>) ?? {}
    const credits = Number(meta.credits ?? 0)
    const sessionId = String(obj.id ?? '')
    const paid = obj.payment_status === 'paid' || event.type === 'checkout.session.async_payment_succeeded'
    if (email && obj.mode === 'payment' && paid && credits > 0 && sessionId) {
      grantCreditsOnce(email, sessionId, credits)
    } else if (
      email
      && obj.mode === 'subscription'
      && (paid || obj.payment_status === 'no_payment_required')
    ) {
      updateUser(email, (u) => {
        u.plan = 'pro'
        u.stripeCustomerId = (obj.customer as string) || u.stripeCustomerId
      })
    }
  }
  // subscription cancelled → back to free
  if (event.type === 'customer.subscription.deleted') {
    const obj = event.data?.object ?? {}
    const customer = obj.customer as string
    // linear scan is fine at preview scale
    const fs = await import('node:fs')
    const path = await import('node:path')
    try {
      const store = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'data/users.json'), 'utf8'),
      ) as Record<string, { stripeCustomerId?: string; email: string }>
      for (const rec of Object.values(store)) {
        if (rec.stripeCustomerId === customer) {
          updateUser(rec.email, (u) => {
            u.plan = 'free'
          })
        }
      }
    } catch {
      /* store unreadable, nothing to downgrade */
    }
  }

  return NextResponse.json({ received: true })
}
