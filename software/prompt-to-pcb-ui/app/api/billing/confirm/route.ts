/**
 * Checkout confirmation fallback: verifies a completed Stripe Checkout
 * session server-side and flips the account to Pro.
 *
 * Why this exists alongside the webhook: webhooks need a public URL, which a
 * lab/localhost preview doesn't have. The success redirect carries
 * ?session_id=...; we retrieve that session STRAIGHT FROM STRIPE (never trust
 * the client) and upgrade only if Stripe says it's paid and the email matches
 * the signed-in user. In production the webhook does the same job first and
 * this becomes a no-op belt-and-suspenders.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getUser, grantCreditsOnce, sessionEmail, updateUser } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const email = sessionEmail(req)
  if (!email) return NextResponse.json({ error: 'sign in required' }, { status: 401 })
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return NextResponse.json({ error: 'payments not configured' }, { status: 503 })

  let body: { sessionId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }
  const sid = String(body.sessionId ?? '')
  if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(sid)) {
    return NextResponse.json({ error: 'invalid session id' }, { status: 400 })
  }

  const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sid}`, {
    headers: { Authorization: `Bearer ${key}` },
  })
  const s = await r.json()
  if (!r.ok) {
    return NextResponse.json({ error: `stripe: ${s.error?.message ?? r.status}` }, { status: 500 })
  }

  const paid = s.payment_status === 'paid' && s.status === 'complete'
  const sessionEmailAddr =
    (s.client_reference_id as string) || (s.customer_details?.email as string) || ''
  if (!paid) return NextResponse.json({ upgraded: false, reason: 'not paid' })
  if (sessionEmailAddr.toLowerCase() !== email.toLowerCase()) {
    return NextResponse.json({ upgraded: false, reason: 'session belongs to another account' }, { status: 403 })
  }

  // a credit top-up (mode=payment) carries metadata.credits; a subscription
  // (mode=subscription) upgrades the plan. Idempotent: re-confirming the same
  // session grants once (guarded by a marker below).
  const credits = Number(s.metadata?.credits ?? 0)
  if (s.mode === 'payment' && credits > 0) {
    const granted = grantCreditsOnce(email, sid, credits)
    const rec = getUser(email)
    return NextResponse.json({
      creditsAdded: granted ? credits : 0,
      alreadyProcessed: !granted,
      plan: rec?.plan,
    })
  }

  if (s.mode !== 'subscription') {
    return NextResponse.json({
      upgraded: false,
      reason: 'unsupported checkout mode',
    }, { status: 400 })
  }

  updateUser(email, (u) => {
    u.plan = 'pro'
    u.stripeCustomerId = (s.customer as string) || u.stripeCustomerId
  })
  const rec = getUser(email)
  return NextResponse.json({ upgraded: true, plan: rec?.plan })
}
