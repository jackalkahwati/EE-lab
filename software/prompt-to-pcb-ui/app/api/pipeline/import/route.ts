/**
 * Start-from-existing-design import (session-authenticated, for the Compose UI).
 * Creates a fresh product from an uploaded PCBA (.kicad_pcb) and/or CAD assembly
 * (.step). See lib/import-design for the honest-verification core, shared with
 * the programmatic API (app/api/v1/imports).
 *
 * POST multipart/form-data: pcb=<file.kicad_pcb>? step=<file.step>? name=<string>?
 */
import {
  canRun,
  creditsAvailable,
  getUser,
  isAdminRequest,
  sessionEmail,
} from '@/lib/auth'
import { importDesign, validateUpload } from '@/lib/import-design'

export const dynamic = 'force-dynamic'
export const maxDuration = 600

export async function POST(req: Request) {
  const email = sessionEmail(req)
  if (!email) return Response.json({ error: 'sign in required' }, { status: 401 })
  const userRec = getUser(email)
  if (!userRec) return Response.json({ error: 'unknown account' }, { status: 401 })
  if (!canRun(userRec) && !isAdminRequest(req)) {
    return Response.json(
      { error: `You've used your free runs (${creditsAvailable(userRec)} left). Subscribe to unlock more.` },
      { status: 402 },
    )
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return Response.json({ error: 'expected multipart/form-data' }, { status: 400 })
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

  const result = await importDesign({ pcbBuf, stepBuf, name, email })
  return Response.json(result)
}
