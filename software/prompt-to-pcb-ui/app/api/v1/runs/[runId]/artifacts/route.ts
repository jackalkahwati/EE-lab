/**
 * GET /api/v1/runs/<runId>/artifacts — inventory of the run's real artifacts
 * (only kinds whose file actually exists; nothing is promised that isn't on
 * disk). API-key auth, ownership enforced.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { v1Auth, V1_RUN_ID, ARTIFACT_KINDS } from '@/app/api/v1/_lib'
import { runAccessByEmail } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const auth = v1Auth(req)
  if (auth instanceof Response) return auth
  const { runId } = await ctx.params
  if (!V1_RUN_ID.test(runId)) return Response.json({ error: 'invalid run id' }, { status: 400 })
  if (runAccessByEmail(auth.email, runId) === 'forbidden') {
    return Response.json({ error: 'not your board' }, { status: 403 })
  }
  const dir = path.join(process.cwd(), 'public', 'runs', runId)
  const artifacts: { kind: string; bytes: number; modifiedAt: string; mime: string; url: string }[] = []
  await Promise.all(Object.entries(ARTIFACT_KINDS).map(async ([kind, [rel, mime]]) => {
    try {
      const st = await fs.stat(path.join(dir, rel))
      if (st.isFile()) {
        artifacts.push({
          kind, bytes: st.size, modifiedAt: st.mtime.toISOString(), mime,
          url: `/api/v1/runs/${runId}/artifacts/${kind}`,
        })
      }
    } catch { /* kind not produced for this run */ }
  }))
  artifacts.sort((a, b) => a.kind.localeCompare(b.kind))
  return Response.json({ runId, count: artifacts.length, artifacts })
}
