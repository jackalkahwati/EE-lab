/** Browser-safe native run contract. No filesystem, auth, or execution imports. */
import type { AstraManifest, AstraArtifactName } from './astra-artifacts'
export type { AstraManifest, AstraArtifactName } from './astra-artifacts'

export const ASTRA_MANIFEST = 'astra-manifest.json'
// Defensive browser mirror of the authoritative server whitelist. Parity tested.
export const ASTRA_OUTPUTS = Object.freeze({
  'electronics/chipscale-board.json': 1024 * 1024,
  'electronics/chipscale.kicad_pcb': 16 * 1024 * 1024,
  'electronics/netlist.json': 128 * 1024,
  'electronics/native-evidence.json': 2 * 1024 * 1024,
  'electronics/drc.json': 4 * 1024 * 1024,
  'electronics/chipscale.svg': 8 * 1024 * 1024,
  'electronics/layer-top.svg': 8 * 1024 * 1024,
  'electronics/layer-bottom.svg': 8 * 1024 * 1024,
  'board/render-top.png': 16 * 1024 * 1024,
  'board/render-bottom.png': 16 * 1024 * 1024,
  'board/chipscale.glb': 64 * 1024 * 1024,
})
const metadata = new Set(['astra-policy.json', 'product-spec.json', 'timing.json', ASTRA_MANIFEST])
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const validRunId = (id: string) => /^run-[A-Za-z0-9._-]*$/.test(id) && id.length <= 128
const date = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null

/** Display validation only. Server authorization and integrity checks remain mandatory. */
export function parseAstraManifest(value: unknown, runId: string): AstraManifest {
  if (!validRunId(runId) || !object(value) || value.version !== 1 || value.runId !== runId || value.scope !== 'electronics-only' || value.native !== true
    || typeof value.status !== 'string' || !['passed', 'failed', 'cancelled', 'unknown'].includes(value.status)
    || !count(value.routeAttempts) || value.routeAttempts > 1 || !digest(value.proposalSha256)
    || !date(value.createdAt) || !object(value.tools) || Object.keys(value.tools).length > 16
    || !Object.values(value.tools).every(v => typeof v === 'string' && v.length <= 256)
    || !object(value.checks) || !Array.isArray(value.artifacts) || value.artifacts.length > Object.keys(ASTRA_OUTPUTS).length) {
    throw new Error('Native artifact manifest is invalid.')
  }
  const checks = value.checks
  if (typeof checks.drcAvailable !== 'boolean' || typeof checks.identityPreserved !== 'boolean' || typeof checks.exportsComplete !== 'boolean'
    || !(checks.drcErrors === null || count(checks.drcErrors)) || !(checks.unrouted === null || count(checks.unrouted))) {
    throw new Error('Native check evidence is invalid.')
  }
  const names = new Set<string>()
  for (const item of value.artifacts) {
    if (!object(item) || typeof item.path !== 'string' || !Object.hasOwn(ASTRA_OUTPUTS, item.path) || names.has(item.path)
      || !count(item.bytes) || item.bytes === 0 || item.bytes > ASTRA_OUTPUTS[item.path as AstraArtifactName] || !digest(item.sha256)) {
      throw new Error('Native artifact entry is invalid.')
    }
    names.add(item.path)
  }
  if (checks.exportsComplete && Object.keys(ASTRA_OUTPUTS).some(name => !names.has(name))) throw new Error('Native exports are incomplete.')
  if (value.status === 'passed' && (!checks.drcAvailable || checks.drcErrors !== 0 || checks.unrouted !== 0
    || !checks.identityPreserved || !checks.exportsComplete || value.routeAttempts !== 1)) throw new Error('Native success lacks required evidence.')
  return value as unknown as AstraManifest
}

export function astraArtifactUrl(runId: string, relative: string): string {
  if (!validRunId(runId) || (!metadata.has(relative) && !Object.hasOwn(ASTRA_OUTPUTS, relative))) throw new Error('Invalid Astra artifact URL.')
  return `/runs/${encodeURIComponent(runId)}/${relative}`
}

