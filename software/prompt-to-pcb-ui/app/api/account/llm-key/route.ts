/**
 * Per-account BYOK key management. The key is stored encrypted (AES-256-GCM
 * under AUTH_SECRET) on the user record and is NEVER returned by any
 * endpoint — GET reports provider + last4 only. Deleting is immediate.
 */
import { getUser, sessionEmail } from '@/lib/auth'
import { clearAccountLlmKey, describeAccountLlmKey, setAccountLlmKey } from '@/lib/byok'

export const dynamic = 'force-dynamic'

function requireUser(req: Request) {
  const email = sessionEmail(req)
  if (!email) return null
  return getUser(email) ? email : null
}

export async function GET(req: Request) {
  const email = requireUser(req)
  if (!email) return Response.json({ error: 'sign in required' }, { status: 401 })
  const u = getUser(email)!
  return Response.json({ key: describeAccountLlmKey(u) })
}

export async function PUT(req: Request) {
  const email = requireUser(req)
  if (!email) return Response.json({ error: 'sign in required' }, { status: 401 })
  let body: { provider?: string; key?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'bad json body' }, { status: 400 })
  }
  if (!body.key?.trim()) return Response.json({ error: 'key required' }, { status: 400 })
  try {
    const stored = setAccountLlmKey(email, body.provider ?? 'anthropic', body.key)
    return Response.json({ ok: true, key: { provider: stored.provider, last4: stored.last4, addedAt: stored.addedAt } })
  } catch (e) {
    return Response.json({ error: String(e instanceof Error ? e.message : e) }, { status: 400 })
  }
}

export async function DELETE(req: Request) {
  const email = requireUser(req)
  if (!email) return Response.json({ error: 'sign in required' }, { status: 401 })
  clearAccountLlmKey(email)
  return Response.json({ ok: true })
}
