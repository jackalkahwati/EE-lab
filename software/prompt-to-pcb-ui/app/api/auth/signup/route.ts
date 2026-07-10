import { NextRequest, NextResponse } from 'next/server'
import { authSecret, createUser, makeSession, sessionCookieHeader } from '@/lib/auth'

export async function POST(req: NextRequest) {
  try {
    authSecret()
  } catch {
    return NextResponse.json({ error: 'authentication is not configured' }, { status: 503 })
  }
  let body: { email?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }
  const rec = createUser(body.email ?? '', body.password ?? '')
  if ('error' in rec) return NextResponse.json({ error: rec.error }, { status: 400 })
  const res = NextResponse.json({ ok: true, email: rec.email, plan: rec.plan })
  res.headers.set('Set-Cookie', sessionCookieHeader(makeSession(rec.email)))
  return res
}