export type AstraRunStatus = 'RUNNING' | 'PASSED' | 'GATE FAILED' | 'CANCELLED' | 'UNKNOWN'
export type AstraStageState = 'running' | 'passed' | 'failed' | 'cancelled' | 'unknown' | 'not-run'
export const ASTRA_NOT_RUN = ['mechanical', 'simulation', 'firmware', 'manufacturing', 'supplyChain', 'validation'] as const
export interface AstraRunView {
  transport: 'astra-beta'
  scope: 'electronics-only'
  id: string
  name: string
  prompt: string
  timestamp: string
  real: true
  runDir: string
  status: AstraRunStatus
  stages: { id: 'electronics' | typeof ASTRA_NOT_RUN[number]; state: AstraStageState; elapsedMs: number | null; detail: string }[]
  metrics: {
    netsRouted: null; netsTotal: null; copperDefects: number | null; hpwl: null; hpwlHistory: number[];
    components: null; bomLines: null; boardSize: null; layers: null; routeTimeSec: null;
  }
  checks: { drcAvailable: boolean | null; drcErrors: number | null; unrouted: number | null; identityPreserved: boolean | null; exportsComplete: boolean | null }
  manifest: AstraManifest | null
  artifacts: AstraManifest['artifacts']
  logs: []
}

/** Missing publication is an unknown result, never a synthetic legacy board. */
export function buildAstraRunView(input: { runId: string; policy?: unknown; timing?: unknown; spec?: unknown; manifest?: unknown; active?: boolean }): AstraRunView {
  const { runId } = input
  const runDir = astraArtifactUrl(runId, ASTRA_MANIFEST).slice(0, -(ASTRA_MANIFEST.length + 1))
  let manifest: AstraManifest | null = null
  try { manifest = parseAstraManifest(input.manifest, runId) } catch { /* absent, partial, or invalid publication */ }
  const timing = object(input.timing) && input.timing.runId === runId ? input.timing : null
  const electronics = Array.isArray(timing?.stages) ? timing.stages.filter(object).find(s => s.stage === 'electronics') : undefined
  const timingState = electronics?.status
  const policy = object(input.policy) && input.policy.version === 1 && input.policy.transport === 'astra-beta'
    && input.policy.model === 'gpt-6-astra' && input.policy.scope === 'electronics-only'
    && (input.policy.runId === undefined || input.policy.runId === runId) ? input.policy : null
  const outcome = object(policy?.outcome) ? policy.outcome : null
  const terminalStates = [manifest?.status, timingState, policy?.status, outcome?.status]
  let state: AstraStageState = manifest?.status ?? 'unknown'
  // Pipeline policy records cancellation before a native manifest exists; its
  // generic failed timing must not erase that explicit cancellation evidence.
  // Metadata can restrict a result, but can never establish native success.
  if (terminalStates.includes('cancelled')) state = 'cancelled'
  else if (terminalStates.includes('failed')) state = 'failed'
  // Persisted running timing can outlive its process. Only an explicit live
  // workflow observation may claim RUNNING; historical partials stay UNKNOWN.
  else if (!manifest && input.active === true && !date(timing?.finishedAt)) state = 'running'
  const status: AstraRunStatus = state === 'passed' ? 'PASSED' : state === 'failed' ? 'GATE FAILED' : state === 'running' ? 'RUNNING' : state === 'cancelled' ? 'CANCELLED' : 'UNKNOWN'
  const startedAt = date(electronics?.startedAt)
  const endedAt = date(electronics?.endedAt)
  const duration = startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : null
  const elapsedMs = duration !== null && duration >= 0 ? duration : null
  const spec = object(input.spec) ? input.spec : null
  const name = typeof spec?.product === 'string' && spec.product.trim() ? spec.product.trim().slice(0, 512) : runId
  const checks = manifest ? {
    drcAvailable: manifest.checks.drcAvailable,
    drcErrors: manifest.checks.drcAvailable ? manifest.checks.drcErrors : null,
    unrouted: manifest.checks.unrouted,
    identityPreserved: manifest.checks.identityPreserved,
    exportsComplete: manifest.checks.exportsComplete,
  } : { drcAvailable: null, drcErrors: null, unrouted: null, identityPreserved: null, exportsComplete: null }
  return {
    transport: 'astra-beta', scope: 'electronics-only', id: runId, name, prompt: name, real: true, runDir,
    timestamp: date(timing?.finishedAt) ?? manifest?.createdAt ?? date(timing?.startedAt) ?? '',
    status,
    stages: [
      { id: 'electronics', state, elapsedMs, detail: typeof electronics?.detail === 'string' ? electronics.detail.slice(0, 2048) : manifest ? 'Native electronics evidence published.' : 'Native result not published; outcome unknown.' },
      ...ASTRA_NOT_RUN.map(id => ({ id, state: 'not-run' as const, elapsedMs: null, detail: 'Not run in the electronics-only beta.' })),
    ],
    metrics: { netsRouted: null, netsTotal: null, copperDefects: checks.drcErrors, hpwl: null, hpwlHistory: [], components: null, bomLines: null, boardSize: null, layers: null, routeTimeSec: null },
    checks, manifest, artifacts: manifest?.artifacts ?? [], logs: [],
  }
}
