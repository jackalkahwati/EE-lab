/**
 * Google sign-in, step 2: exchange the code, verify the identity, open a
 * session. The id_token arrives directly from Google over TLS during the
 * code exchange, so its payload is trusted after aud + email_verified checks.
 */
import { NextRequest, NextResponse } from 'next/server'
import { authSecret, makeSession, sessionCookieHeader, upsertOAuthUser } from '@/lib/auth'

export const dynamic = 'force-dynamic'

function fail(req: NextRequest, code: string) {
  const url = req.nextUrl.clone()
  url.pathname = '/login'
  url.search = `?error=${code}`
  return NextResponse.redirect(url)
}

export async function GET(req: NextRequest) {
  try {
    authSecret()
  } catch {
    return fail(req, 'auth-not-configured')
  }
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) return fail(req, 'google-not-configured')

  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  const cookieState = req.cookies.get('fl_oauth_state')?.value
  if (!code || !state || !cookieState || state !== cookieState) {
    return fail(req, 'google-state-mismatch')
  }

  const origin = process.env.APP_URL || req.nextUrl.origin
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `${origin}/api/auth/google/callback`,
      grant_type: 'authorization_code',
    }).toString(),
  })
  const tokens = await tokenRes.json()
  if (!tokenRes.ok || !tokens.id_token) return fail(req, 'google-exchange-failed')

  // decode the id_token payload (JWT middle segment)
  let claims: {
    aud?: string | string[]
    email?: string
    email_verified?: boolean
    exp?: number
    iss?: string
  }
  try {
    const payload = String(tokens.id_token).split('.')[1]
    claims = JSON.parse(
      Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    )
  } catch {
    return fail(req, 'google-bad-token')
  }
  const audienceOk = Array.isArray(claims.aud)
    ? claims.aud.includes(clientId)
    : claims.aud === clientId
  const issuerOk = claims.iss === 'accounts.google.com' || claims.iss === 'https://accounts.google.com'
  const expiryOk = typeof claims.exp === 'number' && claims.exp * 1000 > Date.now()
  if (!audienceOk || !issuerOk || !expiryOk || !claims.email || claims.email_verified !== true) {
    return fail(req, 'google-identity-rejected')
  }

  const rec = upsertOAuthUser(claims.email, 'google')
  let rawNext = '/'
  try {
    rawNext = decodeURIComponent(req.cookies.get('fl_next')?.value ?? '/')
  } catch {
    // Ignore a malformed navigation cookie and return to the app root.
  }
  const nextPath = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/'
  const qIdx = nextPath.indexOf('?')
  const url = req.nextUrl.clone()
  url.pathname = qIdx >= 0 ? nextPath.slice(0, qIdx) : nextPath
  url.search = qIdx >= 0 ? nextPath.slice(qIdx) : ''
  const res = NextResponse.redirect(url)
  res.headers.append('Set-Cookie', sessionCookieHeader(makeSession(rec.email)))
  res.headers.append('Set-Cookie', 'fl_oauth_state=; Path=/; HttpOnly; Max-Age=0')
  res.headers.append('Set-Cookie', 'fl_next=; Path=/; HttpOnly; Max-Age=0')
  return res
}
