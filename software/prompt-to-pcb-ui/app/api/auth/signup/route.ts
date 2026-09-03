import { randomBytes } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  authSecret,
  createUser,
  getUser,
  makeSession,
  passwordMatches,
  sessionCookieHeader,
} from '@/lib/auth'

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
  const email = String(body.email ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')
  const rec = createUser(email, password)
  if ('error' in rec) {
    // Account enumeration: "already exists" must be indistinguishable from
    // success. Same status + body shape; the only difference is whether a
    // session cookie is issued. If the caller actually owns the account (the
    // supplied password matches) this doubles as a sign-in; otherwise the
    // redirect lands on the login page. The scrypt compare also keeps timing
    // level with the create path.
    const existing = /already exists/.test(rec.error) ? getUser(email) : null
    if (existing) {
      // no plan in either body: a paid plan on an "existing" reply would leak it
      const res = NextResponse.json({ ok: true, email: existing.email })
      if (passwordMatches(existing, password)) {
        res.headers.set('Set-Cookie', sessionCookieHeader(makeSession(existing.email)))
      } else {
        // Decoy cookie of identical shape (random signature): the presence of
        // Set-Cookie must not be the oracle either. readSession rejects it on
        // HMAC, so "using" it is no better than a login attempt.
        const decoy = `${Buffer.from(email).toString('base64url')}|${Date.now() + 30 * 24 * 3600 * 1000}|v0|${randomBytes(32).toString('base64url')}`
        res.headers.set('Set-Cookie', sessionCookieHeader(decoy))
      }
      return res
    }
    return NextResponse.json({ error: rec.error }, { status: 400 })
  }
  const res = NextResponse.json({ ok: true, email: rec.email })
  res.headers.set('Set-Cookie', sessionCookieHeader(makeSession(rec.email)))
  return res
}
