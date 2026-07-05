import { NextRequest, NextResponse } from 'next/server'
import { CREDIT_PACKS, creditsAvailable, getUser, PLAN_CREDITS, sessionEmail } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const email = sessionEmail(req)
  if (!email) return NextResponse.json({ user: null })
  const rec = getUser(email)
  if (!rec) return NextResponse.json({ user: null })
  return NextResponse.json({
    user: {
      email: rec.email,
      plan: rec.plan,
      credits: creditsAvailable(rec),
      monthlyCredits: PLAN_CREDITS[rec.plan],
    },
    packs: CREDIT_PACKS.map((p) => ({ id: p.id, credits: p.credits, cents: p.cents })),
  })
}
