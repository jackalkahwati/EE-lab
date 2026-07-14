/**
 * Terminal log bus — a tiny client-side, framework-light event log behind the
 * Cursor-style bottom Terminal panel. Any component (or plain function) can
 * push lines with `logLine(...)`; React consumers subscribe via
 * `useTerminalLog()` / `useProblemCount()` (useSyncExternalStore, so
 * concurrent-render safe). No dependencies, no context provider needed —
 * module-level singleton, same instance for every importer in the client
 * bundle.
 *
 * Storage is a ring buffer (LOG_CAP lines): a multi-minute pipeline run can
 * emit thousands of build/route/DRC lines and the panel must stay bounded.
 */
import { useSyncExternalStore } from 'react'

export type LogLevel = 'info' | 'warn' | 'error' | 'ok'
/** Known emitters: 'build' = the board-build SSE stream, 'pipeline' = the
 *  full-pipeline orchestrator's stage transitions, 'system' = the UI itself. */
export type LogSource = 'build' | 'pipeline' | 'system'

export type TerminalLine = {
  /** monotonic id — stable React key even after the ring buffer drops lines */
  id: number
  /** epoch ms */
  ts: number
  source: LogSource
  level: LogLevel
  text: string
  /** the run this line belongs to, when known */
  runId?: string
}

export type LogEntry = {
  source: LogSource
  text: string
  level?: LogLevel
  runId?: string
  /** epoch ms; defaults to now */
  ts?: number
}

const LOG_CAP = 2000

// ---- module-level store (client singleton) ----
const lines: TerminalLine[] = []
const listeners = new Set<() => void>()
let version = 0
let nextId = 1
// running warn+error tally, kept incrementally so the problem-count snapshot
// is O(1) (useSyncExternalStore calls getSnapshot often)
let problems = 0

function isProblem(level: LogLevel): boolean {
  return level === 'warn' || level === 'error'
}

function emit() {
  version++
  for (const cb of listeners) cb()
}

/** Append a line. Safe to call from anywhere in the client (event handlers,
 *  SSE callbacks, effects) — never throws, never re-enters React. */
export function logLine(entry: LogEntry): void {
  const level = entry.level ?? 'info'
  lines.push({
    id: nextId++,
    ts: entry.ts ?? Date.now(),
    source: entry.source,
    level,
    text: entry.text,
    runId: entry.runId,
  })
  if (isProblem(level)) problems++
  // ring buffer: drop the oldest overflow in one splice (amortized O(1))
  if (lines.length > LOG_CAP) {
    const dropped = lines.splice(0, lines.length - LOG_CAP)
    for (const d of dropped) if (isProblem(d.level)) problems--
  }
  emit()
}

/** Clear everything (the panel's trash button). */
export function clearLog(): void {
  if (!lines.length) return
  lines.length = 0
  problems = 0
  emit()
}

/** Current lines (the live array — treat as read-only; re-read after any
 *  subscribe notification). */
export function getLines(): readonly TerminalLine[] {
  return lines
}

/** Current count of warn+error lines (the PROBLEMS tab / status-bar badge). */
export function getProblemCount(): number {
  return problems
}

/** Subscribe to any change; returns the unsubscribe function. */
export function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

// ---- React bindings ----

const getVersion = () => version
const getServerVersion = () => 0
const getProblems = () => problems
const getServerProblems = () => 0

/**
 * Lines + a version tick. The version is the store snapshot (a primitive, so
 * useSyncExternalStore's equality check is exact); the component re-renders on
 * every appended/cleared line and reads the current buffer.
 */
export function useTerminalLog(): { lines: readonly TerminalLine[]; version: number } {
  const v = useSyncExternalStore(subscribe, getVersion, getServerVersion)
  return { lines, version: v }
}

/** Just the warn+error count — cheap subscription for the status bar, so the
 *  page doesn't re-render on every info line. */
export function useProblemCount(): number {
  return useSyncExternalStore(subscribe, getProblems, getServerProblems)
}
