# FirstLight Deployment — firstlight.build

Two apps, two hosts. Domain `firstlight.build` was purchased through Vercel.

| App | Directory | Host | Domain |
|---|---|---|---|
| Marketing site | `software/firstlight-website` | **Vercel** (stateless) | `firstlight.build` |
| Compose (product) | `software/prompt-to-pcb-ui` | **Persistent host** (needs disk) | `app.firstlight.build` |

Stripe stays in **test mode** for launch (reserve button works, collects
email/name via Stripe Checkout, no card is charged). Flip to live keys later.

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
| `STRIPE_SECRET_KEY` | *(test key from `.env.local`)* | Stripe Checkout session creation. |
| `STRIPE_RESERVATION_PRICE` | *(test price id from `.env.local`)* | The reservation deposit price. |

That's the whole marketing site. Nothing else is required.

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

## 5. Post-deploy smoke test

1. `https://firstlight.build` loads; "Try Compose" → `https://app.firstlight.build`.
2. Reserve button → Stripe Checkout opens (test card `4242 4242 4242 4242`).
3. `https://app.firstlight.build` → login page.
4. Sign up → lands in the app (proves `AUTH_SECRET` + persistent disk work).
5. "Continue with Google" → completes (proves OAuth redirect URI is whitelisted).
6. Reload after signup → still logged in (proves the session cookie is `Secure` and the store persisted).

---

## Not blocking launch (follow-ups)
- Compose build emits ~10 non-fatal Turbopack tracing warnings (dynamic artifact paths).
- `/api/pipeline/run` is a state-changing GET (uses EventSource); move to POST streaming + CSRF later.
- Flip Stripe to live keys when you want real reservation deposits.
- Longer term: migrate Compose storage (accounts/artifacts) to Postgres + blob storage so it can run on Vercel/serverless.
