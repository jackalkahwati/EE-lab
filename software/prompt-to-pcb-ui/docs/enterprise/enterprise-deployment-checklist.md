# Enterprise deployment checklist

Pre-deploy
- [ ] `node scripts/secret_scan.mjs` is CLEAN
- [ ] .env.local present on host, never in git
- [ ] data/ and public/runs/ on persistent storage with backups
- [ ] *.glb and any new generated binaries gitignored (Tailwind scanner)
- [ ] `npm run build` green; kill old server PID before `next start`

Access
- [ ] seed real users; disable/replace demo seed data
- [ ] assign RBAC roles (no one but admins keeps org_admin)
- [ ] review audit chain (`verifyAuditChain`) after first day

Honesty gates (do not weaken)
- [ ] guardReadiness untouched (production_ready unreachable)
- [ ] approval gates verified at transition time
- [ ] physical evidence requires real files + named-reviewer acceptance

Not claimed
- [ ] no SOC2/ISO/FedRAMP/ITAR/CMMC/HIPAA claim anywhere in customer
      materials
