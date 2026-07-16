/**
 * GET /api/admin/me — is the signed-in user a platform admin?
 * Used by the UI to decide whether to render operator-only surfaces (the
 * Shell tab). The real enforcement is server-side on each admin route; this
 * is only so a customer never even sees the control.
 */
import { isAdminRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export function GET(req: Request) {
  return Response.json({ admin: isAdminRequest(req), terminalEnabled: process.env.FL_TERMINAL === '1' })
}
