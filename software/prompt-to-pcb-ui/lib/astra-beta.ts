import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { astraRequestOriginAllowed } from './astra-origin'
import { getUser, isAdminRequest, sessionEmail } from './auth'
import { AstraError, assertAstraActive, createAstraExecution, withAstraExecution, type AstraExecution } from './astra-execution'

export const ASTRA_MODEL = 'gpt-6-astra'
export const ASTRA_SCOPE = 'electronics-only'
export const ASTRA_NOT_RUN = ['mechanical', 'simulation', 'firmware', 'manufacturing', 'supplyChain', 'validation'] as const

export function astraConfigured(): boolean {
  return !!process.env.FL_ASTRA_ROOT || (process.env.FL_ASTRA_BETA !== undefined && process.env.FL_ASTRA_BETA !== '0')
}

/** Server launch configuration, never inferred from a client header. */
export function astraWorkspace() {
  if (process.env.FL_ASTRA_BETA !== '1' || process.env.NODE_ENV === 'production' || process.env.FL_ASTRA_BIND !== '127.0.0.1') {
    throw new AstraError('policy', 'Astra beta requires the isolated loopback development launcher.')
  }
  const root = process.env.FL_ASTRA_ROOT
  if (!root || !path.isAbsolute(root) || fs.realpathSync(root) !== root || fs.realpathSync(process.cwd()) !== root) {
    throw new AstraError('policy', 'Astra beta requires its own application root.')
  }
  for (const relative of ['public', 'public/runs', 'data', '.astra-home']) {
    const dir = path.join(root, relative)
    if (!fs.lstatSync(dir).isDirectory() || fs.realpathSync(dir) !== dir) {
      throw new AstraError('policy', 'Astra beta storage must be owned directories, not run-store symlinks.')
    }
  }
  const markerPath = path.join(root, '.astra-workspace.json')
  const markerStat = fs.lstatSync(markerPath)
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 1024) throw new AstraError('policy', 'Invalid Astra workspace marker.')
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
  if (marker.version !== 1 || marker.root !== root || marker.purpose !== 'isolated-astra-beta') {
    throw new AstraError('policy', 'Astra beta workspace marker is missing or invalid.')
  }
  const origin = process.env.FL_ASTRA_ORIGIN
  if (!origin || !/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(origin) || Number(new URL(origin).port) > 65535) {
    throw new AstraError('policy', 'Astra beta requires an explicit loopback origin.')
  }
  return { root, home: path.join(root, '.astra-home'), origin }
}

export function authorizeAstra(req: Request): string {
  const { origin } = astraWorkspace()
  if (!astraRequestOriginAllowed(req, origin)) {
    throw new AstraError('policy', 'Astra beta requests must be same-origin and local.')
  }
  const owner = sessionEmail(req)
  if (!owner || !isAdminRequest(req) || !getUser(owner)) throw new AstraError('policy', 'Astra beta requires a signed-in local operator.')
  const user = getUser(owner) as ReturnType<typeof getUser> & { llmKey?: unknown }
  if (req.headers.has('x-llm-key') || req.headers.has('x-llm-provider') || user?.llmKey) {
    throw new AstraError('policy', 'Astra beta cannot be combined with a supplied or saved provider key. Use an isolated test account without BYOK.')
  }
  const models = [req.headers.get('x-fl-model'), ...new URL(req.url).searchParams.getAll('model')]
  if (models.some((model) => model !== null && model !== '' && model !== ASTRA_MODEL)) throw new AstraError('policy', 'Clear the model selection before using the fixed Astra beta model.')
  return owner
}

type Workflow = { execution: AstraExecution; busy: boolean; phase: 'interview' | 'ready' | 'building' | 'finished'; spec?: unknown; runId?: string; templateId?: string }
const shared = globalThis as typeof globalThis & { __astraWorkflow?: Workflow; __astraCleanupUnconfirmed?: boolean }

/** No in-process reset: only a verified launcher teardown may clear this state. */
export function blockAstraForUnconfirmedCleanup(execution: AstraExecution): void {
  shared.__astraCleanupUnconfirmed = true
  execution.cancel()
}

export function assertAstraCleanupConfirmed(): void {
  if (shared.__astraCleanupUnconfirmed) throw new AstraError('policy', 'Native validator cleanup is unconfirmed. This launcher must be stopped and its owned container state verified before another workflow.')
}

export function beginAstraWorkflow(req: Request) {
  const owner = authorizeAstra(req)
  assertAstraCleanupConfirmed()
  const old = shared.__astraWorkflow
  if (old && (old.busy || (old.phase !== 'finished' && !old.execution.signal.aborted && old.execution.deadline > Date.now()))) {
    throw new AstraError('busy', 'An Astra workflow is already active. Finish or cancel it before starting another.')
  }
  old?.execution.cancel()
  const execution = createAstraExecution({ id: randomUUID(), owner, maxCalls: 8, timeoutMs: 20 * 60_000 })
  shared.__astraWorkflow = { execution, busy: false, phase: 'interview' }
  return execution.id
}

function workflowId(req: Request): string {
  const ids = [req.headers.get('x-fl-astra-workflow'), ...new URL(req.url).searchParams.getAll('astraWorkflow')].filter((id): id is string => id !== null)
  if (!ids.length || !ids[0] || ids.some((id) => id !== ids[0])) throw new AstraError('policy', 'A single Astra workflow identity is required.')
  return ids[0]
}

export function astraWorkflow(req: Request): Workflow {
  const owner = authorizeAstra(req)
  assertAstraCleanupConfirmed()
  const id = workflowId(req)
  const workflow = shared.__astraWorkflow
  if (!workflow || workflow.execution.id !== id || workflow.execution.owner !== owner) {
    throw new AstraError('policy', 'Astra workflow is unavailable. No generation has been submitted by this request.')
  }
  assertAstraActive(workflow.execution)
  return workflow
}

export async function inAstraWorkflow<T>(req: Request, phase: 'interview' | 'building', operation: (workflow: Workflow) => Promise<T>): Promise<T> {
  const workflow = astraWorkflow(req)
  if (workflow.busy || workflow.phase === 'finished' || (phase === 'building' && workflow.phase !== 'ready') || (phase === 'interview' && workflow.phase !== 'interview')) {
    throw new AstraError('busy', 'This Astra workflow cannot accept another operation.')
  }
  workflow.busy = true
  if (phase === 'building') workflow.phase = 'building'
  try {
    return await withAstraExecution(workflow.execution, () => operation(workflow))
  } finally {
    workflow.busy = false
    if (phase === 'building') workflow.phase = 'finished'
  }
}

export function cancelAstraWorkflow(req: Request) {
  const owner = authorizeAstra(req)
  const id = workflowId(req)
  const workflow = shared.__astraWorkflow
  if (!workflow || workflow.execution.owner !== owner || workflow.execution.id !== id) throw new AstraError('policy', 'Astra workflow not found.')
  workflow.execution.cancel()
  workflow.phase = 'finished'
  return { cancelled: true, detail: 'Local cancellation requested. Remote inference and billing may continue until the provider stops.' }
}

export function astraErrorResponse(error: unknown) {
  const category = error instanceof AstraError ? error.category : 'policy'
  const status = category === 'busy' ? 409 : category === 'timeout' ? 504 : category === 'policy' ? 403 : 502
  return Response.json({ error: error instanceof AstraError ? error.message : 'Astra beta configuration is unavailable.', category }, { status })
}
