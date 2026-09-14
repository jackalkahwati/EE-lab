import { ASTRA_DESIGN_TEMPLATE, validateAstraArchitectRequest, type AstraArchitectRequest } from './astra-design-contract.ts'

/** Browser-safe Astra control plane. No provider credentials or inference on status checks. */
export type AstraStatus = { enabled: false } | {
  enabled: true
  transport: 'astra-beta'
  model: 'gpt-6-astra'
  billing: 'Bedrock'
  scope: 'electronics-only'
  ready: boolean
  blockers: string[]
}
export type AstraAvailability = { state: 'loading' } | { state: 'error'; error: string } | { state: 'loaded'; status: AstraStatus }
export type AstraFetch = (input: string, init?: RequestInit) => Promise<Response>

export function parseAstraStatus(data: unknown): AstraStatus {
  if (!data || typeof data !== 'object' || !('enabled' in data)) throw new Error('Invalid Astra status response.')
  if (data.enabled === false) return { enabled: false }
  const d = data as Record<string, unknown>
  if (d.enabled !== true || d.transport !== 'astra-beta' || d.model !== 'gpt-6-astra'
    || d.billing !== 'Bedrock' || d.scope !== 'electronics-only' || typeof d.ready !== 'boolean'
    || !Array.isArray(d.blockers) || !d.blockers.every((value) => typeof value === 'string')) {
    throw new Error('Invalid Astra status response.')
  }
  return d as AstraStatus
}

export async function fetchAstraStatus(fetcher: AstraFetch, signal?: AbortSignal): Promise<AstraStatus> {
  const response = await fetcher('/api/astra', { cache: 'no-store', signal })
  if (!response.ok) throw new Error(`Generation mode could not be checked (HTTP ${response.status}).`)
  return parseAstraStatus(await response.json())
}

/** Read only. Never reset the user's model/provider preferences for beta. */
export function astraPreferenceBlocker(storage: Pick<Storage, 'getItem'>): string | null {
  try {
    if (storage.getItem('fl-model')?.trim()) return 'Astra beta requires Auto. Select Auto in the model picker before generating.'
    if (storage.getItem('fl-llm-key')?.trim() || storage.getItem('fl-llm-provider')?.trim()) {
      return 'Astra beta uses Bedrock, not a selected provider or BYOK key. Clear the browser provider/key in AI settings before generating. Saved account keys are checked by the server.'
    }
    return null
  } catch {
    return 'Saved model/provider settings could not be checked. Generation is blocked until browser storage is readable.'
  }
}

export function astraGenerationBlocker(availability: AstraAvailability, preferenceBlocker: string | null): string | null {
  if (availability.state === 'loading') return 'Checking generation mode before enabling generation.'
  if (availability.state === 'error') return availability.error
  if (!availability.status.enabled) return null
  if (preferenceBlocker) return preferenceBlocker
  if (!availability.status.ready || availability.status.blockers.length) return availability.status.blockers.join(' ') || 'Astra beta is not ready.'
  return null
}

/** Caller must carry the user's separate template selection; a draft is never converted. */
export function astraTemplateRequest(templateId: string | null, request: string): AstraArchitectRequest {
  if (templateId !== ASTRA_DESIGN_TEMPLATE.id) throw new Error('Select the BME280 template explicitly before generating.')
  return validateAstraArchitectRequest({ templateId, request, answers: [] })
}

export function astraWorkflowHeaders(workflowId: string): Record<string, string> {
  if (!workflowId.trim()) throw new Error('An owned Astra workflow is required.')
  return { 'content-type': 'application/json', 'x-fl-astra-workflow': workflowId }
}

export async function beginAstraWorkflow(fetcher: AstraFetch, signal?: AbortSignal): Promise<string> {
  const response = await fetcher('/api/astra', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'begin' }), signal,
  })
  const data = await response.json()
  if (!response.ok || data.error) throw new Error(data.error || 'Astra workflow could not begin.')
  if (typeof data.workflowId !== 'string' || !data.workflowId.trim()) throw new Error('Astra workflow identity was not returned.')
  return data.workflowId
}

export async function cancelAstraWorkflow(fetcher: AstraFetch, workflowId: string, signal?: AbortSignal): Promise<string> {
  const response = await fetcher('/api/astra', {
    method: 'POST', headers: astraWorkflowHeaders(workflowId), body: JSON.stringify({ action: 'cancel' }), signal,
  })
  const data = await response.json()
  if (!response.ok || data.error || data.cancelled !== true) throw new Error(data.error || 'Cancellation was not confirmed. The server may still be working.')
  return typeof data.detail === 'string' ? data.detail : 'Cancellation acknowledged for this workflow.'
}

export function astraBuildUrl(runId: string, workflowId: string): string {
  astraWorkflowHeaders(workflowId)
  const query = new URLSearchParams({ runId, astraWorkflow: workflowId, beta: '1' })
  return `/api/pipeline/run?${query}`
}
