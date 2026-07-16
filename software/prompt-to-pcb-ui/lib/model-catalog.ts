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
  /** PROVIDERS key in lib/llm.ts */
  provider: 'gemini' | 'anthropic' | 'openai'
  /** literal model string for the provider API */
  providerModel: string
  /** lowest plan that may select it on platform credit (BYOK bypasses) */
  minPlan: Plan
  /** credit multiplier vs a baseline build — set to cover the model's API cost */
  creditMult: number
}

const geminiFree = process.env.GEMINI_FREE_MODEL || 'gemini-flash-latest'
const geminiPro = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview'
const openaiModel = process.env.OPENAI_MODEL || 'gpt-5.1'

export const MODELS: CatalogModel[] = [
  {
    id: 'gemini-flash',
    label: 'Gemini Flash',
    blurb: 'Fast and free — good for exploring and first drafts.',
    provider: 'gemini',
    providerModel: geminiFree,
    minPlan: 'free',
    creditMult: 0.4,
  },
  {
    id: 'gemini-pro',
    label: 'Gemini Pro',
    blurb: 'Stronger reasoning at low cost.',
    provider: 'gemini',
    providerModel: geminiPro,
    minPlan: 'pro',
    creditMult: 1,
  },
  {
    id: 'claude-sonnet',
    label: 'Claude Sonnet',
    blurb: 'Balanced design quality and speed.',
    provider: 'anthropic',
    providerModel: 'claude-sonnet-5',
    minPlan: 'pro',
    creditMult: 1.5,
  },
  {
    id: 'gpt',
    label: openaiModel.toUpperCase(),
    blurb: 'OpenAI frontier reasoning.',
    provider: 'openai',
    providerModel: openaiModel,
    minPlan: 'pro',
    creditMult: 2,
  },
  {
    id: 'claude-opus',
    label: 'Claude Opus — full force',
    blurb: 'The highest design fidelity. Best boards; costs the most.',
    provider: 'anthropic',
    providerModel: 'claude-opus-4-8',
    minPlan: 'pro',
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

/** The default model a plan lands on when the caller picks nothing. */
export function defaultModelForPlan(plan: Plan): CatalogModel {
  // Free stays on Flash; paid plans default to Sonnet (solid design quality
  // without jumping straight to the priciest tier).
  return plan === 'free' ? MODELS[0] : MODELS.find((m) => m.id === 'claude-sonnet')!
}

/** Can this plan select this model on PLATFORM credit? (BYOK bypasses this.) */
export function modelAllowed(plan: Plan, model: CatalogModel): boolean {
  return planRank(plan) >= planRank(model.minPlan)
}

/** Models a plan may pick on platform credit, in catalog order. */
export function modelsForPlan(plan: Plan): CatalogModel[] {
  return MODELS.filter((m) => modelAllowed(plan, m))
}
