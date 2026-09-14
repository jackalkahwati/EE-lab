import { boardVerdict, type BoardFacts } from './verdict.ts'
import type { PipeStage, PipeStatus, RunTiming, StageTiming } from './run-pipeline.ts'

export const INITIAL_WORKSPACE_SESSION = 'draft:initial'
export const WORKSPACE_SESSION_LIMIT = 8
export type WorkspaceSurface = 'conversation' | 'preview' | 'details'
export type WorkspaceMode = 'mobile' | 'tablet' | 'desktop'
export type WorkspaceStageStatus = PipeStatus | 'unknown'
export type WorkspacePipeline = Record<string, { status: WorkspaceStageStatus; detail?: string }>
export type WorkspaceHistoryState = 'none' | 'loading' | 'available' | 'unavailable'
export type WorkspaceHistory = { runId: string; state: 'available' | 'unavailable'; pipeline: WorkspacePipeline }

// Deliberately type-only dependencies above: timing restoration must not pull
// the orchestrator (or its server dependencies) into the preview client graph.
const TIMING_STAGES: readonly string[] = ['electronics', 'mechanical', 'simulation', 'firmware', 'manufacturing', 'supplyChain', 'validation', 'id']
const TIMING_STATUSES: readonly PipeStatus[] = ['pending', 'running', 'passed', 'failed', 'blocked', 'skipped']
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const timestamp = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value))
const duration = (value: unknown) => value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)

/** The import writer saves retained-file metadata, not a generation-ready ProductSpec. */
export function workspaceImportedMetadata(value: unknown): boolean {
  return record(value) && value.source === 'import' && value.imported === true
    && typeof value.product === 'string' && value.product.trim().length > 0 && timestamp(value.createdAt)
}

export function workspaceRunId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
}

/** Mirrors the import route's 50 MiB per-file limit without importing its server module. */
export function workspaceImportFileError(file: { name: string; size: number } | null, kind: 'pcb' | 'step'): string | null {
  if (!file) return null
  if (file.size <= 0) return `${kind.toUpperCase()} file is empty.`
  if (file.size > 50 * 1024 * 1024) return `${kind.toUpperCase()} file exceeds the 50 MiB limit.`
  const extension = kind === 'pcb' ? /\.kicad_pcb$/i : /\.(step|stp)$/i
  if (!extension.test(file.name)) return kind === 'pcb' ? 'Choose a .kicad_pcb file.' : 'Choose a .step or .stp file.'
  return null
}

export function workspaceOnshapeUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'cad.onshape.com' && !url.port
      && !url.username && !url.password && /^\/documents\/[^/]+\/(?:w|v|m)\/[^/]+\/e\/[^/]+\/?$/.test(url.pathname)
  } catch { return false }
}

function validAttempt(value: unknown): value is StageTiming {
  if (!record(value)) return false
  return TIMING_STAGES.includes(value.stage as PipeStage)
    && TIMING_STATUSES.includes(value.status as PipeStatus)
    && timestamp(value.startedAt)
    && (value.endedAt === undefined || (timestamp(value.endedAt) && Date.parse(value.endedAt) >= Date.parse(value.startedAt)))
    && duration(value.ms)
    && (value.detail === undefined || typeof value.detail === 'string')
    && (value.unfinished === undefined || typeof value.unfinished === 'boolean')
}

/** No artifact inference and no legacy EDA-to-discipline mapping. Reject a bad
 * record rather than falling back to an older, potentially successful attempt. */
