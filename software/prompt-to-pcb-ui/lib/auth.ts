/**
 * Account system for the private preview: file-backed user store + signed
 * session cookies. No external service, no plaintext passwords (scrypt).
 *
 * Store lives at data/users.json (gitignored, NOT under public/). This is
 * deliberately simple for the lab/preview deployment; the swap to Postgres/KV
 * at production deploy only touches this file, every route goes through
 * these helpers.
 *
 * Session cookie: base64url(email)|expiresMs|hmacSHA256(payload, AUTH_SECRET).
 * The middleware (edge) verifies the same format with crypto.subtle.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface UserRecord {
  email: string
  salt: string
  hash: string
  plan: 'free' | 'pro'
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
}

const STORE_DIR = path.join(process.cwd(), 'data')
const STORE = path.join(STORE_DIR, 'users.json')

// ---- credits & plans (tune here) --------------------------------------------
// A board run costs credits scaled by its complexity (nets + components), so
// the person generating expensive boards pays for them. 1 credit ~= one simple
// board. See creditsForRun().
export const PLAN_CREDITS: Record<'free' | 'pro', number> = { free: 5, pro: 100 }

// One-time top-up packs, bigger packs, cheaper per credit (volume discount).
// Priced inline at checkout (no pre-created Stripe prices needed).
export const CREDIT_PACKS = [
  { id: 'small', credits: 50, cents: 2500 }, // $25  · $0.50/credit
  { id: 'mid', credits: 200, cents: 8000 }, //  $80  · $0.40/credit (20% off)
  { id: 'large', credits: 1000, cents: 30000 }, // $300 · $0.30/credit (40% off)
] as const

/** Credits a run costs, from its board complexity. Round up, min 1. */
export function creditsForRun(nets: number, components: number): number {
  return Math.max(1, Math.round(((nets || 0) + (components || 0)) / 25))
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

/** Find-or-create an account from a verified OAuth identity (no password). */
export function upsertOAuthUser(email: string, provider: 'google'): UserRecord {
  const e = norm(email)
  const users = load()
  if (users[e]) return users[e]
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
  }
  users[e] = rec
  save(users)
  return rec
}

export function verifyUser(email: string, password: string): UserRecord | null {
  const users = load()
  const rec = users[norm(email)]
  if (!rec) return null
  const hash = scryptSync(password, rec.salt, 32)
  const stored = Buffer.from(rec.hash, 'hex')
  if (hash.length !== stored.length || !timingSafeEqual(hash, stored)) return null
  return rec
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

export function makeSession(email: string): string {
  const payload = `${b64url(Buffer.from(norm(email)))}|${Date.now() + SESSION_TTL_MS}`
  const sig = b64url(createHmac('sha256', authSecret()).update(payload).digest())
  return `${payload}|${sig}`
}

export function readSession(token: string | undefined): string | null {
  if (!token) return null
  const parts = token.split('|')
  if (parts.length !== 3) return null
  if (!/^\d+$/.test(parts[1])) return null
  const expiresAt = Number(parts[1])
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return null
  if (!/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return null
  const payload = `${parts[0]}|${parts[1]}`
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
    supplied = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  } catch {
    return null
  }
  if (expect.length !== supplied.length || !timingSafeEqual(expect, supplied)) return null
  try {
    const email = Buffer.from(
      parts[0].replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8')
    return email && norm(email) === email ? email : null
  } catch {
    return null
  }
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

export function sessionCookieHeader(token: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
}

export function clearCookieHeader(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
}
