/**
 * Client helper for real enterprise mutations. Posts to the RBAC-gated
 * dispatcher at /api/enterprise using the actual logged-in identity as the
 * actor, so permission checks and the audit trail reflect the real user.
 * Denials come back honestly ({ error, detail }) — nothing is faked.
 */
export type ActionResult = { ok?: boolean; result?: any; error?: string; detail?: string }

let cachedActor: string | null = null

export async function currentActor(): Promise<string> {
  if (cachedActor) return cachedActor
  try {
    const me = await fetch('/api/auth/me', { cache: 'no-store' }).then((r) => r.json())
    cachedActor = me?.user?.email ?? me?.email ?? 'unknown'
  } catch {
    cachedActor = 'unknown'
  }
  return cachedActor!
}

export async function enterpriseAction(action: string, params: Record<string, any>): Promise<ActionResult> {
  const actor = await currentActor()
  try {
    const res = await fetch('/api/enterprise', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, params, actor }),
    })
    return await res.json()
  } catch (e: any) {
    return { error: 'request failed', detail: String(e?.message ?? e) }
  }
}
