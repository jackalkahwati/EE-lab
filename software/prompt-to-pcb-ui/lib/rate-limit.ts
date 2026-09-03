/**
 * Dependency-free, in-memory sliding-window rate limiter.
 *
 * Single-instance deployment (the Compose app runs as one Node process behind
 * nginx/Caddy), so a process-local Map is sufficient — no Redis required. Each
 * key keeps a log of request timestamps within its window; a request is allowed
 * only while fewer than `limit` timestamps fall inside the trailing `windowMs`.
 *
 * Callers encode the tier into the key (e.g. `pipeline:min:<id>` and
 * `pipeline:hr:<id>`) so one caller can enforce several tiers against the same
 * identity by calling `checkRateLimit` once per tier.
 *
 * Runs in the Node.js middleware runtime (proxy.ts already uses `fs`), so plain
 * module state and timers are available. State is stashed on `globalThis` so it
 * survives dev hot-reloads and stays a true singleton within the process.
 */

interface Bucket {
  /** request timestamps (ms) still within the window, oldest first */
  hits: number[]
}

interface LimiterState {
  buckets: Map<string, Bucket>
  /** rolling counter used to trigger opportunistic sweeps without a timer */
  opsSinceSweep: number
  lastSweep: number
}

const GLOBAL_KEY = '__firstlight_rate_limit__'

function state(): LimiterState {
  const g = globalThis as unknown as Record<string, LimiterState | undefined>
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { buckets: new Map(), opsSinceSweep: 0, lastSweep: Date.now() }
  }
  return g[GLOBAL_KEY]!
}

/** Sweep buckets whose newest hit is older than `maxWindowMs`, so keys for
 * one-off visitors don't accumulate. Cheap and timer-free: runs at most once
 * per SWEEP_EVERY_OPS calls or SWEEP_EVERY_MS, whichever comes first. */
const SWEEP_EVERY_OPS = 500
const SWEEP_EVERY_MS = 60_000
const MAX_TRACKED_WINDOW_MS = 24 * 60 * 60 * 1000 // drop keys idle > 24h
/** Hard cap on tracked keys (FL_RL_MAX_KEYS, default 10k). The Map is kept in
 * least-recently-used order (a hit re-inserts its key at the end), so when the
 * cap is exceeded the oldest-touched keys are evicted first. This bounds memory
 * against an attacker who rotates source addresses faster than the 24h sweep. */
const DEFAULT_MAX_KEYS = 10_000

function maxKeys(): number {
  const n = envInt('FL_RL_MAX_KEYS', DEFAULT_MAX_KEYS)
  return n > 0 ? n : DEFAULT_MAX_KEYS
}

function evictOverCap(s: LimiterState): void {
  const cap = maxKeys()
  while (s.buckets.size > cap) {
    const oldest = s.buckets.keys().next()
    if (oldest.done) break
    s.buckets.delete(oldest.value)
  }
}

/** Number of keys currently tracked (tests + diagnostics). */
export function trackedKeyCount(): number {
  return state().buckets.size
}

/** Drop all limiter state (tests only — production state is process-global). */
export function resetRateLimitState(): void {
  const s = state()
  s.buckets.clear()
  s.opsSinceSweep = 0
  s.lastSweep = Date.now()
}

/**
 * Caller IP for anonymous rate-limit keying, most-trusted source first:
 *  1. cf-connecting-ip — set by Cloudflare when the app is behind its tunnel/CDN
 *     (the client cannot inject it past Cloudflare).
 *  2. the LAST hop of x-forwarded-for — the address the nearest proxy saw, which
 *     a client can't spoof; the FIRST hop is client-supplied and trivially forged
 *     to rotate rate-limit buckets.
 *  3. x-real-ip (nginx/Caddy), then a shared 'unknown' bucket.
 */
export function clientIpFromHeaders(headers: Headers): string {
  const cf = headers.get('cf-connecting-ip')?.trim()
  if (cf) return cf
  const xff = headers.get('x-forwarded-for')
  if (xff) {
    const hops = xff.split(',').map((h) => h.trim()).filter(Boolean)
    const last = hops[hops.length - 1]
    if (last) return last
  }
  return headers.get('x-real-ip')?.trim() || 'unknown'
}

function maybeSweep(s: LimiterState, now: number): void {
  s.opsSinceSweep += 1
  if (s.opsSinceSweep < SWEEP_EVERY_OPS && now - s.lastSweep < SWEEP_EVERY_MS) return
  s.opsSinceSweep = 0
  s.lastSweep = now
  for (const [key, bucket] of s.buckets) {
    const newest = bucket.hits[bucket.hits.length - 1]
    if (newest === undefined || now - newest > MAX_TRACKED_WINDOW_MS) {
      s.buckets.delete(key)
    }
  }
}

export interface RateLimitResult {
  /** true when the request is under the limit and has been counted */
  ok: boolean
  /** seconds until the caller may retry (0 when ok) */
  retryAfterSec: number
  /** requests remaining in the window after this one (0 when blocked) */
  remaining: number
}

export interface RateLimitOptions {
  /** max requests allowed within the window */
  limit: number
  /** window length in milliseconds */
  windowMs: number
}

/**
 * Record and evaluate one request against a sliding window.
 *
 * A non-positive `limit` disables the tier (always ok) so a limit of 0 in env
 * can be used as an off switch for a single tier without special-casing callers.
 */
export function checkRateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const { limit, windowMs } = opts
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    return { ok: true, retryAfterSec: 0, remaining: Number.MAX_SAFE_INTEGER }
  }

  const s = state()
  const now = Date.now()
  maybeSweep(s, now)

  let bucket = s.buckets.get(key)
  if (bucket) {
    // LRU touch: re-insert so this key moves to the end of iteration order.
    s.buckets.delete(key)
    s.buckets.set(key, bucket)
  } else {
    bucket = { hits: [] }
    s.buckets.set(key, bucket)
    evictOverCap(s)
  }

  const cutoff = now - windowMs
  // Drop expired timestamps from the front (hits are appended in time order).
  let firstFresh = 0
  while (firstFresh < bucket.hits.length && bucket.hits[firstFresh] <= cutoff) firstFresh += 1
  if (firstFresh > 0) bucket.hits.splice(0, firstFresh)

  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0]
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
    return { ok: false, retryAfterSec, remaining: 0 }
  }

  bucket.hits.push(now)
  return { ok: true, retryAfterSec: 0, remaining: Math.max(0, limit - bucket.hits.length) }
}

/** Read a positive integer env var, falling back to `fallback` when unset or
 * malformed. A value of 0 is honored (disables that tier). */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** Global kill switch: set FL_RATELIMIT_DISABLED=1 to bypass all limiting. */
export function rateLimitDisabled(): boolean {
  const v = process.env.FL_RATELIMIT_DISABLED
  return v === '1' || v === 'true'
}