export function restoreWorkspaceTiming(value: unknown, runId: string): WorkspaceHistory {
  const unavailable: WorkspaceHistory = { runId, state: 'unavailable', pipeline: {} }
  if (!record(value) || value.runId !== runId || !timestamp(value.startedAt)
    || (value.finishedAt !== undefined && (!timestamp(value.finishedAt) || Date.parse(value.finishedAt) < Date.parse(value.startedAt)))
    || !duration(value.totalMs) || !Array.isArray(value.stages) || !value.stages.length
    || !value.stages.every(validAttempt)) return unavailable
  const timing: RunTiming = { runId, startedAt: value.startedAt, stages: value.stages }
  const latest = new Map<string, StageTiming>()
  for (const attempt of timing.stages) {
    const previous = latest.get(attempt.stage)
    // Array order breaks equal-millisecond ties (the recorder appends attempts).
    if (!previous || Date.parse(attempt.startedAt) >= Date.parse(previous.startedAt)) latest.set(attempt.stage, attempt)
  }
  const pipeline: WorkspacePipeline = {}
  for (const stage of TIMING_STAGES) {
    const attempt = latest.get(stage)
    if (!attempt && stage === 'id') continue
    if (!attempt) {
      pipeline[stage] = { status: 'unknown', detail: 'No recorded attempt for this discipline. Saved artifacts are not proof of completion.' }
    } else if (attempt.status === 'running' || attempt.unfinished || (attempt.status === 'passed' && !attempt.endedAt)) {
      pipeline[stage] = { status: 'unknown', detail: `Historical attempt interrupted or unfinished. Server outcome is unknown.${attempt.detail ? ` Last update: ${attempt.detail}` : ''}` }
    } else {
      pipeline[stage] = { status: attempt.status, detail: attempt.detail }
    }
  }
  return { runId, state: 'available', pipeline }
}

/** Read only the selected run's public timing artifact; never a persistence API.
 * A second abort check protects even fetch implementations that ignore signals. */
export async function readWorkspaceTiming(runId: string, signal: AbortSignal, read: typeof fetch = fetch): Promise<WorkspaceHistory | null> {
  if (signal.aborted) return null
  if (!workspaceRunId(runId)) return restoreWorkspaceTiming(null, runId)
  try {
    const response = await read(`/runs/${encodeURIComponent(runId)}/timing.json`, { cache: 'no-store', signal })
    if (signal.aborted) return null
    const value: unknown = response.ok ? await response.json() : null
    return signal.aborted ? null : restoreWorkspaceTiming(value, runId)
  } catch {
    return signal.aborted ? null : restoreWorkspaceTiming(null, runId)
  }
}

/** Live state owns the whole run, even an empty map; stale saved stages must not
 * bleed into a new attempt. The caller keeps history separate from live state. */
export function workspacePipelineState(runId: string, live: WorkspacePipeline | undefined, history?: WorkspaceHistory | null) {
  if (!runId) return { pipeline: {} as WorkspacePipeline, historyState: 'none' as const }
  if (live !== undefined) return { pipeline: live, historyState: 'none' as const }
  if (history?.runId === runId) return { pipeline: history.pipeline, historyState: history.state }
  return { pipeline: {} as WorkspacePipeline, historyState: 'loading' as const }
}

/** Stopping observation is not proof that server-side work was cancelled. */
export function interruptWorkspacePipeline(pipeline: WorkspacePipeline, detail = 'Updates stopped. Server outcome is unknown; inspect saved artifacts before restarting.'): WorkspacePipeline {
  return Object.fromEntries(Object.entries(pipeline).map(([stage, value]) => [stage,
    value.status === 'running' ? { status: 'unknown' as const, detail } : value]))
}

export function workspaceStageLabel(status?: WorkspaceStageStatus, historyState: WorkspaceHistoryState = 'none'): string {
  if (status === 'unknown') return 'Outcome unknown'
  if (status) return status
  return historyState === 'loading' ? 'Loading history'
    : historyState === 'unavailable' || historyState === 'available' ? 'History unavailable' : 'not started'
}

export function workspaceMode(width: number): WorkspaceMode {
  return width < 760 ? 'mobile' : width < 1200 ? 'tablet' : 'desktop'
}

