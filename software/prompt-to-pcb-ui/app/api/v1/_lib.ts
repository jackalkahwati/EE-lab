/**
 * Shared plumbing for the v1 programmatic API (CLI + MCP surface).
 * Auth is by API key (Authorization: Bearer flk_live_…) minted in the
 * Integrations console; a key resolves to its creator's account, which is the
 * identity every run is owned by and billed to.
 */
// @ts-ignore - plain ESM modules shared with node test scripts
import * as ent from '@/lib/enterprise/store.mjs'
// @ts-ignore
import * as integrations from '@/lib/enterprise/integrations.mjs'

export type V1Auth = { key: { name: string; scope: string; created_by?: string }; email: string }

export function v1Auth(req: Request, opts?: { write?: boolean }): V1Auth | Response {
  const h = req.headers.get('authorization') ?? ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  if (!m) {
    return Response.json({ error: 'missing API key (Authorization: Bearer flk_live_...)' }, { status: 401 })
  }
  let db: unknown
  try {
    db = ent.loadDb()
  } catch (e) {
    if (ent.isStoreUnreadable(e)) return ent.storeUnreadableResponse()
    throw e
  }
  const key = integrations.verifyApiKey(db, m[1].trim(), { requireWrite: opts?.write === true })
  if (!key) {
    return Response.json(
      { error: opts?.write ? 'invalid, revoked, or read-only API key (creating boards needs scope read_write)' : 'invalid or revoked API key' },
      { status: 401 })
  }
  ent.saveDb(db) // persist last_used
  const email = String(key.created_by ?? '').trim().toLowerCase()
  return { key, email }
}

export const V1_RUN_ID = /^run-[A-Za-z0-9._-]{1,128}$/

/** Curated artifact kinds: kind → [relative path within the run dir, mime]. */
export const ARTIFACT_KINDS: Record<string, [string, string]> = {
  spec: ['product-spec.json', 'application/json'],
  board: ['electronics/chipscale-board.json', 'application/json'],
  schematic: ['electronics/chipscale-schematic.svg', 'image/svg+xml'],
  layout: ['electronics/chipscale.svg', 'image/svg+xml'],
  pcb: ['electronics/chipscale.kicad_pcb', 'application/octet-stream'],
  'fab-package': ['fab/pcba-package.zip', 'application/zip'],
  step: ['mechanical/enclosure.step', 'application/step'],
  glb: ['mechanical/enclosure.glb', 'model/gltf-binary'],
  mechanical: ['mechanical/mechanical.json', 'application/json'],
  firmware: ['firmware/firmware.zip', 'application/zip'],
  bom: ['data/bom.csv', 'text/csv'],
  simulation: ['disciplines/simulation.json', 'application/json'],
  manufacturing: ['disciplines/manufacturing.json', 'application/json'],
  'supply-chain': ['disciplines/supplyChain.json', 'application/json'],
  validation: ['disciplines/validation.json', 'application/json'],
  'id-brief': ['disciplines/id-brief.json', 'application/json'],
  'concept-render': ['id/render.jpg', 'image/jpeg'],
  timing: ['timing.json', 'application/json'],
}
