export type EnterpriseReadError = { kind: 'auth' | 'membership' | 'network'; message: string }

export class EnterpriseReadFailure extends Error {
  kind: EnterpriseReadError['kind']
  constructor(kind: EnterpriseReadError['kind'], message: string) {
    super(message)
    this.kind = kind
  }
}

/** Read-only workspace request. HTTP failures must not become an empty workspace. */
export async function readEnterprise(signal: AbortSignal, request: typeof fetch = fetch): Promise<Record<string, any>> {
  const response = await request('/api/enterprise', { cache: 'no-store', signal })
  const data = await response.json().catch(() => null)
  if (response.status === 401) throw new EnterpriseReadFailure('auth', 'Sign in required')
  if (response.status === 403) throw new EnterpriseReadFailure('membership', 'Enterprise membership required')
  if (!response.ok) throw new EnterpriseReadFailure('network', `Workspace request failed (HTTP ${response.status}). Try again.`)
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) {
    throw new EnterpriseReadFailure('network', 'The workspace response could not be loaded. Try again.')
  }
  return data
}
