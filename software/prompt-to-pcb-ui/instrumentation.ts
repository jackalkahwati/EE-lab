/**
 * Server-process bootstrap (Next instrumentation hook).
 *
 * Node's fetch (undici) defaults to a 300s headersTimeout — any internal
 * route-to-route call whose response takes >5 min dies with a bare
 * "TypeError: fetch failed". Several of our stages LEGITIMATELY exceed that
 * on the slow LLM tier (electronics-cs with catalog sourcing, mechanical
 * with fidelity judge rounds): the v1 smoke run failed at exactly 301s.
 *
 * Raise the process-wide dispatcher limits to 30 min (the longest honest
 * stage wall). Uses Node's internal undici via its documented global-
 * dispatcher symbol because this tree's npm currently cannot install the
 * undici package (lockfile bug) and Next no longer bundles a compiled copy.
 * The constructor-from-instance trick keeps us version-agnostic.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return
  try {
    // touch fetch so undici materializes its global dispatcher
    fetch('http://127.0.0.1:1/', { signal: AbortSignal.timeout(50) }).catch(() => {})
    await new Promise((r) => setTimeout(r, 150))
    const sym = Symbol.for('undici.globalDispatcher.1')
    const g = globalThis as Record<PropertyKey, unknown>
    const current = g[sym] as { constructor: new (o: object) => unknown } | undefined
    if (!current) {
      console.warn('[instrumentation] undici global dispatcher not found — fetch timeouts stay at defaults')
      return
    }
    const AgentCtor = current.constructor
    g[sym] = new AgentCtor({
      headersTimeout: 1_800_000,
      bodyTimeout: 1_800_000,
      connectTimeout: 30_000,
    })
    console.log('[instrumentation] fetch dispatcher timeouts raised to 30min (long pipeline stages)')
  } catch (e) {
    console.warn('[instrumentation] dispatcher swap failed — fetch timeouts stay at defaults:', e)
  }
}
