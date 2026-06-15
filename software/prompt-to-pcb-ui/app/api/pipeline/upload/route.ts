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

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const id = (new URL(req.url).searchParams.get('runId') ?? '').replace(/[^a-zA-Z0-9_-]/g, '')
  if (!id) return Response.json({ error: 'runId is required' }, { status: 400 })

  const runRoot = path.join(process.cwd(), 'public/runs', id)
  if (!fs.existsSync(runRoot))
    return Response.json({ error: 'unknown runId' }, { status: 404 })

  const text = await req.text()
  // minimal sanity check: a KiCad PCB file starts with the (kicad_pcb s-expr.
  if (!text.includes('(kicad_pcb'))
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
