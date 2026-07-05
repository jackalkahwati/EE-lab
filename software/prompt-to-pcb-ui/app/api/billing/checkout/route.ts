/**
 * Stripe Checkout for the Pro plan. Dependency-free (Stripe REST API).
 *
 * Env (all optional until payments launch):
 *   STRIPE_SECRET_KEY   sk_live_... / sk_test_...
 *   STRIPE_PRICE_ID     price_... for the Pro subscription
 *   APP_URL             public base URL for redirect back (default req origin)
 *
 * Without keys this answers with a clear "not configured" message, the
 * upgrade button works the moment the two env vars exist.
 */
import { NextRequest, NextResponse } from 'next/server'
import { sessionEmail } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const email = sessionEmail(req)
  if (!email) return NextResponse.json({ error: 'sign in required' }, { status: 401 })

  const key = process.env.STRIPE_SECRET_KEY
  const price = process.env.STRIPE_PRICE_ID
  if (!key || !price) {
    return NextResponse.json(
      {
        error:
          'Payments are not configured on this deployment yet (private preview). ' +
          'Contact the FirstLight team for Pro access.',
      },
      { status: 503 },
    )
  }

  const origin = process.env.APP_URL || req.nextUrl.origin
  const form = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': price,
    'line_items[0][quantity]': '1',
    customer_email: email,
    client_reference_id: email,
    cancel_url: `${origin}/`,
  })
  // {CHECKOUT_SESSION_ID} is a literal Stripe placeholder, append raw so it
  // isn't URL-encoded into uselessness.
  const body =
    form.toString() +
    `&success_url=${encodeURIComponent(`${origin}/?session_id=`)}{CHECKOUT_SESSION_ID}`

  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  const d = await r.json()
  if (!r.ok || !d.url) {
    return NextResponse.json(
      { error: `stripe error: ${d.error?.message ?? r.status}` },
      { status: 502 },
    )
  }
  return NextResponse.json({ url: d.url })
}
