/**
 * Keeps a long POST alive across a reverse proxy, without changing its contract.
 *
 * Cloudflare's edge drops a request that has produced NO response bytes for
 * ~100 seconds. A board build takes about three minutes, so on
 * app.firstlight.build every /api/electronics-cs POST died at ~90s and the
 * browser received Cloudflare's HTML error page instead of JSON — surfacing as
 * `SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`, which
 * says nothing about the real cause. The tunnel log is where it shows up:
 *
 *   ERR Request failed error="Incoming request ended abruptly: context canceled"
 *       dest=https://app.firstlight.build/api/electronics-cs
 *
 * That killed the Regenerate button outright, and the "run full pipeline"
 * button with it, because run-pipeline.ts executes in the BROWSER and POSTs
 * each stage from there. Only the initial design survived, because it is an
 * EventSource and a stream keeps the connection fed.
 *
 * The limit is on silence, not on duration. So: race the real handler for a
 * grace period, and
 *
 *   - if it finishes in time (every guard, every 400/401/402/403, every fast
 *     path), return its Response completely untouched — same status, same
 *     headers, same body. Nothing about those paths changes.
 *   - only if it is still running, commit to 200, emit a byte immediately to
 *     start the clock, and drip one space every interval until the real body
 *     is ready, then send it.
 *
 * A leading run of spaces is legal JSON whitespace, so `await res.json()` on
 * the client parses it unchanged. No caller needs to know this happened, which
 * is the point: the alternative was a job endpoint plus polling in every one of
 * the callers.
 *
 * The cost of the slow path is the status code: once headers are sent we are
 * committed to 200, so a late failure arrives as 200 with `{error}` in the
 * body. Every caller here already branches on `d.error`, and a late failure
 * reaching the client at all is a strict improvement on the connection dying.
 */

/** Grace period before committing to a streamed 200. Comfortably under the
 *  ~100s edge limit, and long enough that ordinary requests never stream. */
export const KEEPALIVE_AFTER_MS = 20_000
/** Gap between keepalive bytes once streaming. Must stay well under the edge
 *  idle limit; 15s gives ~6x headroom. */
export const KEEPALIVE_EVERY_MS = 15_000

export async function withKeepalive(
  work: Promise<Response>,
  opts: { afterMs?: number; everyMs?: number } = {},
): Promise<Response> {
  const afterMs = opts.afterMs ?? KEEPALIVE_AFTER_MS
  const everyMs = opts.everyMs ?? KEEPALIVE_EVERY_MS

  let settled = false
  const tracked = work.then(
    (r) => { settled = true; return r },
    (e) => { settled = true; throw e },
  )
  // Never let the race's loser surface as an unhandled rejection.
  tracked.catch(() => {})

  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    tracked.then((r) => ({ kind: 'done' as const, r }), (e) => ({ kind: 'failed' as const, e })),
    new Promise<{ kind: 'slow' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'slow' }), afterMs)
    }),
  ])
  if (timer) clearTimeout(timer)

  // Fast path: the handler's own Response, verbatim.
  if (outcome.kind === 'done') return outcome.r
  if (outcome.kind === 'failed') throw outcome.e

  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // First byte NOW — this is what stops the edge from timing the request out.
      controller.enqueue(enc.encode(' '))
      const tick = setInterval(() => {
        if (settled) return
        try { controller.enqueue(enc.encode(' ')) } catch { /* closed */ }
      }, everyMs)
      const finish = (text: string) => {
        clearInterval(tick)
        try { controller.enqueue(enc.encode(text)) } catch { /* closed */ }
        try { controller.close() } catch { /* already closed */ }
      }
      tracked.then(
        async (r) => {
          let text: string
          try {
            text = await r.text()
          } catch (e) {
            text = JSON.stringify({ error: `response body unreadable: ${String(e).slice(0, 200)}` })
          }
          // A non-2xx that arrives late loses its status (headers are long
          // gone) but keeps its body, so `d.error` still reaches the caller.
          finish(text)
        },
        (e) => finish(JSON.stringify({ error: String(e).slice(0, 300) })),
      )
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // tell any intermediary not to buffer this into uselessness
      'x-accel-buffering': 'no',
    },
  })
}
