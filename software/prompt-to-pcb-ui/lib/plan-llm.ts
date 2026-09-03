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
import { spendBlockReason } from '@/lib/spend-gate'
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
  // Admin defaults to an Anthropic model so it routes to the Mac subscription
  // (their proxy-hybrid path); everyone else defaults to the catalog default.
  const model = requested ?? (admin ? findModel('claude-sonnet')! : defaultModelForPlan(plan))
  const byok = overrideForRequest(req)

  // 1) BYOK — the free tier's LLM source: user's own key + provider, any model.
  // Match the model string to their provider so we never send e.g. a Gemini
  // model string to an Anthropic key.
  if (byok?.apiKey) {
    const provider = byok.provider ?? model.provider
    const modelStr = requested && requested.provider === provider ? requested.providerModel : byok.model
    return {
      override: { provider, apiKey: byok.apiKey, model: modelStr },
      model,
      creditMult: 1,
      source: 'byok',
    }
  }

  // 2) Admin — the Mac subscription (Anthropic → CLI path). Jack's own testing;
  // not billed. Non-anthropic admin picks fall back to the subscription model.
  if (admin) {
    const m = model.provider === 'anthropic' ? model.providerModel : 'claude-sonnet-5'
    return { override: { model: m }, model, creditMult: 0, source: 'subscription' }
  }

  // 3) Non-admin without a key — the PLATFORM-funded path. When a funded
  // OpenRouter key is configured, free/Pro/Enterprise all run through it: the
  // model runs on the platform's key (so a signed-up user can generate WITHOUT
  // bringing their own key), gated by plan and billed via the model's creditMult
  // so subscription revenue covers the API cost. A free user who requests a
  // higher-tier model than their plan allows falls back to the plan default
  // (defense in depth; the selector already hides locked models).
  if (process.env.OPENROUTER_API_KEY) {
    const picked = modelAllowed(plan, model) ? model : defaultModelForPlan(plan)
    // Credit pre-check: platform money is never spent for an account at 0
    // credits (charging still happens once, at run end — lib/spend-gate.ts).
    const block = spendBlockReason(req)
    if (block) {
      return {
        override: {},
        model: picked,
        creditMult: picked.creditMult,
        source: 'platform',
        error: block.error,
        status: 402,
      }
    }
    return {
      override: { provider: 'openrouter', apiKey: process.env.OPENROUTER_API_KEY, model: picked.openrouterModel },
      model: picked,
      creditMult: picked.creditMult,
      source: 'platform',
    }
  }

  // 4) No platform key configured AND no BYOK — nothing to run inference on.
  // The run route surfaces this as a 402 before the pipeline; this is the
  // resolver's safety net so it never silently produces a keyless override.
  return {
    override: {},
    model,
    creditMult: 1,
    source: 'byok',
    error: 'Add your own model API key in settings to run, or subscribe once platform models are enabled.',
    status: 402,
  }
}
