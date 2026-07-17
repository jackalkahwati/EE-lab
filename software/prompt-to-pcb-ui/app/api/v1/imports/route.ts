/**
 * Programmatic "import an existing design" — API-key authenticated (NOT the
 * session cookie), minted in the Integrations console.
 *
 *   POST /api/v1/imports  (read_write scope)
 *     multipart/form-data: pcb=<file.kicad_pcb>? step=<file.step>? name=<string>?
 *
 * Creates a fresh product seeded from your PCBA and/or CAD assembly. The board
 * is verified with real KiCad DRC on ingest — same honest-verification core as
 * the Compose UI (lib/import-design). Synchronous; returns the run/product ids
 * and the board's honest stats. Poll GET /api/v1/runs/<runId> for detail.
 */
import { v1Auth } from '@/app/api/v1/_lib'
import { importDesign, validateUpload } from '@/lib/import-design'

export const dynamic = 'force-dynamic'
export const maxDuration = 600

export async function POST(req: Request) {
  const auth = v1Auth(req, { write: true })
  if (auth instanceof Response) return auth

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return Response.json({ error: 'expected multipart/form-data with pcb and/or step' }, { status: 400 })
  }
  const pcbFile = form.get('pcb')
  const stepFile = form.get('step')
  const name = String(form.get('name') ?? '')
  const pcbBuf = pcbFile instanceof File && pcbFile.size > 0 ? Buffer.from(await pcbFile.arrayBuffer()) : null
  const stepBuf = stepFile instanceof File && stepFile.size > 0 ? Buffer.from(await stepFile.arrayBuffer()) : null
  if (!pcbBuf && !stepBuf) {
    return Response.json({ error: 'upload a .kicad_pcb (PCBA) and/or a .step (CAD assembly)' }, { status: 400 })
  }
  const err = validateUpload(pcbBuf, 'pcb') ?? validateUpload(stepBuf, 'step')
  if (err) return Response.json({ error: err }, { status: 400 })

  const result = await importDesign({ pcbBuf, stepBuf, name, email: auth.email })
  return Response.json(
    {
      ...result,
      statusUrl: `/api/v1/runs/${result.runId}`,
      artifactsUrl: `/api/v1/runs/${result.runId}/artifacts`,
    },
    { status: 201 },
  )
}
