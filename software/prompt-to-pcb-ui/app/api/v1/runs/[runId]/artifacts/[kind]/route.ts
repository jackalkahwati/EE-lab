/**
 * GET /api/v1/runs/<runId>/artifacts/<kind> — download one artifact.
 * Kinds are a curated allowlist (see ARTIFACT_KINDS) — no free-form paths, so
 * traversal is impossible by construction. API-key auth, ownership enforced.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { v1Auth, V1_RUN_ID, ARTIFACT_KINDS } from '@/app/api/v1/_lib'
import { runAccessByEmail } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request, ctx: { params: Promise<{ runId: string; kind: string }> }) {
  const auth = v1Auth(req)
  if (auth instanceof Response) return auth
  const { runId, kind } = await ctx.params
  if (!V1_RUN_ID.test(runId)) return Response.json({ error: 'invalid run id' }, { status: 400 })
  if (runAccessByEmail(auth.email, runId) === 'forbidden') {
    return Response.json({ error: 'not your board' }, { status: 403 })
  }
  const entry = ARTIFACT_KINDS[kind]
  if (!entry) {
    return Response.json(
      { error: `unknown artifact kind '${kind}'`, kinds: Object.keys(ARTIFACT_KINDS) },
      { status: 404 })
  }
  const [rel, mime] = entry
  try {
    const buf = await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, rel))
    return new Response(new Uint8Array(buf), {
      headers: {
        'content-type': mime,
        'content-length': String(buf.byteLength),
        'content-disposition': `attachment; filename="${runId}-${path.basename(rel)}"`,
        'cache-control': 'private, no-store',
      },
    })
  } catch {
    return Response.json({ error: `artifact '${kind}' not produced for this run` }, { status: 404 })
  }
}
