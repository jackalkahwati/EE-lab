/**
 * Physical evidence file upload. Accepts a real file (multipart), stores it
 * OUTSIDE public/ (data/evidence-artifacts/, never web-served), and records it
 * through the same audited addEvidence path — so the artifact_path points at a
 * real file on disk and the honesty gate ("physical evidence requires a REAL
 * artifact file") is satisfied by an actual upload, not a typed path.
 *
 * POST /api/evidence-upload  (multipart/form-data)
 *   fields: file, board_id, evidence_type, actor
 *
 * Safeguards: RBAC (upload_physical_evidence), 20 MB cap, filename sanitized,
 * evidence stays review-required (a reviewer must still accept it).
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
// @ts-ignore
import * as ent from '@/lib/enterprise/store.mjs'
// @ts-ignore
import * as rbac from '@/lib/enterprise/rbac.mjs'
// @ts-ignore
import * as integrations from '@/lib/enterprise/integrations.mjs'

export const dynamic = 'force-dynamic'

const MAX_BYTES = 20 * 1024 * 1024
const ART_DIR = path.join(process.cwd(), 'data', 'evidence-artifacts')

const safeName = (n: string) =>
  path.basename(n).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'artifact'

export async function POST(req: Request) {
  let form: FormData
  try { form = await req.formData() } catch { return Response.json({ error: 'expected multipart/form-data' }, { status: 400 }) }

  const file = form.get('file')
  const board_id = String(form.get('board_id') ?? '')
  const evidence_type = String(form.get('evidence_type') ?? '')
  const actor = String(form.get('actor') ?? '')
  const source = String(form.get('source') ?? '')

  if (!(file instanceof File)) return Response.json({ error: 'file is required' }, { status: 400 })
  if (!board_id || !evidence_type) return Response.json({ error: 'board_id and evidence_type required' }, { status: 400 })
  if (file.size === 0) return Response.json({ error: 'empty file' }, { status: 400 })
  if (file.size > MAX_BYTES) return Response.json({ error: `file exceeds ${MAX_BYTES / 1024 / 1024}MB` }, { status: 413 })

  const db = ent.loadDb()
  const gate = rbac.checkAction(db, actor, 'add_evidence', { board_id })
  if (!gate.ok) {
    ent.appendAudit(db, { actor, action: 'DENIED:add_evidence', scope: { board_id }, note: gate.reason })
    ent.saveDb(db)
    return Response.json({ error: 'permission denied', detail: gate.reason }, { status: 403 })
  }

  fs.mkdirSync(ART_DIR, { recursive: true })
  const stamp = 'art_' + crypto.randomBytes(6).toString('hex')
  const abs = path.join(ART_DIR, `${stamp}-${safeName(file.name)}`)
  fs.writeFileSync(abs, Buffer.from(await file.arrayBuffer()))

  const result = ent.addEvidence(db, {
    scope_type: 'board', scope_id: board_id, evidence_type,
    source: source || file.name, artifact_path: abs, actor,
  })
  if (result?.error) {
    try { fs.unlinkSync(abs) } catch { /* ignore */ }
    return Response.json(result, { status: 422 })
  }
  try { await integrations.fireWebhooks(db, 'evidence.added', { board_id, evidence_type, evidence_id: result.evidence_id }) } catch { /* best effort */ }
  ent.saveDb(db)
  return Response.json({ ok: true, result: { evidence_id: result.evidence_id, status: result.status, file: path.basename(abs), bytes: file.size } })
}
