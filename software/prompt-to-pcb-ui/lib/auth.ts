/**
 * Account system for the private preview: file-backed user store + signed
 * session cookies. No external service, no plaintext passwords (scrypt).
 *
 * Store lives at data/users.json (gitignored, NOT under public/). This is
 * deliberately simple for the lab/preview deployment; the swap to Postgres/KV
 * at production deploy only touches this file, every route goes through
 * these helpers.
 *
 * Session cookie: base64url(email)|expiresMs|v<sessionVersion>|hmacSHA256(payload, AUTH_SECRET).
 * The middleware (edge) verifies the same format with crypto.subtle. Legacy
 * 3-segment tokens (no version segment) are still accepted as version 0, so
 * sessions issued before per-user revocation existed keep working until a
 * user's sessionVersion is bumped (revokeSessions / OAuth takeover).
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Subscription tier. LLM is always BYOK (v3) — a plan buys PLATFORM runs, not
 *  inference. Value-based: a run costs credits by its size, and a full product
 *  is worth compressing years of dev, so runs are deliberately scarce. */
export type Plan = 'free' | 'pro' | 'studio' | 'enterprise'

export interface UserRecord {
  email: string
  salt: string
  hash: string
  plan: Plan
  createdAt: string
  runIds: string[]
  usage: { month: string; runs: number }
  /** plan grant, reset to the plan allowance each calendar month (use-or-lose) */
  planCredits: number
  planCreditsMonth: string
  /** purchased credits, never expire, roll over, spent after plan credits */
  extraCredits: number
  stripeCustomerId?: string
  /** Stripe Checkout session ids already applied; prevents webhook retries
   * and confirmation retries from granting the same purchase twice. */
  processedCheckoutSessions?: string[]
  /** 'google' accounts have no usable password hash */
  provider?: 'google'
  /** true once the address was proven (today: a verified Google identity) */
  emailVerified?: boolean
  /** Bumped to invalidate every outstanding session cookie (missing = 0). */
  sessionVersion?: number
  /** Stripe subscription health; 'past_due' keeps the plan while Stripe retries. */
  billingStatus?: 'active' | 'past_due'
  /** Stripe event ids already applied (webhook retries are idempotent). */
  processedStripeEvents?: string[]
}

const STORE_DIR = path.join(process.cwd(), 'data')
const STORE = path.join(STORE_DIR, 'users.json')

// ---- credits & plans (tune here) --------------------------------------------
// A board run costs credits scaled by its complexity (nets + components), so
// the person generating expensive boards pays for them. 1 credit ~= one simple
// board. See creditsForRun().
// Monthly plan grant — deliberately SCARCE. A run costs credits by board size,
// and FirstLight compresses years of product dev, so runs are valuable: Pro is
// a couple of products' worth, then you top off. Studio is for teams shipping
// regularly; Enterprise is a high pooled allowance (contact-sales / manual grant).
export const PLAN_CREDITS: Record<Plan, number> = { free: 3, pro: 20, studio: 150, enterprise: 2000 }

// Top-off packs — priced ABOVE the subscription's included rate (Pro is
// ~$2.45/credit) so the subscription stays the cheapest way to buy runs. The
// deeper you polish, the more it costs. One-time, never expire, spent after the
// monthly grant. Priced inline at checkout (no pre-created Stripe prices needed).
export const CREDIT_PACKS = [
  { id: 'small', credits: 10, cents: 4900 }, //  $49  · $4.90/credit
  { id: 'mid', credits: 30, cents: 11900 }, //   $119 · $3.97/credit
  { id: 'large', credits: 100, cents: 34900 }, // $349 · $3.49/credit
] as const

/** Credits a run costs, from its board complexity times the model's cost
 *  multiplier (lib/model-catalog.ts creditMult). A frontier model burns more so
 *  the credits the customer pre-bought cover its API bill. Round up, min 1. */
export function creditsForRun(nets: number, components: number, modelMult = 1): number {
  const base = ((nets || 0) + (components || 0)) / 25
  return Math.max(1, Math.round(base * (modelMult > 0 ? modelMult : 1)))
}

export const FREE_RUNS_PER_MONTH = 5 // legacy export; superseded by credits
export const SESSION_COOKIE = 'fl_session'
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000
const DEV_AUTH_SECRET = 'firstlight-dev-secret'

export function authSecret(): string {
  const configured = process.env.AUTH_SECRET || process.env.FL_PASSWORD
  if (configured) return configured
  // A checked-in fallback is convenient for local preview work, but accepting
  // it in production would let anyone forge an arbitrary account session.
  if (process.env.NODE_ENV !== 'production') return DEV_AUTH_SECRET
  throw new Error('AUTH_SECRET is required in production')
}

