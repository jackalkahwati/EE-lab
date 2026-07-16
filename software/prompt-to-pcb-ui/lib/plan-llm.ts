/**
 * Plan-aware model resolution — the single decision point that turns
 * (signed-in plan, BYOK headers, admin status, requested model) into the
 * LLMOverride the pipeline should run, plus the credit multiplier to charge.
 *
 * Precedence:
 *   1. BYOK (x-llm-key / stored account key) → the user's own key + provider,
 *      any model, NO platform credits, NO plan gate. They pay their own meter.
 *   2. Plan gate → a free user asking for a frontier model on platform credit is
 *      refused (status 402) with an upgrade/BYOK message. The UI hides locked
 *      models; this is server-side defense in depth.
 *   3. Admin → frontier via the Mac subscription proxy (anthropic models resolve
 *      to a model-only override so callLLMText takes the CLI/subscription path);
 *      other providers use the platform key. Never charged to a customer.
 *   4. Allowed platform pick → a provider PIN on the platform key; credit cost is
 *      scaled by the model's creditMult so subscription revenue covers the API.
 *
 * The selected model id arrives as the `x-fl-model` request header (see the
 * selector UI). Absent/unknown → the plan's default model.
 */
import { getUser, isAdminRequest, sessionEmail, type Plan } from '@/lib/auth'
import { overrideForRequest } from '@/lib/byok'
import type { LLMOverride } from '@/lib/llm'
import {
  defaultModelForPlan,
  findModel,
  modelAllowed,
  type CatalogModel,
} from '@/lib/model-catalog'

export const FL_MODEL_HEADER = 'x-fl-model'

export interface ResolvedModel {
  override: LLMOverride
  model: CatalogModel
  /** credit multiplier to pass creditsForRun; 0 = don't bill platform credits */
  creditMult: number
  source: 'byok' | 'subscription' | 'platform'
  /** set when the pick is refused for this plan (caller should 402) */
  error?: string
  status?: number
}

export function requestedModelId(req: Request): string | null {
  return req.headers.get(FL_MODEL_HEADER)?.trim() || null
}

export function resolvePlanModel(req: Request, requestedId?: string | null): ResolvedModel {
  const email = sessionEmail(req)
  const user = email ? getUser(email) : null
  const plan: Plan = user?.plan ?? 'free'
  const admin = isAdminRequest(req)
  const requested = findModel(requestedId ?? requestedModelId(req))
  // Admin's default is an Anthropic model so it routes to the Mac subscription
  // (their proxy-hybrid path); everyone else defaults per plan (free → Gemini).
  const model = requested ?? (admin ? findModel('claude-sonnet')! : defaultModelForPlan(plan))
  const byok = overrideForRequest(req)

  // 1) BYOK — their key, their bill. Match the model to their provider so we
  // never send e.g. a Gemini model string to an Anthropic key.
  if (byok?.apiKey) {
    const provider = byok.provider ?? model.provider
    const modelStr = requested && requested.provider === provider ? requested.providerModel : byok.model
    return {
      override: { provider, apiKey: byok.apiKey, model: modelStr },
      model,
      creditMult: 0,
      source: 'byok',
    }
  }

  // 2) Plan gate (platform credit only; admin bypasses).
  if (!admin && !modelAllowed(plan, model)) {
    const need = model.minPlan.charAt(0).toUpperCase() + model.minPlan.slice(1)
    return {
      override: {},
      model,
      creditMult: model.creditMult,
      source: 'platform',
      error: `${model.label} needs a ${need} plan. Upgrade, or add your own model API key in settings to run any model.`,
      status: 402,
    }
  }

  // 3) Admin — subscription for Anthropic (model-only → CLI path), OpenRouter
  // otherwise. Not billed to a customer.
  if (admin) {
    if (model.provider === 'anthropic') {
      return { override: { model: model.providerModel }, model, creditMult: 0, source: 'subscription' }
    }
    return { override: { provider: 'openrouter', model: model.openrouterModel }, model, creditMult: 0, source: 'platform' }
  }

  // 4) Allowed platform pick (free taste + Pro/Enterprise) — routed through the
  // one funded OpenRouter key, credit cost scaled by the model's multiplier so
  // subscription revenue covers the API bill.
  return {
    override: { provider: 'openrouter', model: model.openrouterModel },
    model,
    creditMult: model.creditMult,
    source: 'platform',
  }
}
