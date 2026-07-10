/**
 * Google sign-in, step 1: redirect to Google's consent screen.
 *
 * Env (both required to enable the button):
 *   GOOGLE_CLIENT_ID      ...apps.googleusercontent.com  (Web application type)
 *   GOOGLE_CLIENT_SECRET  GOCSPX-...
 * The OAuth client's authorized redirect URI must be
 *   <APP_URL>/api/auth/google/callback   (e.g. http://localhost:4500/api/auth/google/callback)
 *
 * Without creds this bounces back to /login with a readable error instead of
 * a dead button. CSRF: a random state value rides an HttpOnly cookie and is
 * checked in the callback.
 */
import { randomBytes } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { authSecret } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    authSecret()
  } catch {
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    url.search = '?error=auth-not-configured'
    return NextResponse.redirect(url)
  }
  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) {
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    url.search = '?error=google-not-configured'
    return NextResponse.redirect(url)
  }

  const origin = process.env.APP_URL || req.nextUrl.origin
  const state = randomBytes(16).toString('hex')
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  auth.searchParams.set('client_id', clientId)
  auth.searchParams.set('redirect_uri', `${origin}/api/auth/google/callback`)
  auth.searchParams.set('response_type', 'code')
  auth.searchParams.set('scope', 'openid email')
  auth.searchParams.set('state', state)
  auth.searchParams.set('prompt', 'select_account')

  const nextParam = req.nextUrl.searchParams.get('next') ?? '/'
  const safeNext =
    nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/'
  const res = NextResponse.redirect(auth)
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  res.headers.append(
    'Set-Cookie',
    `fl_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
  )
  res.headers.append(
    'Set-Cookie',
    `fl_next=${encodeURIComponent(safeNext)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
  )
  return res
}
