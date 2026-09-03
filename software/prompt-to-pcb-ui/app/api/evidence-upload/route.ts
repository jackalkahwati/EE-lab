/**
 * Physical evidence file upload. Accepts a real file (multipart), stores it
 * OUTSIDE public/ (data/evidence-artifacts/, never web-served), and records it
 * through the same audited addEvidence path — so the artifact_path points at a
 * real file on disk and the honesty gate ("physical evidence requires a REAL
 * artifact file") is satisfied by an actual upload, not a typed path.
 *
 * POST /api/evidence-upload  (multipart/form-data)
 *   fields: file, board_id, evidence_type
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
import { sessionEmail } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const MAX_BYTES = 20 * 1024 * 1024
const ART_DIR = path.join(process.cwd(), 'data', 'evidence-artifacts')

const safeName = (n: string) =>
  path.basename(n).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'artifact'

export async function POST(req: Request) {
  const actor = sessionEmail(req)
  if (!actor) return Response.json({ error: 'sign in required' }, { status: 401 })
  let form: FormData
  try { form = await req.formData() } catch { return Response.json({ error: 'expected multipart/form-data' }, { status: 400 }) }

  const file = form.get('file')
  const board_id = String(form.get('board_id') ?? '')
  const evidence_type = String(form.get('evidence_type') ?? '')
  const source = String(form.get('source') ?? '')

  if (!(file instanceof File)) return Response.json({ error: 'file is required' }, { status: 400 })
  if (!board_id || !evidence_type) return Response.json({ error: 'board_id and evidence_type required' }, { status: 400 })
  if (file.size === 0) return Response.json({ error: 'empty file' }, { status: 400 })
  if (file.size > MAX_BYTES) return Response.json({ error: `file exceeds ${MAX_BYTES / 1024 / 1024}MB` }, { status: 413 })

  type EvidenceResult = { error: string } | { evidence_id: string; status: string }
  const addEvidence = ent.addEvidence as unknown as (
    database: unknown,
    input: Record<string, unknown>,
  ) => EvidenceResult
  // Every read-modify-write of the store happens INSIDE the store mutex with a
  // freshly loaded db (withStore): the upload's arrayBuffer() await used to sit
  // between load and save, so a concurrent enterprise action could be clobbered.
  const withStore = ent.withStore as unknown as <T>(fn: (db: unknown) => Promise<T> | T) => Promise<T>

  // 1. RBAC pre-check (fresh db; a denial is audited and persisted).
  let denied: { reason?: string } | null = null
  try {
    await withStore((db) => {
      const gate = rbac.checkAction(db, actor, 'add_evidence', { board_id })
      if (gate.ok) return false // nothing to persist
      denied = { reason: gate.reason }
      ent.appendAudit(db, { actor, action: 'DENIED:add_evidence', scope: { board_id }, note: gate.reason })
      return true
    })
  } catch (e) {
    if (ent.isStoreUnreadable(e)) return ent.storeUnreadableResponse()
    throw e
  }
  if (denied) return Response.json({ error: 'permission denied', detail: (denied as { reason?: string }).reason }, { status: 403 })

  // 2. Land the artifact on disk (outside the mutex — no store state involved).
  fs.mkdirSync(ART_DIR, { recursive: true })
  const stamp = 'art_' + crypto.randomBytes(6).toString('hex')
  const abs = path.join(ART_DIR, `${stamp}-${safeName(file.name)}`)
  fs.writeFileSync(abs, Buffer.from(await file.arrayBuffer()))

  // 3. Record it: re-load inside the mutex, re-check RBAC against the CURRENT
  //    membership, add the evidence, save. Webhooks fire after the save (they
  //    only read the org's webhook list; a failure must not roll back evidence).
  let result: EvidenceResult
  let dbForHooks: unknown = null
  try {
    result = await withStore((db) => {
      const gate = rbac.checkAction(db, actor, 'add_evidence', { board_id })
      if (!gate.ok) return { error: `permission denied: ${gate.reason}` } as EvidenceResult
      const r = addEvidence(db, {
        scope_type: 'board', scope_id: board_id, evidence_type,
        source: source || file.name, artifact_path: abs, actor,
      })
      dbForHooks = db
      return r
    })
  } catch (e) {
    try { fs.unlinkSync(abs) } catch { /* ignore */ }
    if (ent.isStoreUnreadable(e)) return ent.storeUnreadableResponse()
    throw e
  }
  if ('error' in result) {
    try { fs.unlinkSync(abs) } catch { /* ignore */ }
    return Response.json(result, { status: /^permission denied/.test(result.error) ? 403 : 422 })
  }
  try { await integrations.fireWebhooks(dbForHooks, 'evidence.added', { board_id, evidence_type, evidence_id: result.evidence_id }) } catch { /* best effort */ }
  return Response.json({ ok: true, result: { evidence_id: result.evidence_id, status: result.status, file: path.basename(abs), bytes: file.size } })
}
