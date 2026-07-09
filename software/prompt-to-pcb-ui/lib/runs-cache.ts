/**
 * Runs-list cache. /api/runs used to read + JSON.parse every run's data files
 * on every request — and last-run.json is ~3 MB per run, so with 150+ runs that
 * meant parsing ~500 MB off disk (5–8 s on the external drive) each time the
 * board list loaded. This caches the small built Run object per run, keyed by an
 * on-disk mtime signature, so an unchanged run is never re-read. The cache is
 * self-validating (a rebuilt or renamed run changes its signature → cache miss →
 * rebuild) so there is no invalidation to wire up and no staleness window.
 *
 * A persistent index (data/runs-index.json) means a server restart doesn't have
 * to re-read every run either — it hydrates the map and only re-reads runs whose
 * signature moved. Best-effort: on a read-only FS (serverless) the in-memory
 * cache still applies within a warm instance.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Run } from '@/lib/firstlight'

const INDEX_PATH = path.join(process.cwd(), 'data/runs-index.json')

type Entry = { key: string; run: Run }
let cache: Map<string, Entry> | null = null

function ensure(): Map<string, Entry> {
  if (cache) return cache
  cache = new Map()
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')) as Record<string, Entry>
    for (const [id, e] of Object.entries(raw)) {
      if (e && typeof e.key === 'string' && e.run) cache.set(id, e)
    }
  } catch {
    /* no index yet (cold) — the first request rebuilds and writes one */
  }
  return cache
}

/** The cached Run for `id` iff its on-disk signature matches, else null. */
export function cachedRun(id: string, key: string): Run | null {
  const e = ensure().get(id)
  return e && e.key === key ? e.run : null
}

export function cacheRun(id: string, key: string, run: Run): void {
  ensure().set(id, { key, run })
}

/** Forget runs that no longer exist on disk so the index can't grow unbounded. */
export function retainRuns(ids: Set<string>): void {
  const c = ensure()
  for (const id of [...c.keys()]) if (!ids.has(id)) c.delete(id)
}

/** Persist the index (best-effort — a read-only FS just keeps the in-memory copy). */
export function persistRunsIndex(): void {
  if (!cache) return
  try {
    const obj: Record<string, Entry> = {}
    for (const [id, e] of cache) obj[id] = e
    fs.writeFileSync(INDEX_PATH, JSON.stringify(obj))
  } catch {
    /* ignore */
  }
}
