/**
 * Platform-spend gate — the ONE pre-check every LLM-calling route runs before
 * it can put inference on the platform's key (OPENROUTER_API_KEY or the
 * provider env keys in lib/llm.ts' fallback chain).
 *
 * Rules (mirrors the run route's quota logic, lib/auth.ts canRun):
 *   - admin            → never billed, always allowed
 *   - BYOK (header or stored account key) → their own meter, allowed
 *   - signed-in user   → needs at least 1 credit (charged at run END by
 *                        complexity — this is a pre-check, never a charge)
 *   - nobody / 0 credits → 402 JSON { error, code: 'insufficient_credits' }
 *
 * Deliberately a pre-check only: per-call charging would double-bill a run
 * whose stages are already charged once when the pipeline finishes.
 */
import { canRun, creditsAvailable, getUser, isAdminRequest, sessionEmail } from '@/lib/auth'
import { hasByok } from '@/lib/byok'

export const INSUFFICIENT_CREDITS = 'insufficient_credits'
export const SIGN_IN_REQUIRED = 'sign_in_required'

export interface SpendBlock {
  error: string
  code: typeof INSUFFICIENT_CREDITS | typeof SIGN_IN_REQUIRED
  credits?: number
}

/** Why this request may NOT spend platform-funded inference, or null when it may. */
export function spendBlockReason(req: Request): SpendBlock | null {
  if (isAdminRequest(req)) return null
  if (hasByok(req)) return null
  const email = sessionEmail(req)
  const user = email ? getUser(email) : null
  if (!user) {
    return {
      error: 'Sign in, or add your own model API key in settings, to run.',
      code: SIGN_IN_REQUIRED,
    }
  }
  if (!canRun(user)) {
    const credits = creditsAvailable(user)
    return {
      error: `You're out of credits (${credits} left). Top off, subscribe, or add your own model API key to keep running.`,
      code: INSUFFICIENT_CREDITS,
      credits,
    }
  }
  return null
}

/** 402 JSON Response when the request must not spend platform money, else null.
 *  Usage at the top of a route: `const gate = assertCanSpend(req); if (gate) return gate`. */
export function assertCanSpend(req: Request): Response | null {
  const block = spendBlockReason(req)
  return block ? Response.json(block, { status: 402 }) : null
}
