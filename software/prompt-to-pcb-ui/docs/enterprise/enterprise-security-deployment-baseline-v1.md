# E10 — Enterprise Security and Deployment Baseline v1

**NO compliance certification is claimed. This is an engineering baseline inventory, not an attestation.**
Explicitly not claimed: SOC 2, ISO 27001, FedRAMP, ITAR, CMMC, HIPAA, DFARS.

## Authentication / authorization
session cookie auth (middleware) over an in-memory session store; users in data/users.json (gitignored). E5 RBAC: 10 roles x 22 permissions enforced at the /api/enterprise dispatcher; denials audited; dev-admin default for local development.
Gaps: sessions are in-memory — restart invalidates them; no SSO/SAML/OIDC (recommended next enterprise milestone); no MFA.

## Audit / storage / secrets
append-only, hash-chained (sha256 prev-hash); verifyAuditChain exposed via API; tampering is detectable. Artifacts: local filesystem: public/runs (run artifacts, gitignored), data/enterprise/store.json (gitignored runtime state).
Secrets: .env.local (gitignored) holds all API keys; secret_scan.mjs guards tracked files; enterprise docs/demo data are scanned.

## External surface
Tools: kicad-cli / kipython (local binaries), flroute (local rust binary), ngspice if installed, no external EDA SaaS. Network: pipeline optionally calls supplier APIs (DigiKey) with keys from env; enterprise layer makes NO external calls; no payment integration.

## Deployment modes
- local prod: next build + next start (validated on this machine, port 4500)
- on-prem: viable: file-backed stores, local binaries, no external dependencies required at runtime — packaging is a next milestone
- cloud: possible but NOT hardened: single-tenant assumption, in-memory sessions, local file stores

## Known gaps (honest)
- no SSO/SAML/OIDC
- no MFA
- in-memory sessions
- single-tenant file store (no tenant isolation)
- no rate limiting on APIs
- no at-rest encryption of local stores
- IP/session fields in audit log are placeholders
