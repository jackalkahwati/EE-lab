/**
 * Real API keys + webhooks with safeguards.
 *
 * API keys: cryptographically random, shown in plaintext EXACTLY ONCE at
 * creation, only the SHA-256 hash is stored, revocable, admin-gated, audited.
 * verifyApiKey() authenticates a presented key against the stored hashes.
 *
 * Webhooks: https-only with an SSRF guard (no loopback/private hosts), a signing
 * secret shown once, deliveries HMAC-signed so the receiver can verify. The raw
 * key hashes and webhook secrets are NEVER returned by the read API (the route
 * sanitizes them out).
 */
import crypto from 'crypto'
import { appendAudit } from './store.mjs'

const KEY_PREFIX = 'flk_live_'
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')

function ensureIg(db) {
  const org = db.organizations?.[0]
  if (!org) return null
  org.integrations = org.integrations ?? {}
  org.integrations.api_keys = org.integrations.api_keys ?? []
  org.integrations.webhooks = org.integrations.webhooks ?? []
  return org.integrations
}

// ---- API keys ----------------------------------------------------------------
export function createApiKey(db, { name, scope = 'read', actor }) {
  const ig = ensureIg(db)
  if (!ig) return { error: 'no organization' }
  if (!name || !/^[\w .-]{2,40}$/.test(name)) return { error: 'name must be 2-40 chars' }
  if (!['read', 'read_write'].includes(scope)) return { error: 'scope must be read | read_write' }
  const raw = KEY_PREFIX + crypto.randomBytes(24).toString('hex')
  const rec = {
    id: 'key_' + crypto.randomBytes(4).toString('hex'),
    name, scope, hash: sha256(raw),
    masked: raw.slice(0, KEY_PREFIX.length + 6) + '…' + raw.slice(-4),
    created_at: new Date().toISOString(), created_by: actor,
    last_used: null, revoked: false,
  }
  ig.api_keys.push(rec)
  appendAudit(db, { actor, action: 'create_api_key', scope: { id: rec.id, name, scope } })
  return { ...rec, plaintext: raw } // plaintext returned ONCE, never stored
}

export function revokeApiKey(db, { id, actor }) {
  const ig = ensureIg(db)
  if (!ig) return { error: 'no organization' }
  const k = ig.api_keys.find((x) => x.id === id)
  if (!k) return { error: 'no such key' }
  k.revoked = true
  k.revoked_at = new Date().toISOString()
  k.revoked_by = actor
  appendAudit(db, { actor, action: 'revoke_api_key', scope: { id } })
  return { ok: true, id }
}

/** authenticate a presented raw key; returns the (non-revoked) record or null */
export function verifyApiKey(db, raw, { requireWrite = false } = {}) {
  const keys = db.organizations?.[0]?.integrations?.api_keys
  if (!keys || !raw) return null
  const h = sha256(raw)
  const k = keys.find((x) => x.hash === h && !x.revoked)
  if (!k) return null
  if (requireWrite && k.scope !== 'read_write') return null
  k.last_used = new Date().toISOString()
  return k
}

// ---- webhooks ----------------------------------------------------------------
export const WEBHOOK_EVENTS = [
  'approval.requested', 'approval.decided', 'quote.advanced',
  'evidence.added', 'evidence.reviewed',
]

function unsafeWebhookUrl(u) {
  let url
  try { url = new URL(u) } catch { return 'invalid URL' }
  if (url.protocol !== 'https:') return 'must be https'
  const h = url.hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.local') || h === '::1' || h === '[::1]'
      || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) {
    return 'refusing loopback / private host (SSRF guard)'
  }
  return null
}

export function createWebhook(db, { url, events = [], actor }) {
  const ig = ensureIg(db)
  if (!ig) return { error: 'no organization' }
  const bad = unsafeWebhookUrl(url)
  if (bad) return { error: bad }
  const evs = (events || []).filter((e) => WEBHOOK_EVENTS.includes(e))
  if (!evs.length) return { error: 'select at least one valid event' }
  const secret = 'whsec_' + crypto.randomBytes(24).toString('hex')
  const rec = {
    id: 'wh_' + crypto.randomBytes(4).toString('hex'),
    url, events: evs, secret, // secret stored server-side to sign deliveries
    active: true, created_at: new Date().toISOString(), created_by: actor,
    last_delivery: null,
  }
  ig.webhooks.push(rec)
  appendAudit(db, { actor, action: 'create_webhook', scope: { id: rec.id, url, events: evs } })
  return { id: rec.id, url, events: evs, secret } // secret shown once
}

export function deleteWebhook(db, { id, actor }) {
  const ig = ensureIg(db)
  if (!ig) return { error: 'no organization' }
  const before = ig.webhooks.length
  ig.webhooks = ig.webhooks.filter((w) => w.id !== id)
  if (ig.webhooks.length === before) return { error: 'no such webhook' }
  appendAudit(db, { actor, action: 'delete_webhook', scope: { id } })
  return { ok: true, id }
}