// ---- store ------------------------------------------------------------------

function load(): Record<string, UserRecord> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(STORE, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('user store root must be an object')
    }
    return parsed as Record<string, UserRecord>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    // Never reinterpret a corrupt/unreadable account store as an empty one:
    // a subsequent signup or update would otherwise overwrite every account.
    throw new Error('user store is unreadable', { cause: error })
  }
}

function save(users: Record<string, UserRecord>) {
  fs.mkdirSync(STORE_DIR, { recursive: true })
  const tmp = STORE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(users, null, 1))
  fs.renameSync(tmp, STORE)
}

function norm(email: string): string {
  return email.trim().toLowerCase()
}

// ---- accounts -----------------------------------------------------------------

export function createUser(email: string, password: string): UserRecord | { error: string } {
  const e = norm(email)
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { error: 'enter a valid email' }
  if (password.length < 8) return { error: 'password must be at least 8 characters' }
  const users = load()
  if (users[e]) return { error: 'an account with this email already exists' }
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 32).toString('hex')
  const month = new Date().toISOString().slice(0, 7)
  const rec: UserRecord = {
    email: e,
    salt,
    hash,
    plan: 'free',
    createdAt: new Date().toISOString(),
    runIds: [],
    usage: { month, runs: 0 },
    planCredits: PLAN_CREDITS.free,
    planCreditsMonth: month,
    extraCredits: 0,
  }
  users[e] = rec
  save(users)
  return rec
}

/**
 * Find-or-create an account from a verified OAuth identity (no password).
 *
 * Takeover rule: a PASSWORD account whose address was never verified (no
 * emailVerified flag, no prior OAuth login) could have been registered by
 * anyone who knew the address. When the provider proves ownership of that
 * address, the verified owner takes the account over: the account and its
 * runs are kept, password login is disabled (the hash is replaced with an
 * unguessable one), the address is marked verified, and sessionVersion is
 * bumped so every outstanding session — possibly the squatter's — dies.
 */
export function upsertOAuthUser(email: string, provider: 'google'): UserRecord {
  const e = norm(email)
  const users = load()
  const existing = users[e]
  if (existing) {
    if (existing.provider === provider || existing.emailVerified === true) {
      // Same verified identity (or an already-proven address): plain login.
      if (existing.emailVerified !== true || !existing.provider) {
        existing.emailVerified = true
        existing.provider ??= provider
        save(users)
      }
      return existing
    }
    existing.salt = randomBytes(16).toString('hex')
    existing.hash = randomBytes(32).toString('hex') // password login impossible
    // the squatter's stored BYOK secret must not ride along to the real owner
    delete (existing as UserRecord & { llmKey?: unknown }).llmKey
    existing.emailVerified = true
    existing.provider = provider
    existing.sessionVersion = (existing.sessionVersion ?? 0) + 1
    save(users)
    return existing
  }
  const month = new Date().toISOString().slice(0, 7)
  const rec: UserRecord = {
    email: e,
    salt: randomBytes(16).toString('hex'),
    hash: randomBytes(32).toString('hex'), // unguessable, password login impossible
    plan: 'free',
    createdAt: new Date().toISOString(),
    runIds: [],
    usage: { month, runs: 0 },
    planCredits: PLAN_CREDITS.free,
    planCreditsMonth: month,
    extraCredits: 0,
    provider,
    emailVerified: true,
  }
  users[e] = rec
  save(users)
  return rec
}

// A fixed salt/hash pair so a login attempt against an UNKNOWN address still
// pays for one scrypt derivation: response time then no longer reveals whether
// an account exists.
const DUMMY_SALT = '5f1d3b9a7c2e4d6f8a0b1c2d3e4f5a6b'
const DUMMY_HASH = scryptSync('firstlight-dummy-password', DUMMY_SALT, 32)

export function verifyUser(email: string, password: string): UserRecord | null {
  const users = load()
  const rec = users[norm(email)]
  const salt = rec?.salt || DUMMY_SALT
  const hash = scryptSync(password, salt, 32)
  const stored = rec ? Buffer.from(rec.hash, 'hex') : DUMMY_HASH
  const match = hash.length === stored.length && timingSafeEqual(hash, stored)
  if (!rec || !match) return null
  return rec
}

/** Verify a password against a specific record (no lookup timing surface). */
export function passwordMatches(rec: UserRecord, password: string): boolean {
  const hash = scryptSync(password, rec.salt, 32)
  const stored = Buffer.from(rec.hash, 'hex')
  return hash.length === stored.length && timingSafeEqual(hash, stored)
}

