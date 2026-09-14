/** Private conversation state lives only in this mounted workspace, never storage. */
export function createComposeSessionCache<T>(limit = 8) {
  const entries = new Map<string, T>()
  const capacity = Math.max(1, Math.floor(limit) || 8)
  return {
    get(key: string): T | undefined {
      const value = entries.get(key)
      if (value !== undefined) {
        entries.delete(key)
        entries.set(key, value)
      }
      return value
    },
    set(key: string, value: T) {
      entries.delete(key)
      entries.set(key, value)
      while (entries.size > capacity) entries.delete(entries.keys().next().value!)
    },
    delete(key: string) { entries.delete(key) },
    get size() { return entries.size },
  }
}

export type ComposeOperation = {
  signal: AbortSignal
  current: () => boolean
  finish: () => void
}

/** A generation fence protects even non-abortable reads and queued SSE events.
 * Disposing observation does NOT cancel server-side generation or paid work.
 * begin/finish notify synchronously so a second click cannot change sessions.
 */
export function createComposeOperations(onBusy: (busy: boolean) => void) {
  let generation = 0
  let alive = false
  const pending = new Set<AbortController>()
  return {
    activate() { alive = true },
    begin(): ComposeOperation {
      const controller = new AbortController()
      const epoch = generation
      let finished = false
      pending.add(controller)
      onBusy(true)
      return {
        signal: controller.signal,
        current: () => alive && epoch === generation && !finished && !controller.signal.aborted,
        finish() {
          if (finished) return
          finished = true
          pending.delete(controller)
          if (alive && epoch === generation) onBusy(pending.size > 0)
        },
      }
    },
    get busy() { return pending.size > 0 },
    dispose() {
      alive = false
      generation += 1
      for (const controller of pending) controller.abort()
      pending.clear()
      onBusy(false)
    },
  }
}

/** Only live indicators change when observation ends; completed evidence survives. */
export function settleComposeStages<T extends string>(stages: Record<string, T>, outcome: 'failed' | 'disconnected' | 'unreported'): Record<string, T | 'failed' | 'disconnected' | 'unreported'> {
  return Object.fromEntries(Object.entries(stages).map(([id, state]) => [id, state === 'running' ? outcome : state]))
}

export type ComposeHistorySection = { label: string; turns: { question: string; answer: string }[] }

/** Display history is separate from the active interview's protocol answers. */
export function archiveComposeTurns(history: ComposeHistorySection[], label: string, turns: ComposeHistorySection['turns']): ComposeHistorySection[] {
  if (!turns.length) return history
  return [...history, { label, turns: turns.slice(-30).map((turn) => ({ ...turn })) }].slice(-8)
}

export function canSubmitCompose(phase: string, revising: boolean, hasQuestion: boolean) {
  return revising || phase === 'idle' || (hasQuestion && ['id', 'architect', 'interview'].includes(phase))
}
