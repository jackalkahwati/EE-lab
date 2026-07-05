/**
 * Stripe webhook: flips the account to Pro on completed checkout.
 *
 * Signature verification uses STRIPE_WEBHOOK_SECRET (whsec_...) per Stripe's
 * v1 scheme (HMAC-SHA256 over `${t}.${payload}`). Without the secret set the
 * endpoint refuses, never trust an unsigned upgrade request.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { grantCredits, updateUser } from '@/lib/auth'

export const dynamic = 'force-dynamic'

function verify(payload: string, sigHeader: string | null, secret: string): boolean {
  if (!sigHeader) return false
  const parts = Object.fromEntries(
    sigHeader.split(',').map((kv) => kv.split('=') as [string, string]),
  )
  const t = parts.t
  const v1 = parts.v1
  if (!t || !v1) return false
  const expect = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')
  const a = Buffer.from(expect)
  const b = Buffer.from(v1)
  return a.length === b.length && timingSafeEqual(a, b)
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

  if (event.type === 'checkout.session.completed') {
    const obj = event.data?.object ?? {}
    const email =
      (obj.client_reference_id as string) ||
      ((obj.customer_details as Record<string, unknown>)?.email as string) ||
      (obj.customer_email as string)
    const meta = (obj.metadata as Record<string, unknown>) ?? {}
    const credits = Number(meta.credits ?? 0)
    if (email && obj.mode === 'payment' && credits > 0) {
      grantCredits(email, credits) // one-time credit top-up
    } else if (email) {
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
