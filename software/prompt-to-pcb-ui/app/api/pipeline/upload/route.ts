/**
 * Manual KiCad round-trip: replace a run's editable board with a hand-fixed one.
 * The client downloads /runs/<id>/variant.kicad_pcb, fixes it in KiCad, then
 * POSTs the bytes back here. After this, call /api/pipeline/repair {op:'revalidate'}
 * to re-DRC and refresh the run's artifacts. Writes only public/runs/<id>/.
 *
 * POST /api/pipeline/upload?runId=<id>   body = raw .kicad_pcb text
 */
import fs from 'node:fs'
import path from 'node:path'
import { isValidRunId, runAccess } from '@/lib/auth'

export const dynamic = 'force-dynamic'
const MAX_BOARD_BYTES = 50 * 1024 * 1024

export async function POST(req: Request) {
  const id = new URL(req.url).searchParams.get('runId') ?? ''
  if (!isValidRunId(id)) {
    return Response.json({ error: 'a valid runId is required' }, { status: 400 })
  }
  const auth = runAccess(req, id)
  if (auth.access === 'unauthenticated') {
    return Response.json({ error: 'sign in required' }, { status: 401 })
  }
  if (auth.access !== 'owner') {
    return Response.json({ error: 'not your board' }, { status: 403 })
  }

  const runRoot = path.join(process.cwd(), 'public/runs', id)
  if (!fs.existsSync(runRoot))
    return Response.json({ error: 'unknown runId' }, { status: 404 })

  const declaredBytes = Number(req.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BOARD_BYTES) {
    return Response.json({ error: 'board file exceeds 50MB' }, { status: 413 })
  }
  const text = await req.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BOARD_BYTES) {
    return Response.json({ error: 'board file exceeds 50MB' }, { status: 413 })
  }
  // minimal sanity check: a KiCad PCB file starts with the (kicad_pcb s-expr.
  if (!text.trimStart().startsWith('(kicad_pcb'))
    return Response.json(
      { error: 'uploaded file does not look like a .kicad_pcb' },
      { status: 400 },
    )

  try {
    fs.writeFileSync(path.join(runRoot, 'variant.kicad_pcb'), text)
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 })
  }
  return Response.json({ ok: true, runId: id, bytes: text.length })
}
