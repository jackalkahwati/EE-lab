import { NextRequest, NextResponse } from 'next/server'

/**
 * Account gate: every page and API (and all run artifacts — they're user
 * data) requires a valid signed session, except the login page and auth
 * endpoints. Verifies the fl_session cookie signature at the edge:
 *   base64url(email)|expiresMs|hmacSHA256(payload, AUTH_SECRET)
 * matching lib/auth.ts. Replaces the old single-password FL_PASSWORD gate.
 */

const PUBLIC_PATTERNS = [
  /^\/login$/,
  /^\/api\/auth\//,
  /^\/api\/billing\/webhook$/, // Stripe calls this unauthenticated (signed payload)
  /^\/icon/,
  /^\/apple-icon/,
  /^\/favicon/,
]

function secret(): string {
  return process.env.AUTH_SECRET || process.env.FL_PASSWORD || 'firstlight-dev-secret'
}

function b64url(buf: ArrayBuffer): string {
  let s = ''
  const bytes = new Uint8Array(buf)
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function validSession(token: string | undefined): Promise<boolean> {
  if (!token) return false
  const parts = token.split('|')
  if (parts.length !== 3) return false
  if (Number(parts[1]) < Date.now()) return false
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${parts[0]}|${parts[1]}`),
  )
  return b64url(sig) === parts[2]
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  if (PUBLIC_PATTERNS.some((p) => p.test(pathname))) return NextResponse.next()

  if (await validSession(req.cookies.get('fl_session')?.value)) {
    return NextResponse.next()
  }

  // APIs answer 401 (EventSource/fetch callers need a status, not a redirect)
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'sign in required' }, { status: 401 })
  }
  const url = req.nextUrl.clone()
  const dest = req.nextUrl.pathname + req.nextUrl.search
  url.pathname = '/login'
  url.search = dest && dest !== '/' ? `?next=${encodeURIComponent(dest)}` : ''
  return NextResponse.redirect(url)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
}
