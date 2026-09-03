/**
 * Stripe webhook: flips the account to Pro on completed checkout.
 *
 * Signature verification uses STRIPE_WEBHOOK_SECRET (whsec_...) per Stripe's
 * v1 scheme (HMAC-SHA256 over `${t}.${payload}`). Without the secret set the
 * endpoint refuses, never trust an unsigned upgrade request.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { findUserByStripeCustomer, grantCreditsOnce, updateUser, type Plan, type UserRecord } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// Warn LOUDLY, once per process, when the webhook is unconfigured: every Stripe
// delivery 503s until STRIPE_WEBHOOK_SECRET is set, so subscriptions/top-ups
// silently stop applying. Fires at module load and again on the first hit.
let warnedUnconfigured = false
function warnUnconfigured(where: string) {
  if (warnedUnconfigured) return
  warnedUnconfigured = true
  console.error(
    `[billing/webhook] STRIPE_WEBHOOK_SECRET is not set (${where}) — refusing every Stripe event with 503. `
    + 'Paid upgrades, credit packs, payment failures and cancellations will NOT be applied until it is configured.',
  )
}
if (!process.env.STRIPE_WEBHOOK_SECRET) warnUnconfigured('startup')

/** Apply `fn` to the account behind a Stripe customer id exactly once per
 *  Stripe event id (deliveries are retried; a second delivery is a no-op). */
function applyOnceForCustomer(customer: string, eventId: string, fn: (u: UserRecord) => void): boolean {
  const rec = findUserByStripeCustomer(customer)
  if (!rec || !eventId) return false
  let applied = false
  updateUser(rec.email, (u) => {
    u.processedStripeEvents ??= []
    if (u.processedStripeEvents.includes(eventId)) return
    fn(u)
    u.processedStripeEvents.push(eventId)
    if (u.processedStripeEvents.length > 200) u.processedStripeEvents.splice(0, u.processedStripeEvents.length - 200)
    applied = true
  })
  return applied
}

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
    warnUnconfigured('first webhook hit')
    return NextResponse.json({ error: 'webhook not configured' }, { status: 503 })
  }
  const payload = await req.text()
  if (!verify(payload, req.headers.get('stripe-signature'), secret)) {
    return NextResponse.json({ error: 'bad signature' }, { status: 400 })
  }

  let event: { id?: string; type?: string; data?: { object?: Record<string, unknown> } }
  try {
    event = JSON.parse(payload)
  } catch {
    return NextResponse.json({ error: 'bad payload' }, { status: 400 })
  }
  const eventId = String(event.id ?? '')

  // Payment failed on a subscription invoice → mark past_due. The plan is
  // KEPT while Stripe runs its retry schedule; a subscription that Stripe
  // finally gives up on arrives as customer.subscription.updated (status
  // unpaid/canceled) or .deleted, which downgrades below. Idempotent per event.
  if (event.type === 'invoice.payment_failed') {
    const obj = event.data?.object ?? {}
    const customer = String(obj.customer ?? '')
    // invoice.subscription (API < 2025-03-31) or parent.subscription_details
    // .subscription (newer API versions) — accept both shapes.
    const subscription = obj.subscription
      ?? (obj.parent as { subscription_details?: { subscription?: unknown } } | undefined)?.subscription_details?.subscription
    if (customer && subscription) {
      applyOnceForCustomer(customer, eventId, (u) => {
        u.billingStatus = 'past_due'
      })
    }
  }
  // Subscription state sync (renewal, recovery after a failed payment, plan
  // change, Stripe-side cancellation): mirror Stripe's status onto the account.
  if (event.type === 'customer.subscription.updated') {
    const obj = event.data?.object ?? {}
    const customer = String(obj.customer ?? '')
    const status = String(obj.status ?? '')
    if (customer && status) {
      applyOnceForCustomer(customer, eventId, (u) => {
        if (status === 'active' || status === 'trialing') {
          u.billingStatus = 'active'
          // manual Studio/Enterprise grants are never demoted to Pro by a sync
          if (u.plan === 'free') u.plan = 'pro' as Plan
        } else if (status === 'past_due' || status === 'unpaid') {
          u.billingStatus = 'past_due'
        } else if (status === 'canceled' || status === 'incomplete_expired') {
          u.plan = 'free'
          delete u.billingStatus
        }
      })
    }
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
  // subscription cancelled → back to free (idempotent per event)
  if (event.type === 'customer.subscription.deleted') {
    const obj = event.data?.object ?? {}
    const customer = String(obj.customer ?? '')
    if (customer) {
      applyOnceForCustomer(customer, eventId, (u) => {
        u.plan = 'free'
        delete u.billingStatus
      })
    }
  }

  return NextResponse.json({ received: true })
}
