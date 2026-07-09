/** E12 regression: enterprise security surfaces — API keys, webhooks (incl.
 *  real HMAC-signed delivery), SSO/SCIM config, and RBAC gating. Isolated store. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'

process.env.ENTERPRISE_STORE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'e12-store-'))
const ent = await import('../lib/enterprise/store.mjs')
const rbac = await import('../lib/enterprise/rbac.mjs')
const ig = await import('../lib/enterprise/integrations.mjs')

const checks = []
function check(name, ok, detail = '') {
  checks.push(!!ok)
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  -> ' + detail : ''}`)
}

const admin = 'admin@x.test'
const db = ent.resetDb()
const org = ent.createOrganization(db, { name: 'T', actor: admin })
ent.createWorkspace(db, { org_id: org.org_id, name: 'W', actor: admin })
rbac.setMemberRole(db, { actor_name: admin, role: 'org_admin', actor: 'system' })
rbac.setMemberRole(db, { actor_name: 'vera@x.test', role: 'viewer', actor: admin })

// ---- RBAC gating for the new actions ----------------------------------------
check('1 viewer denied create_api_key',
  rbac.checkAction(db, 'vera@x.test', 'create_api_key', {}).ok === false)
check('2 admin allowed create_api_key',
  rbac.checkAction(db, admin, 'create_api_key', {}).ok === true)
check('3 viewer denied configure_sso',
  rbac.checkAction(db, 'vera@x.test', 'configure_sso', {}).ok === false)
check('4 viewer denied remove_member',
  rbac.checkAction(db, 'vera@x.test', 'remove_member', {}).ok === false)

// ---- member upsert + last-admin guard ---------------------------------------
const before = db.members.length
rbac.setMemberRole(db, { actor_name: 'vera@x.test', role: 'reviewer', actor: admin })
check('5 setMemberRole upserts (no duplicate)', db.members.length === before,
  `members=${db.members.length}`)
check('6 vera role updated to reviewer',
  rbac.rolesOf(db, 'vera@x.test').join() === 'reviewer')
const rmGuard = rbac.removeMember(db, { actor_name: admin, actor: admin })
check('7 cannot remove last org_admin', !!rmGuard.error, rmGuard.error)
check('8 remove non-admin member ok',
  rbac.removeMember(db, { actor_name: 'vera@x.test', actor: admin }).ok === true)

// ---- API keys ---------------------------------------------------------------
const k = ig.createApiKey(db, { name: 'ci', scope: 'read', actor: admin })
check('9 key returns plaintext once', /^flk_live_[0-9a-f]{48}$/.test(k.plaintext))
check('10 plaintext NOT stored (hash only)',
  db.organizations[0].integrations.api_keys[0].hash
  && db.organizations[0].integrations.api_keys[0].plaintext === undefined)
check('11 verifyApiKey accepts valid key', ig.verifyApiKey(db, k.plaintext)?.name === 'ci')
check('12 verifyApiKey rejects wrong key', ig.verifyApiKey(db, 'flk_live_deadbeef') === null)
check('13 read-scope key rejected for write',
  ig.verifyApiKey(db, k.plaintext, { requireWrite: true }) === null)
ig.revokeApiKey(db, { id: k.id, actor: admin })
check('14 revoked key rejected', ig.verifyApiKey(db, k.plaintext) === null)
check('15 GET redaction hides key hash',
  ig.redactIntegrations(db.organizations[0].integrations).api_keys
    .every((x) => x.hash === undefined))

// ---- webhooks: validation -------------------------------------------------
check('16 webhook http refused',
  !!ig.createWebhook(db, { url: 'http://x.com/h', events: ['approval.decided'], actor: admin }).error)
check('17 webhook private host refused (SSRF)',
  !!ig.createWebhook(db, { url: 'https://192.168.0.9/h', events: ['approval.decided'], actor: admin }).error)
check('18 webhook loopback refused (SSRF)',
  !!ig.createWebhook(db, { url: 'https://localhost/h', events: ['approval.decided'], actor: admin }).error)
check('19 webhook empty events refused',
  !!ig.createWebhook(db, { url: 'https://hooks.x.com/h', events: [], actor: admin }).error)
const w = ig.createWebhook(db, { url: 'https://hooks.x.com/h', events: ['approval.decided'], actor: admin })
check('20 valid webhook returns secret once', /^whsec_[0-9a-f]{48}$/.test(w.secret))
check('21 GET redaction hides webhook secret',
  ig.redactIntegrations(db.organizations[0].integrations).webhooks.every((x) => x.secret === undefined))

// ---- webhooks: real HMAC-signed delivery to a local receiver ---------------
// (inject a localhost hook directly — createWebhook would SSRF-block it — then fire)
let received = null
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    received = { sig: req.headers['x-compose-signature'],
                 event: req.headers['x-compose-event'], body, secret: hookSecret }
    res.writeHead(200); res.end('ok')
  })
})
const hookSecret = 'whsec_' + crypto.randomBytes(24).toString('hex')
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
db.organizations[0].integrations.webhooks.push({
  id: 'wh_test', url: `http://127.0.0.1:${port}/hook`, secret: hookSecret,
  events: ['approval.decided'], active: true, created_at: new Date().toISOString(),
})
await ig.fireWebhooks(db, 'approval.decided', { hello: 'world' })
server.close()
const expectSig = received
  && 'sha256=' + crypto.createHmac('sha256', hookSecret).update(received.body).digest('hex')
check('22 webhook delivered to receiver', received !== null)
check('23 delivery HMAC signature valid', received && received.sig === expectSig,
  received ? received.sig?.slice(0, 20) + '…' : 'no delivery')
check('24 delivery recorded last_delivery 200',
  db.organizations[0].integrations.webhooks.find((x) => x.id === 'wh_test')?.last_delivery?.status === 200)

// ---- SSO / SCIM -------------------------------------------------------------
check('25 OIDC http issuer refused',
  !!ig.configureSso(db, { provider: 'oidc', issuer: 'http://x', client_id: 'a', actor: admin }).error)
check('26 SAML missing cert refused',
  !!ig.configureSso(db, { provider: 'saml', entity_id: 'e', sso_url: 'https://x/s', actor: admin }).error)
const s = ig.configureSso(db, { provider: 'oidc', issuer: 'https://acme.okta.com',
  client_id: '0oa1', client_secret: 'topsecret', scim_enabled: true, actor: admin })
check('27 SSO configured + enforcement flagged not_active',
  s.status === 'configured' && s.enforcement === 'not_active')
check('28 SCIM token returned once', /^scim_[0-9a-f]{48}$/.test(s.scim_token))
check('29 verifyScimToken accepts it', ig.verifyScimToken(db, s.scim_token) === true)
check('30 verifyScimToken rejects wrong', ig.verifyScimToken(db, 'scim_bad') === false)
const red = ig.redactIntegrations(db.organizations[0].integrations).sso
check('31 GET redaction hides client_secret',
  red.oidc.client_secret === '••••••••')
check('32 GET redaction hides SCIM token hash', red.scim.token_hash === undefined)
check('33 disable_sso resets to not_configured',
  ig.disableSso(db, { actor: admin }).ok
  && db.organizations[0].integrations.sso.status === 'not_configured')

ent.saveDb(db)
check('34 audit chain intact after all mutations', ent.verifyAuditChain(ent.loadDb()).ok)

const n = checks.filter(Boolean).length
console.log(`${n}/${checks.length} E12 security checks pass`)
process.exit(n === checks.length ? 0 : 1)
