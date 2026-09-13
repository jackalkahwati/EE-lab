# FirstLight Deployment — firstlight.build

Two apps, two hosts. Domain `firstlight.build` was purchased through Vercel.

| App | Directory | Host | Domain |
|---|---|---|---|
| Marketing site | `software/firstlight-website` | **Vercel** (stateless) | `firstlight.build` |
| Compose (product) | `software/prompt-to-pcb-ui` | **Persistent host** (needs disk) | `app.firstlight.build` |

Payment mode is an explicit operational decision, not a deployment step. Do not
change Stripe keys as part of a website release. Verified test-mode returns say
**test checkout**, not that a real reservation was placed. Live payments,
refunds, and fulfillment require separate authorization and acceptance testing.

---

## 1. Marketing site → Vercel (ready today)

Stateless Next 15 app. Reservations go through Stripe Checkout; no server-side
storage. Deploys cleanly on Vercel serverless.

**Vercel project settings**
- Root Directory: `software/firstlight-website`
- Framework preset: Next.js (auto-detected)
- Domain: `firstlight.build` (assign in Vercel → Domains)

**Environment variables (Production scope)**

| Var | Value | Why |
|---|---|---|
| `APP_URL` | `https://firstlight.build` | Required in prod — Stripe redirect origin. Reservations fail closed without it. |
| `NEXT_PUBLIC_COMPOSE_URL` | `https://app.firstlight.build` | Where the "Try Compose" button sends users. Build-time inlined — must be set before/at build. |
| `STRIPE_SECRET_KEY` | *(existing server-side key; never commit)* | Stripe Checkout creation/verification and browser-binding signature. Preserve the selected payment mode. |
| `STRIPE_RESERVATION_AMOUNT_CENTS` | `250000` (default) | Positive integer USD cents. Shared by Checkout, FL-1 copy, and Terms; price-bearing pages render dynamically. |

`STRIPE_RESERVATION_PRICE` is not used: Checkout creates inline price data.
Verification binds the original amount/currency in a signed, short-lived,
HttpOnly browser cookie, so changing the configured price during checkout does
not invalidate that session. `reserved=1` is not proof of payment. A missing or
expired cookie/session returns an unverified state, not a success or an
instruction to pay twice.

The shared site origin defaults to `https://firstlight.build`; public Compose
links default to `https://app.firstlight.build`. Set public origins before the
build. Keep the marketing handoff origin identical to Compose's OAuth `APP_URL`:
`/start#prompt=...` stores a short-lived draft in origin-scoped, same-tab
sessionStorage, scrubs the fragment, and opens a new design after login. It
never starts generation automatically. Legacy `?prompt=` links are not a private
transport and should not be published.

For the existing locally linked Vercel project, deploy from
`software/firstlight-website` with `vercel deploy --prod --yes` after CI and the
Compose release pass. Do not upload the repository root or environment files.
Record the previous deployment URL first so it can be promoted on rollback.

---

## 2. Compose → persistent host (NOT Vercel serverless)

Compose persists to the local filesystem:
- `data/users.json` — accounts (scrypt password hashes)
- `data/runs-index.json` — run index cache
- `public/runs/<id>/…` — run artifacts + user-set board names (written at runtime)
- `ENTERPRISE_STORE_DIR` — enterprise workspace store

Vercel serverless has a read-only filesystem (only `/tmp`, which is ephemeral
and per-invocation), so accounts and artifacts would not survive. Compose needs
a host with a **persistent disk** and a **long-running process**.

**Host options (any works; pick one):**
- **Fly.io** — `fly launch` + a mounted volume for `data/` and `public/runs`. Cheapest path to a persistent Next server.
- **Railway / Render** — attach a persistent disk; point the service at `software/prompt-to-pcb-ui`.
- **A VM/droplet (EC2, DO, Hetzner)** — run `next start` behind nginx/caddy with TLS; disk is persistent by default.

Whatever the host: run `npm run build` then `npm start` (or the platform's Next
runtime), mount a volume covering `data/` and `public/runs/`, and point
`app.firstlight.build` DNS at it.

**Environment variables (Production)**

| Var | Value | Why |
|---|---|---|
| `AUTH_SECRET` | *(48-byte random — generate with `openssl rand -base64 48`)* | **Critical.** Without it, prod login is disabled and no session validates. Never commit it. |
| `APP_URL` | `https://app.firstlight.build` | Builds the Google OAuth redirect URI (`<APP_URL>/api/auth/google/callback`). |
| `NODE_ENV` | `production` | Enables the `Secure` cookie flag (most hosts set this automatically). |
| `ENTERPRISE_STORE_DIR` | *(path on the mounted volume)* | Enterprise store location — must be on persistent disk. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | *(from `.env.local`)* | "Continue with Google". |
| `STRIPE_SECRET_KEY` / `STRIPE_PRICE_ID` | *(test values from `.env.local`)* | Credits/billing. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `NVIDIA_API_KEY` (+ `*_MODEL`) | *(from `.env.local`)* | Model providers used by the pipeline. |
| `DIGIKEY_*`, `NEXAR_*`, `JLCPCB_*`, `MACROFAB_API_KEY`, `PCBWAY_API_KEY` | *(from `.env.local`)* | Parts sourcing + fab quotes. |

---

## 3. Google OAuth console (required for "Continue with Google")

In the Google Cloud console for the existing OAuth client
(`GOOGLE_CLIENT_ID`), add:
- **Authorized redirect URI:** `https://app.firstlight.build/api/auth/google/callback`
- **Authorized JavaScript origin:** `https://app.firstlight.build`

Keep the existing `http://localhost:4500/...` entries for local dev.

---

## 4. DNS (managed by Vercel, since the domain lives there)

- `firstlight.build` → Vercel marketing project (automatic when you assign the domain).
- `app.firstlight.build` → CNAME/A record to the Compose host. If Compose is on
  Fly/Railway/Render, point the subdomain at the host's target; if on Vercel
  (only viable after migrating storage off the filesystem), assign it there.

---

## 5. Post-deploy verification

Deploy Compose **before** the website: the new website depends on `/start`.
For the current Mac service and rollback safeguards, use
`software/prompt-to-pcb-ui/deploy/OPS.md`, not the alternative-host examples above.

Read-only smoke checks (block telemetry and unapproved requests before browser
navigation):
1. Marketing routes, icon, robots, sitemap, and route-specific metadata load.
2. Unknown routes return HTTP 404 with recovery links.
3. Keyboard skip goes past navigation; FL-1 Reserve is visible on mobile/tablet.
4. Public `/start` without a description loads on `app.firstlight.build`; the
   protected composer redirects anonymous visitors to login.
5. There are no unexpected runtime errors. Record intentionally blocked requests
   separately from application failures.

Run synthetic draft/auth and mocked Stripe regressions locally with isolated
state. Do not create production accounts, submit confidential descriptions,
start a design, or initiate checkout as part of passive smoke testing. Actual
OAuth completion, paid generation, payment/refund/fulfillment, alert delivery,
real-device accessibility, and field Core Web Vitals remain separate acceptance
gates. Mocked tests do not certify them.

---

## Not blocking launch (follow-ups)
- Compose build emits ~10 non-fatal Turbopack tracing warnings (dynamic artifact paths).
- `/api/pipeline/run` is a state-changing GET (uses EventSource); move to POST streaming + CSRF later.
- Authorize and verify live Stripe payments/refunds and fulfillment separately before accepting real deposits.
- Longer term: migrate Compose storage (accounts/artifacts) to Postgres + blob storage so it can run on Vercel/serverless.