/** Account whose Stripe customer id matches, or null (linear scan at preview scale). */
export function findUserByStripeCustomer(customerId: string): UserRecord | null {
  if (!customerId) return null
  return Object.values(load()).find((u) => u.stripeCustomerId === customerId) ?? null
}

export function getUser(email: string): UserRecord | null {
  return load()[norm(email)] ?? null
}

export function updateUser(email: string, fn: (u: UserRecord) => void): UserRecord | null {
  const users = load()
  const rec = users[norm(email)]
  if (!rec) return null
  fn(rec)
  save(users)
  return rec
}

// ---- credits / ownership ------------------------------------------------------

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

/** Refresh the monthly plan grant in-place if the calendar month rolled over. */
function refreshGrant(u: UserRecord): void {
  const m = currentMonth()
  if (u.planCreditsMonth !== m) {
    u.planCredits = PLAN_CREDITS[u.plan] ?? PLAN_CREDITS.free
    u.planCreditsMonth = m
  }
  // migrate accounts created before credits existed
  if (typeof u.planCredits !== 'number') u.planCredits = PLAN_CREDITS[u.plan] ?? 0
  if (typeof u.extraCredits !== 'number') u.extraCredits = 0
}

/** Total spendable credits (plan grant this month + purchased), grant-refreshed. */
export function creditsAvailable(u: UserRecord): number {
  refreshGrant(u)
  return u.planCredits + u.extraCredits
}

/** Can the user start a run? Needs at least 1 credit; actual cost is charged
 *  after, from the finished board's complexity (creditsForRun). */
export function canRun(u: UserRecord): boolean {
  return creditsAvailable(u) >= 1
}

/** Attach ownership + persist the grant refresh at run start. */
export function recordRun(email: string, runId: string) {
  updateUser(email, (u) => {
    refreshGrant(u)
    if (runId && !u.runIds.includes(runId)) u.runIds.push(runId)
  })
}

/** Charge a finished run: spend plan credits first, then purchased. Never below 0. */
export function chargeCredits(email: string, cost: number): number {
  let remaining = 0
  updateUser(email, (u) => {
    refreshGrant(u)
    let owed = Math.max(0, cost)
    const fromPlan = Math.min(u.planCredits, owed)
    u.planCredits -= fromPlan
    owed -= fromPlan
    const fromExtra = Math.min(u.extraCredits, owed)
    u.extraCredits -= fromExtra
    remaining = u.planCredits + u.extraCredits
  })
  return remaining
}

/** Add purchased credits (from a paid top-up). */
export function grantCredits(email: string, credits: number) {
  updateUser(email, (u) => {
    if (typeof u.extraCredits !== 'number') u.extraCredits = 0
    u.extraCredits += Math.max(0, credits)
  })
}

/** Grant a paid credit pack exactly once for a verified Stripe session. */
export function grantCreditsOnce(email: string, sessionId: string, credits: number): boolean {
  if (!sessionId || !Number.isFinite(credits) || credits <= 0) return false
  let granted = false
  updateUser(email, (u) => {
    u.processedCheckoutSessions ??= []
    if (u.processedCheckoutSessions.includes(sessionId)) return
    if (typeof u.extraCredits !== 'number') u.extraCredits = 0
    u.extraCredits += credits
    u.processedCheckoutSessions.push(sessionId)
    granted = true
  })
  return granted
}

// ---- sessions -------------------------------------------------------------------

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Current session version for an address; a missing store or unknown user is
 *  0. A CORRUPT store throws (callers fail closed). */
export function sessionVersionFor(email: string): number {
  const v = load()[norm(email)]?.sessionVersion
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0
}

/** Invalidate every outstanding session for an account (password reset,
 *  account takeover, "sign out everywhere"). Returns the new version. */
export function revokeSessions(email: string): number {
  let next = 0
  updateUser(email, (u) => {
    next = (typeof u.sessionVersion === 'number' ? u.sessionVersion : 0) + 1
    u.sessionVersion = next
  })
  return next
}

export function makeSession(email: string): string {
  const e = norm(email)
  const payload = `${b64url(Buffer.from(e))}|${Date.now() + SESSION_TTL_MS}|v${sessionVersionFor(e)}`
  const sig = b64url(createHmac('sha256', authSecret()).update(payload).digest())
  return `${payload}|${sig}`
}