/** Reserve a genuinely usable preview, even after restoring oversized widths. */
export function clampWorkspacePanes(width: number, left: number, right: number, showLeft = true, showRight = true) {
  const safe = (value: number, fallback: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Number.isFinite(value) && value > 0 ? value : fallback))
  let l = safe(left, 320, 260, 440)
  let r = safe(right, 360, 280, 460)
  const available = Math.max(0, width - 420 - (showLeft ? 5 : 0) - (showRight ? 5 : 0))
  const total = (showLeft ? l : 0) + (showRight ? r : 0)
  if (total > available && total > 0) {
    const ratio = available / total
    if (showLeft) l = Math.floor(l * ratio)
    if (showRight) r = Math.floor(r * ratio)
  }
  return { left: l, right: r }
}

export function pipelineSignature(pipeline: WorkspacePipeline): string {
  return Object.keys(pipeline).sort().map((key) => `${key}:${pipeline[key].status}`).join('|')
}

/** Initial board SSE precedes the discipline pipeline; no completed stages are inferred. */
export function workspaceInitialPipeline(status?: string, failure?: string): WorkspacePipeline {
  if (status === 'RUNNING') return { electronics: { status: 'running', detail: 'Initial board build in progress; discipline pipeline has not started.' } }
  if (failure) return { electronics: { status: status === 'NEEDS ATTENTION' ? 'unknown' : 'blocked', detail: status === 'NEEDS ATTENTION'
    ? `Initial board updates disconnected. Server outcome is unknown. ${failure}`
    : `Initial board build needs attention before the discipline pipeline can start. ${failure}` } }
  return {}
}

/** Pending and skipped never count as successful work. Multiple running stages are retained. */
export function workspaceProgress(pipeline: WorkspacePipeline, running: boolean, historyState: WorkspaceHistoryState = 'none') {
  const values = Object.values(pipeline)
  const count = (status: string) => values.filter((value) => value.status === status).length
  const counts = { passed: count('passed'), failed: count('failed'), blocked: count('blocked'), pending: count('pending'), skipped: count('skipped'), running: count('running'), unknown: count('unknown') }
  const label = running || counts.running ? 'Build in progress'
    : counts.failed || counts.blocked ? 'Build needs attention'
      : counts.unknown ? 'Build outcome unknown'
        : counts.pending ? 'Build incomplete'
          : counts.passed ? (counts.skipped ? 'Build finished with skipped stages' : 'Build finished')
            : counts.skipped ? 'Stages skipped'
              : historyState === 'loading' ? 'Loading history'
                : historyState === 'unavailable' || historyState === 'available' ? 'History unavailable' : 'Build not started'
  return { ...counts, label, total: values.length }
}

/** Only the raw shipped-board artifact can support a passed board label. */
export function workspaceBoardStatus(facts: BoardFacts | null, hasRun: boolean, running: boolean, failure?: string) {
  const verdict = boardVerdict(facts)
  if (!hasRun) return { label: 'Draft', action: null, detail: 'Describe your product, then review the plan before building.' }
  if (running) return { label: 'Building', action: 'Review results', detail: 'Available artifacts stay open while the build runs.' }
  if (failure || verdict.state === 'failed') return { label: 'Needs review', action: 'Review results', detail: failure || verdict.detail }
  if (verdict.state === 'passed') return { label: 'Board checks passed', action: 'Review manufacturing', detail: verdict.detail + '. Board checks are not physical or manufacturing approval.' }
  return { label: verdict.state === 'unverified' ? 'Board unverified' : 'Review required', action: 'Review results', detail: verdict.detail }
}

/** Keep MRU session context in memory only, matching the conversation cache bound. */
export function rememberWorkspaceSession<T>(cache: Map<string, T>, key: string, value: T) {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > WORKSPACE_SESSION_LIMIT) cache.delete(cache.keys().next().value!)
}

export function promoteWorkspaceSession(runSessions: Map<string, string>, runId: string, sessionKey: string) {
  // A revision keeps the live conversation, but its ancestor must restore from
  // its own saved artifacts rather than inheriting revision-local specifications.
  for (const [id, key] of runSessions) if (key === sessionKey && id !== runId) runSessions.delete(id)
  runSessions.set(runId, sessionKey)
  return sessionKey
}
