/**
 * Pricing page (server component). Renders the tiers + credit model from config;
 * the interactive buttons live in the <PricingCta> client island so this file
 * can safely import server-only config (lib/plans → lib/auth).
 */
import { CREDIT_PACKS } from '@/lib/auth'
import { PLANS, SALES_EMAIL } from '@/lib/plans'
import { PricingCta } from '@/components/pricing-cta'

export const dynamic = 'force-dynamic'

export default function PricingPage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-12">
      <header className="mb-2 text-center">
        <h1 className="text-2xl font-semibold">Pricing</h1>
        <p className="mt-2 mx-auto max-w-2xl text-sm text-muted-foreground">
          FirstLight compresses years of product development into minutes. You pay
          for outcomes, not tokens — bring your own model key, and a plan buys
          platform runs, priced by board size. Free to explore; ship on a plan.
        </p>
      </header>

      <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {PLANS.map((tier) => (
          <div
            key={tier.id}
            className={`flex flex-col rounded-xl border p-5 ${
              tier.featured ? 'border-primary shadow-lg' : 'border-border'
            }`}
          >
            {tier.featured && (
              <span className="mb-2 self-start rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                Most popular
              </span>
            )}
            <h2 className="text-lg font-semibold">{tier.name}</h2>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="text-3xl font-bold">{tier.price}</span>
              <span className="text-xs text-muted-foreground">{tier.cadence}</span>
            </div>
            <p className="mt-1 text-sm font-medium text-primary">{tier.runs}</p>

            <ul className="mt-4 flex-1 space-y-2 text-sm">
              {tier.features.map((f) => (
                <li key={f} className="flex gap-2">
                  <span className="text-primary">✓</span>
                  <span className="text-muted-foreground">{f}</span>
                </li>
              ))}
            </ul>

            <PricingCta tierId={tier.id} cta={tier.cta} featured={tier.featured} />
          </div>
        ))}
      </div>

      {/* How credits work — the run unit */}
      <section className="mx-auto mt-12 max-w-3xl rounded-xl border border-border p-5">
        <h3 className="text-base font-semibold">How credits work</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          A run costs <strong>credits</strong> in proportion to what it produces —
          a simple board is a couple of credits, a dense or multi-board product
          costs more (metered by nets + components). Runs are deliberately
          valuable: each one advances a real product that would otherwise take an
          engineer weeks. The AI model runs on <strong>your own key</strong>, so
          credits only cover the platform work: routing, DRC, solvers, and CAD.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Your plan grant refreshes monthly. Keep polishing past it and you top
          off with credit packs — the deeper you iterate, the more it costs, but
          the subscription is always the cheapest per-credit way to buy runs.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {CREDIT_PACKS.map((p) => (
            <div key={p.id} className="rounded-lg border border-border p-3 text-center">
              <div className="text-lg font-bold">{p.credits} credits</div>
              <div className="text-sm text-muted-foreground">${(p.cents / 100).toFixed(0)}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                ${(p.cents / 100 / p.credits).toFixed(2)}/credit
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Top-off packs are priced per-credit above the Pro plan’s included rate — the
          subscription is the cheapest way to buy runs.
        </p>
      </section>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        Prices in USD. Enterprise is a custom annual quote — {SALES_EMAIL}.
      </p>
    </main>
  )
}
