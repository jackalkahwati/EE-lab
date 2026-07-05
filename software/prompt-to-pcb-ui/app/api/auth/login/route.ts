import { NextRequest, NextResponse } from 'next/server'
import { makeSession, sessionCookieHeader, verifyUser } from '@/lib/auth'

export async function POST(req: NextRequest) {
  let body: { email?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }
  const rec = verifyUser(body.email ?? '', body.password ?? '')
  if (!rec) return NextResponse.json({ error: 'wrong email or password' }, { status: 401 })
  const res = NextResponse.json({ ok: true, email: rec.email, plan: rec.plan })
  res.headers.set('Set-Cookie', sessionCookieHeader(makeSession(rec.email)))
  return res
}
