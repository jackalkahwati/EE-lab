/**
 * Subscription tiers — the single source of truth for what each plan costs and
 * includes. Freemium and Pro are self-serve; Enterprise is a custom quote.
 *
 * v3 billing model: the LLM is always BYOK (the customer's own key), so a
 * subscription buys PLATFORM access — board runs (the schematic → routed-PCB →
 * BOM pipeline, sims, exports), not model inference. That's why the meter is
 * "runs", not tokens, and why we're never out of pocket on inference.
 *
 * The Pro price shown here must match the recurring Stripe Price you create
 * (its id goes in STRIPE_PRICE_ID). Override the display with
 * NEXT_PUBLIC_PRO_PRICE_USD without a code change.
 */
import { PLAN_CREDITS } from '@/lib/auth'

const proUsd = Number(process.env.NEXT_PUBLIC_PRO_PRICE_USD) || 49
const studioUsd = Number(process.env.NEXT_PUBLIC_STUDIO_PRICE_USD) || 499

export interface PlanTier {
  id: 'free' | 'pro' | 'studio' | 'enterprise'
  name: string
  /** display price, e.g. "$0", "$49", "Custom" */
  price: string
  /** billing cadence line under the price */
  cadence: string
  /** headline run allowance */
  runs: string
  features: string[]
  /** button label */
  cta: string
  /** true = the visually highlighted tier */
  featured?: boolean
}

export const SALES_EMAIL = process.env.NEXT_PUBLIC_SALES_EMAIL || 'hello@firstlight.build'

export const PLANS: PlanTier[] = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    cadence: 'explore',
    runs: `${PLAN_CREDITS.free} runs to try it`,
    features: [
      'Bring your own model key (any provider)',
      'Every model — Sonnet, GPT, Opus, Gemini',
      'Full pipeline: schematic → routed PCB → BOM',
      'Community support',
    ],
    cta: 'Start free',
  },
  {
    id: 'pro',
    name: 'Pro',
    price: `$${proUsd}`,
    cadence: 'per month',
    runs: `${PLAN_CREDITS.pro} runs / month, then top off`,
    features: [
      'Enough to build & ship a product or two',
      'Full exports — Gerbers, BOM, CAD, firmware',
      'Priority build queue',
      'Revision history & lineage',
      'Top off with credit packs any time',
      'Email support',
    ],
    cta: 'Start with Pro',
    featured: true,
  },
  {
    id: 'studio',
    name: 'Studio',
    price: `$${studioUsd}`,
    cadence: 'per month',
    runs: `${PLAN_CREDITS.studio} runs / month`,
    features: [
      'Everything in Pro',
      'For teams shipping products regularly',
      'Team seats & shared workspace',
      'Highest build priority',
      'Principal-EE design reviews',
      'Priority support',
    ],
    cta: 'Talk to us',
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 'Custom',
    cadence: 'annual quote',
    runs: 'Negotiated volume',
    features: [
      'Everything in Studio',
      'Private / on-prem deployment (your IP never leaves)',
      'SSO & role-based access',
      'Custom part libraries & design rules',
      'Dedicated support & SLA',
      'ITAR-ready for defense & space',
    ],
    cta: 'Contact sales',
  },
]
