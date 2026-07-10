/**
 * Rename a board — persists a user-set name to public/runs/<id>/name.txt, which
 * the runs list then prefers over the derived identity. Only the run's OWNER can
 * rename it (unowned demo/showcase boards are not user-renamable).
 *
 *   POST /api/runs/rename  { id, name }
 */
import fs from 'node:fs'
import path from 'node:path'
import { getUser, isValidRunId, sessionEmail } from '@/lib/auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: Request) {
  const email = sessionEmail(req)
  if (!email) return Response.json({ error: 'sign in required' }, { status: 401 })

  let body: { id?: string; name?: string } = {}
  try { body = await req.json() } catch { /* */ }
  const id = String(body.id ?? '')
  const name = String(body.name ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80)
  if (!isValidRunId(id)) return Response.json({ error: 'invalid run id' }, { status: 400 })
  if (!name) return Response.json({ error: 'name required' }, { status: 400 })

  // ownership: a user may only rename runs they own (never a shared demo board)
  const mine = new Set(getUser(email)?.runIds ?? [])
  if (!mine.has(id)) return Response.json({ error: 'not your board' }, { status: 403 })

  const dir = path.join(process.cwd(), 'public/runs', id)
  if (!fs.existsSync(dir)) return Response.json({ error: 'no such run' }, { status: 404 })
  try {
    fs.writeFileSync(path.join(dir, 'name.txt'), name)
  } catch (e: any) {
    return Response.json({ error: 'write failed', detail: String(e?.message ?? e).slice(0, 120) }, { status: 500 })
  }
  return Response.json({ ok: true, id, name })
}
