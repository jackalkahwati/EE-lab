/**
 * Targeted edit (Phase 3) — the cmd-K execution path.
 *   POST {runId, message, dryRun:true}  → classification + re-run preview
 *   POST {runId, message}               → fork the run, apply the change
 *     (spec patch and/or change-request), enqueue an incremental rebuild:
 *     stages the change invalidates re-run, everything else skips as current.
 * Owner-only (it mutates the product's lineage). Electronics-scoped changes
 * are refused here — the chat routes those through the full architect path.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { runAccess, isValidRunId } from '@/lib/auth'
import { overrideForRequest } from '@/lib/byok'
import { assertCanSpend } from '@/lib/spend-gate'
import { classifyEdit } from '@/lib/edit-intent'
import { forkRun } from '@/lib/run-fork'
import { recordRun } from '@/lib/auth'
import { trackRun } from '@/lib/design-state'
import { enqueueBuild, queueDepth } from '@/lib/v1-jobs'
import { withKeepalive } from '@/lib/keepalive'

export const dynamic = 'force-dynamic'

function deepMerge(dst: any, src: any) {
  for (const [k, v] of Object.entries(src ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') {
      deepMerge(dst[k], v)
    } else {
      dst[k] = v
    }
  }
}

/**
 * Model-backed and slow, so Cloudflare's ~100s no-bytes cap kills it over the
 * tunnel — /api/interview died there and took a whole build with it.
 * withKeepalive returns fast responses untouched. See lib/keepalive.ts.
 */
export async function POST(req: Request): Promise<Response> {
  return withKeepalive(handlePost(req))
}

async function handlePost(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const runId = typeof body?.runId === 'string' ? body.runId : ''
    const message = typeof body?.message === 'string' ? body.message.trim() : ''
    if (!isValidRunId(runId) || message.length < 4) {
      return Response.json({ error: 'invalid run/message' }, { status: 400 })
    }
    const a = runAccess(req, runId)
    if (a.access === 'unauthenticated') return Response.json({ error: 'sign in required' }, { status: 401 })
    if (a.access !== 'owner' && a.access !== 'shared') {
      return Response.json({ error: 'not your board' }, { status: 403 })
    }

    const specPath = path.join(process.cwd(), 'public', 'runs', runId, 'product-spec.json')
    let spec: any
    try { spec = JSON.parse(await fs.readFile(specPath, 'utf8')) }
    catch { return Response.json({ error: 'run has no product spec (targeted edits need a built product)' }, { status: 400 }) }

    // Spend gate before the classifier — the dryRun path calls it too, so an
    // account at 0 credits must not be able to spend by asking for an estimate.
    {
      const gate = assertCanSpend(req)
      if (gate) return gate
    }

    const intent = await classifyEdit(
      message,
      `${spec.product ?? ''} — ${String(spec.description ?? '').slice(0, 160)}`,
      overrideForRequest(req))

    if (body?.dryRun) {
      return Response.json({
        ...intent,
        // honest expectation: mechanical ~2-4 min (Onshape), simulation ~30 s,
        // each doc ~1 min (concurrent); stages outside scope skip as current.
        estimate: intent.targetable
          ? (intent.scope.includes('mechanical') ? '2–5 min' : '1–3 min')
          : 'full redesign (~7 min)',
      })
    }
    if (!intent.targetable) {
      return Response.json({ error: 'electronics-scoped change — use the full redesign path', ...intent }, { status: 409 })
    }
    if (queueDepth() >= 5) {
      return Response.json({ error: 'build queue is full — retry later' }, { status: 429 })
    }

    // Fork → apply the change to the fork's INPUTS → incremental rebuild.
    const fork = await forkRun(runId, intent.note)
    const forkDir = path.join(process.cwd(), 'public', 'runs', fork)
    if (intent.specPatch?.budgets) {
      const fSpec = JSON.parse(await fs.readFile(path.join(forkDir, 'product-spec.json'), 'utf8'))
      fSpec.budgets = fSpec.budgets ?? {}
      deepMerge(fSpec.budgets, intent.specPatch.budgets)
      await fs.writeFile(path.join(forkDir, 'product-spec.json'), JSON.stringify(fSpec))
    }
    // The change request is an INPUT to the scoped stages: design-graph hashes
    // it, so exactly those stages go stale; their routes read it as an
    // engineer instruction.
    await fs.mkdir(path.join(forkDir, 'data'), { recursive: true })
    await fs.writeFile(path.join(forkDir, 'data', 'change-request.json'),
      JSON.stringify({ message, areas: intent.scope, note: intent.note, createdAt: new Date().toISOString() }))

    if (a.email) recordRun(a.email, fork)
    trackRun(fork, a.email)
    const baseUrl = process.env.FL_SELF_URL || new URL(req.url).origin
    enqueueBuild(intent.note, a.email ?? '', baseUrl, { rebuildRunId: fork })
    return Response.json({ runId: fork, parentRunId: runId, ...intent })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
