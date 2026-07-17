import { NextRequest, NextResponse } from 'next/server.js'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Account gate: every page and API (and all run artifacts — they're user
 * data) requires a valid signed session, except the login page and auth
 * endpoints. Verifies the fl_session cookie signature:
 *   base64url(email)|expiresMs|hmacSHA256(payload, AUTH_SECRET)
 * matching lib/auth.ts. Replaces the old single-password FL_PASSWORD gate.
 */

const PUBLIC_PATTERNS = [
  /^\/login$/,
  /^\/pricing$/, // public pricing page — prospects see plans before signing up
  /^\/api\/auth\//,
  /^\/api\/v1\//, // programmatic API — authenticated by API key in the route, not the session cookie
  /^\/api\/billing\/webhook$/, // Stripe calls this unauthenticated (signed payload)
  /^\/icon/,
  /^\/apple-icon/,
  /^\/favicon/,
]

function secret(): string | null {
  const configured = process.env.AUTH_SECRET || process.env.FL_PASSWORD
  if (configured) return configured
  return process.env.NODE_ENV === 'production' ? null : 'firstlight-dev-secret'
}

function fromB64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=')
    const raw = atob(padded)
    return Uint8Array.from(raw, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

async function validSession(token: string | undefined): Promise<string | null> {
  if (!token) return null
  const parts = token.split('|')
  if (parts.length !== 3) return null
  if (!/^\d+$/.test(parts[1])) return null
  const expiresAt = Number(parts[1])
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return null
  const authSecret = secret()
  const signature = fromB64url(parts[2])
  if (!authSecret || !signature || signature.byteLength !== 32) return null
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    new TextEncoder().encode(`${parts[0]}|${parts[1]}`),
  )
  if (!valid) return null
  const encodedEmail = fromB64url(parts[0])
  if (!encodedEmail) return null
  const email = new TextDecoder().decode(encodedEmail).trim().toLowerCase()
  return email || null
}

/** True when a run id is owned by a different account. Unowned ids are shared
 * demos. A corrupt user store fails closed; a not-yet-created store means all
 * existing runs are demos. */
function ownedByAnotherAccount(runId: string, email: string): boolean {
  try {
    const users = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'data', 'users.json'), 'utf8'),
    ) as Record<string, { email?: string; runIds?: string[] }>
    const foreign = Object.values(users).some(
      (user) => user.runIds?.includes(runId)
        && (user.email ?? '').trim().toLowerCase() !== email,
    )
    if (!foreign) return false
    // Phase 5: product-level sharing grants READ on all of its revisions.
    try {
      const products = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'data', 'products.json'), 'utf8'),
      ) as Record<string, { sharedWith?: string[]; revisions?: { runId: string }[] }>
      for (const p of Object.values(products)) {
        if ((p.sharedWith ?? []).includes(email)
            && (p.revisions ?? []).some((r) => r.runId === runId)) {
          return false
        }
      }
    } catch { /* no products store — plain ownership rules */ }
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

function hasEnterpriseMembership(email: string): boolean {
  try {
    const db = JSON.parse(
      fs.readFileSync(
        path.join(
          process.env.ENTERPRISE_STORE_DIR
            || path.join(process.cwd(), 'data', 'enterprise'),
          'store.json',
        ),
        'utf8',
      ),
    ) as { members?: { actor?: string }[] }
    return (db.members ?? []).some(
      (member) => (member.actor ?? '').trim().toLowerCase() === email,
    )
  } catch {
    return false
  }
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  // /api/run-file is reachable ONLY via the internal /runs/* rewrite below
  // (rewrites don't re-enter the proxy). A direct external hit would bypass
  // the run-ownership check, so it is unconditionally hidden.
  if (pathname.startsWith('/api/run-file/') || pathname === '/api/run-file') {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (PUBLIC_PATTERNS.some((p) => p.test(pathname))) return NextResponse.next()

  const email = await validSession(req.cookies.get('fl_session')?.value)
  if (email) {
    if (pathname === '/' || pathname === '/enterprise' || pathname.startsWith('/enterprise/')) {
      const enterpriseMember = hasEnterpriseMembership(email)
      if (pathname === '/') {
        const url = req.nextUrl.clone()
        url.pathname = enterpriseMember ? '/enterprise' : '/compose'
        return NextResponse.redirect(url)
      }
      if (!enterpriseMember) {
        const url = req.nextUrl.clone()
        url.pathname = '/compose'
        url.search = ''
        return NextResponse.redirect(url)
      }
    }
    const run = pathname.match(/^\/runs\/([^/]+)(?:\/|$)/)?.[1]
    if (run && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(run)) {
      return NextResponse.json({ error: 'invalid run id' }, { status: 400 })
    }
    if (run && ownedByAnotherAccount(run, email)) {
      return NextResponse.json({ error: 'not your board' }, { status: 403 })
    }
    if (run) {
      // Serve run artifacts through the dynamic file route: `next start` only
      // serves public/ paths that existed at build time, so artifacts written
      // AFTER a deploy (renders, boards, CAD) 404'd in production until the
      // next rebuild. The rewrite keeps /runs/... URLs while reading disk live.
      const url = req.nextUrl.clone()
      url.pathname = `/api/run-file${pathname}`
      return NextResponse.rewrite(url)
    }
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
