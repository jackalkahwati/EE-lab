/**
 * Model catalog — the ONE place that defines which models a customer can pick
 * from the run-time selector, what plan each requires, and how much credit a
 * build on it costs.
 *
 * The freemium contract this encodes:
 *  - FREE users get Gemini Flash only (platform-funded; Google's free tier ≈ $0).
 *  - PRO / ENTERPRISE unlock the frontier models. Their subscription revenue
 *    pre-buys the credits a run burns, and each model's `creditMult` is set so a
 *    build's credit cost covers its real API cost — so the platform is never
 *    out of pocket.
 *  - BYOK (any plan) can run any model on the user's own key, bypassing both the
 *    plan gate and platform credits (see lib/plan-llm.ts).
 *  - The admin (Jack) runs the frontier via the Mac subscription proxy; that
 *    path is admin-only and never billed to a customer.
 *
 * `providerModel` is the literal string handed to the provider API. `provider`
 * must be a key in lib/llm.ts PROVIDERS. Concrete model strings are
 * env-overridable so a model rename doesn't need a code change.
 */
import type { Plan } from '@/lib/auth'

export interface CatalogModel {
  /** stable id sent from the selector (x-fl-model header) */
  id: string
  /** shown in the dropdown */
  label: string
  /** one-line capability/cost hint for the UI */
  blurb: string
  /** NATIVE PROVIDERS key in lib/llm.ts — used when a BYOK caller runs this
   *  model on their own key (their key is native, not OpenRouter). */
  provider: 'gemini' | 'anthropic' | 'openai'
  /** literal model string for the native provider API (BYOK path) */
  providerModel: string
  /** OpenRouter slug for the PLATFORM-funded path (taste + Pro/Enterprise all
   *  run through the one funded OpenRouter key). */
  openrouterModel: string
  /** lowest plan that may select it on platform credit (BYOK bypasses) */
  minPlan: Plan
  /** credit multiplier vs a baseline build — set to cover the model's API cost */
  creditMult: number
}

const geminiPro = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview'
const openaiModel = process.env.OPENAI_MODEL || 'gpt-5.1'
// OpenRouter slugs for the platform-funded path — env-overridable because
// OpenRouter renames slugs over time (verify against openrouter.ai/models once
// the account is funded).
const orSonnet = process.env.OR_SONNET_MODEL || 'anthropic/claude-sonnet-4.5'
const orOpus = process.env.OR_OPUS_MODEL || 'anthropic/claude-opus-4.1'
const orGpt = process.env.OR_GPT_MODEL || 'openai/gpt-5.1'
const orGeminiPro = process.env.OR_GEMINI_MODEL || 'google/gemini-2.5-pro'

export const MODELS: CatalogModel[] = [
  {
    id: 'claude-sonnet',
    label: 'Claude Sonnet',
    blurb: 'Balanced design quality and speed — the free-taste default.',
    provider: 'anthropic',
    providerModel: 'claude-sonnet-5',
    openrouterModel: orSonnet,
    minPlan: 'free',
    creditMult: 1.5,
  },
  {
    id: 'gemini-pro',
    label: 'Gemini Pro',
    blurb: 'Strong reasoning at lower cost.',
    provider: 'gemini',
    providerModel: geminiPro,
    openrouterModel: orGeminiPro,
    minPlan: 'free',
    creditMult: 1,
  },
  {
    id: 'gpt',
    label: openaiModel.toUpperCase(),
    blurb: 'OpenAI frontier reasoning.',
    provider: 'openai',
    providerModel: openaiModel,
    openrouterModel: orGpt,
    minPlan: 'free',
    creditMult: 2,
  },
  {
    id: 'claude-opus',
    label: 'Claude Opus — full force',
    blurb: 'The highest design fidelity. Best boards; costs the most.',
    provider: 'anthropic',
    providerModel: 'claude-opus-4-8',
    openrouterModel: orOpus,
    minPlan: 'free',
    creditMult: 4,
  },
]

const PLAN_RANK: Record<Plan, number> = { free: 0, pro: 1, enterprise: 2 }

export function planRank(plan: Plan): number {
  return PLAN_RANK[plan] ?? 0
}

export function findModel(id: string | null | undefined): CatalogModel | undefined {
  if (!id) return undefined
  return MODELS.find((m) => m.id === id)
}

/** The default model a plan lands on when the caller picks nothing. Everyone
 *  defaults to Sonnet — a genuinely good model (the tool underwhelms on weak
 *  ones), served on platform credit for the free taste and for Pro/Enterprise.
 *  Pro/Enterprise can pick a stronger model in the selector. */
export function defaultModelForPlan(_plan: Plan): CatalogModel {
  return MODELS.find((m) => m.id === 'claude-sonnet')!
}

/** Can this plan select this model on PLATFORM credit? (BYOK bypasses this.) */
export function modelAllowed(plan: Plan, model: CatalogModel): boolean {
  return planRank(plan) >= planRank(model.minPlan)
}

/** Models a plan may pick on platform credit, in catalog order. */
export function modelsForPlan(plan: Plan): CatalogModel[] {
  return MODELS.filter((m) => modelAllowed(plan, m))
}