export function readSession(token: string | undefined): string | null {
  if (!token) return null
  const parts = token.split('|')
  // 3 segments = legacy unversioned token (version 0); 4 = versioned.
  if (parts.length !== 3 && parts.length !== 4) return null
  if (!/^\d+$/.test(parts[1])) return null
  const expiresAt = Number(parts[1])
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return null
  let version = 0
  if (parts.length === 4) {
    if (!/^v\d{1,9}$/.test(parts[2])) return null
    version = Number(parts[2].slice(1))
  }
  const sigPart = parts[parts.length - 1]
  if (!/^[A-Za-z0-9_-]{43}$/.test(sigPart)) return null
  const payload = parts.slice(0, -1).join('|')
  let expect: Buffer
  try {
    expect = createHmac('sha256', authSecret()).update(payload).digest()
  } catch {
    // Missing production configuration fails closed for verification. Session
    // creation still throws so a deployment cannot silently issue bad tokens.
    return null
  }
  let supplied: Buffer
  try {
    supplied = Buffer.from(sigPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  } catch {
    return null
  }
  if (expect.length !== supplied.length || !timingSafeEqual(expect, supplied)) return null
  let email: string
  try {
    email = Buffer.from(
      parts[0].replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8')
  } catch {
    return null
  }
  if (!email || norm(email) !== email) return null
  // Revocation: the token's version must match the account's current one.
  // An unreadable store fails closed (never accept a session we can't check).
  try {
    if (sessionVersionFor(email) !== version) return null
  } catch {
    return null
  }
  return email
}

/**
 * Admin allowlist — the ONLY accounts that may reach operator-level surfaces
 * (the Shell tab / /api/terminal). Sourced from FL_ADMIN_EMAILS (comma list);
 * if unset, defaults to the platform owner so it's never accidentally open to
 * every authenticated user. A normal customer session is never admin.
 */
export function adminEmails(): string[] {
  const raw = process.env.FL_ADMIN_EMAILS
  const list = (raw && raw.trim() ? raw.split(',') : ['jack@lattis.io'])
    .map((e) => norm(e.trim()))
    .filter(Boolean)
  return list
}

export function isAdminEmail(email: string | null | undefined): boolean {
  return !!email && adminEmails().includes(norm(email))
}

/** True when the Request's signed-in user is a platform admin. */
export function isAdminRequest(req: Request): boolean {
  return isAdminEmail(sessionEmail(req))
}

/** Email of the signed-in user for a Request, or null. */
export function sessionEmail(req: Request): string | null {
  const cookie = req.headers.get('cookie') ?? ''
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))
  return readSession(m?.[1])
}

export type RunAccess = 'owner' | 'shared' | 'forbidden' | 'unauthenticated'

/** A single safe filesystem segment for public/runs/<id>. */
export function isValidRunId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

/**
 * Resolve access to an id-scoped run without trusting a client-provided actor.
 * Unowned runs are shared demos; owned runs are visible only to their owner.
 * Mutation routes must require `owner`, while read routes may allow `shared`.
 */
export function runAccess(req: Request, runId: string): {
  access: RunAccess
  email: string | null
} {
  const email = sessionEmail(req)
  if (!email) return { access: 'unauthenticated', email: null }
  const users = load()
  const owners = Object.values(users).filter((rec) => rec.runIds?.includes(runId))
  if (owners.length === 0) return { access: 'shared', email }
  if (owners.length === 1 && norm(owners[0].email) === norm(email)) {
    return { access: 'owner', email }
  }
  // Phase 5: a member a product was SHARED with reads its runs (never owner).
  if (owners.length === 1 && sharedViaProduct(email, runId)) {
    return { access: 'shared', email }
  }
  // Duplicate ownership is corrupt state and fails closed for every account.
  return { access: 'forbidden', email }
}

/** Product-level sharing consult (lazy import breaks a lib cycle). */
function sharedViaProduct(email: string, runId: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ds = require('@/lib/design-state') as typeof import('@/lib/design-state')
    return ds.runSharedWith(email, runId)
  } catch {
    return false
  }
}

/**
 * runAccess for a caller identified by EMAIL (API-key surface — the v1 API
 * resolves a key to its owner and has no session cookie). Same rules:
 * unowned runs are shared demos, duplicate ownership fails closed.
 */
export function runAccessByEmail(email: string, runId: string): RunAccess {
  const users = load()
  const owners = Object.values(users).filter((rec) => rec.runIds?.includes(runId))
  if (owners.length === 0) return 'shared'
  if (owners.length === 1 && norm(owners[0].email) === norm(email)) return 'owner'
  if (owners.length === 1 && sharedViaProduct(email, runId)) return 'shared'
  return 'forbidden'
}

export function sessionCookieHeader(token: string, isSecure = process.env.NODE_ENV === 'production'): string {
  // isSecure defaults to the prod flag so existing callers are unchanged, but an
  // auth route serving http://localhost must pass false — a Secure cookie is
  // silently dropped over http and the session would never stick.
  const secure = isSecure ? '; Secure' : ''
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
}

export function clearCookieHeader(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
}