/** best-effort HMAC-signed delivery to every active webhook subscribed to event */
export async function fireWebhooks(db, event, payload) {
  const hooks = (db.organizations?.[0]?.integrations?.webhooks ?? [])
    .filter((w) => w.active && (w.events ?? []).includes(event))
  if (!hooks.length) return
  const body = JSON.stringify({ event, at: new Date().toISOString(), data: payload })
  await Promise.all(hooks.map(async (w) => {
    const sig = crypto.createHmac('sha256', w.secret).update(body).digest('hex')
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5000)
    try {
      const res = await fetch(w.url, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json',
                   'x-compose-event': event,
                   'x-compose-signature': `sha256=${sig}` },
        body,
      })
      w.last_delivery = { at: new Date().toISOString(), event, status: res.status }
    } catch (e) {
      w.last_delivery = { at: new Date().toISOString(), event, status: 'failed',
                          error: String(e?.message ?? e).slice(0, 120) }
    } finally { clearTimeout(t) }
  }))
}

// ---- SSO / SCIM --------------------------------------------------------------
// Stores the IdP connection config. HONEST: this saves the connection settings
// (admin-gated, audited, secrets redacted from the read API); it does NOT by
// itself enforce SSO at login — that requires wiring the callback/ACS endpoints
// against the live IdP, which is a separate, verified step.
export function configureSso(db, { provider, issuer, client_id, client_secret,
                                   entity_id, sso_url, certificate,
                                   scim_enabled = false, actor }) {
  const ig = ensureIg(db)
  if (!ig) return { error: 'no organization' }
  if (!['oidc', 'saml'].includes(provider)) return { error: 'provider must be oidc | saml' }
  const sso = (ig.sso && typeof ig.sso === 'object') ? { ...ig.sso } : {}
  sso.protocols = ['SAML 2.0', 'OIDC']
  sso.provider = provider

  if (provider === 'oidc') {
    if (!issuer || !/^https:\/\//.test(issuer)) return { error: 'OIDC issuer must be an https URL' }
    if (!client_id) return { error: 'OIDC client_id is required' }
    sso.oidc = { issuer, client_id, client_secret: client_secret || null }
    delete sso.saml
  } else {
    if (!entity_id || !sso_url || !certificate) {
      return { error: 'SAML requires entity_id, sso_url and certificate' }
    }
    if (!/^https:\/\//.test(sso_url)) return { error: 'SAML sso_url must be https' }
    sso.saml = { entity_id, sso_url, certificate }
    delete sso.oidc
  }

  let scimToken = null
  const scimCur = (sso.scim && typeof sso.scim === 'object') ? sso.scim : { enabled: false }
  if (scim_enabled && !scimCur.enabled) {
    const raw = 'scim_' + crypto.randomBytes(24).toString('hex')
    sso.scim = { enabled: true, token_hash: sha256(raw), token_masked: raw.slice(0, 11) + '…' + raw.slice(-4) }
    scimToken = raw
  } else if (!scim_enabled) {
    sso.scim = { enabled: false }
  } else {
    sso.scim = scimCur
  }

  sso.status = 'configured'
  sso.enforcement = 'not_active'
  sso.configured_at = new Date().toISOString()
  sso.configured_by = actor
  sso.note = 'connection stored; login enforcement is not active until wired to the live IdP'
  ig.sso = sso
  appendAudit(db, { actor, action: 'configure_sso', scope: { provider, scim: !!scim_enabled } })
  return { ...sso, scim_token: scimToken } // SCIM token returned ONCE
}

export function disableSso(db, { actor }) {
  const ig = ensureIg(db)
  if (!ig) return { error: 'no organization' }
  ig.sso = { status: 'not_configured', protocols: ['SAML 2.0', 'OIDC'], scim: { enabled: false },
    note: 'available on Enterprise / Defense; contact to enable' }
  appendAudit(db, { actor, action: 'disable_sso', scope: {} })
  return { ok: true }
}

// verify a presented SCIM bearer token (for a future provisioning endpoint)
export function verifyScimToken(db, raw) {
  const scim = db.organizations?.[0]?.integrations?.sso?.scim
  if (!scim?.enabled || !scim.token_hash || !raw) return false
  return sha256(raw) === scim.token_hash
}

// strip secrets before the read API returns integration config
export function redactIntegrations(ig) {
  if (!ig) return ig
  let sso = ig.sso
  if (sso && typeof sso === 'object') {
    sso = { ...sso }
    if (sso.oidc) sso.oidc = { ...sso.oidc, client_secret: sso.oidc.client_secret ? '••••••••' : null }
    if (sso.saml) sso.saml = { ...sso.saml, certificate: sso.saml.certificate ? '(stored)' : null }
    if (sso.scim && typeof sso.scim === 'object' && sso.scim.token_hash) {
      const { token_hash, ...rest } = sso.scim
      sso.scim = rest
    }
  }
  return {
    ...ig,
    sso,
    api_keys: (ig.api_keys ?? []).map(({ hash, ...k }) => k),
    webhooks: (ig.webhooks ?? []).map(({ secret, ...w }) => w),
  }
}

export function handlers(db, actor) {
  return {
    create_api_key: (p) => createApiKey(db, { ...p, actor }),
    revoke_api_key: (p) => revokeApiKey(db, { ...p, actor }),
    create_webhook: (p) => createWebhook(db, { ...p, actor }),
    delete_webhook: (p) => deleteWebhook(db, { ...p, actor }),
    configure_sso: (p) => configureSso(db, { ...p, actor }),
    disable_sso: (p) => disableSso(db, { ...p, actor }),
  }
}
