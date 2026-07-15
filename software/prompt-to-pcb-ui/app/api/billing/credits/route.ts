/**
 * One-time credit top-up checkout. Buys a CREDIT_PACK via Stripe Checkout in
 * payment mode. Priced inline (price_data) so no pre-created Stripe prices are
 * needed, the pack's credit count rides in metadata; the confirm/webhook
 * grants those credits after payment.
 */
import { NextRequest, NextResponse } from 'next/server'
import { CREDIT_PACKS, sessionEmail } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const email = sessionEmail(req)
  if (!email) return NextResponse.json({ error: 'sign in required' }, { status: 401 })
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    return NextResponse.json(
      { error: 'Payments are not configured on this deployment yet.' },
      { status: 503 },
    )
  }

  let body: { packId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }
  const pack = CREDIT_PACKS.find((p) => p.id === body.packId)
  if (!pack) return NextResponse.json({ error: 'unknown pack' }, { status: 400 })

  const origin = process.env.APP_URL || req.nextUrl.origin
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(pack.cents),
    'line_items[0][price_data][product_data][name]': `${pack.credits} FirstLight credits`,
    'line_items[0][quantity]': '1',
    customer_email: email,
    client_reference_id: email,
    'metadata[credits]': String(pack.credits),
    'metadata[email]': email,
    cancel_url: `${origin}/`,
  })
  const stripeBody =
    form.toString() +
    `&success_url=${encodeURIComponent(`${origin}/?session_id=`)}{CHECKOUT_SESSION_ID}`

  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: stripeBody,
  })
  const d = await r.json()
  if (!r.ok || !d.url) {
    return NextResponse.json(
      { error: `stripe error: ${d.error?.message ?? r.status}` },
      { status: 500 },
    )
  }
  return NextResponse.json({ url: d.url })
}
