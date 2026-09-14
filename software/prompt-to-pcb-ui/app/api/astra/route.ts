import { astraConfigured, astraErrorResponse, authorizeAstra, beginAstraWorkflow, cancelAstraWorkflow, assertAstraCleanupConfirmed } from '@/lib/astra-beta'
import { astraNativeConfig } from '@/lib/astra-transport'
import { preflightAstraElectronics } from '@/lib/astra-local-parts'
import { readAstraBody } from '@/lib/astra-body'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  if (!astraConfigured()) return Response.json({ enabled: false })
  try {
    authorizeAstra(req)
    const blockers: string[] = []
    try { assertAstraCleanupConfirmed() } catch (error) { blockers.push(error instanceof Error ? error.message : 'Native cleanup is unconfirmed.') }
    try { astraNativeConfig() } catch { blockers.push('The isolated Astra CLI/proxy configuration is not ready.') }
    try { await preflightAstraElectronics() } catch (error) { blockers.push(error instanceof Error ? error.message : 'Native electronics preflight unavailable.') }
    return Response.json({ enabled: true, transport: 'astra-beta', model: 'gpt-6-astra', billing: 'Bedrock', scope: 'electronics-only', ready: blockers.length === 0, blockers }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) { return astraErrorResponse(error) }
}

export async function POST(req: Request) {
  if (!astraConfigured()) return Response.json({ error: 'Astra beta is not enabled.' }, { status: 404 })
  try {
    authorizeAstra(req)
    const body = await readAstraBody(req, 256)
    if (!body || typeof body !== 'object' || !('action' in body) || Object.keys(body).length !== 1) return Response.json({ error: 'Expected one Astra action.' }, { status: 400 })
    if (body.action === 'cancel') return Response.json(cancelAstraWorkflow(req))
    if (body.action !== 'begin') return Response.json({ error: 'Unknown Astra action.' }, { status: 400 })
    astraNativeConfig()
    await preflightAstraElectronics()
    return Response.json({ workflowId: beginAstraWorkflow(req) })
  } catch (error) { return astraErrorResponse(error) }
}
