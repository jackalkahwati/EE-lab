# OPS runbook — FirstLight Compose (current single-Mac deployment)

This describes what is **actually running today** for `app.firstlight.build`:
a Mac serving Next.js via launchd, exposed through a Cloudflare tunnel.

> `deploy/README.md` describes the **Oracle VM (systemd + reverse proxy)**
> target. That is the intended migration destination for real HA, **not** what
> is running now. This runbook does not replace it — see the "Known limitation"
> section for why the VM is still the goal.

---

## How the app is served

```
browser
  -> https://app.firstlight.build        (Cloudflare edge + TLS)
  -> Cloudflare tunnel "firstlight-compose"   (cloudflared, this Mac)
  -> http://localhost:4500               (next start, this Mac)
  -> data/ + public/runs/                (external USB drive "T9 Backup")
```

- App root (working dir): `/Volumes/T9 Backup/EE-lab/software/prompt-to-pcb-ui`
- Local port: `4500` (`npx next start -p 4500`)
- Public host: `https://app.firstlight.build`
- There is **no** dedicated `/health` route; `/` is used as the liveness probe.

## launchd jobs (per-GUI-session agents in `~/Library/LaunchAgents`)

| Label | Role | Program | Logs |
|-------|------|---------|------|
| `build.firstlight.compose` | Next server on :4500 | `npx next start -p 4500` | `/tmp/firstlight-compose.log` / `.err` |
| `build.firstlight.cloudflared` | Cloudflare tunnel | `cloudflared tunnel run firstlight-compose` | `/tmp/firstlight-cloudflared.log` / `.err` |
| `build.firstlight.llmproxy` | LLM proxy (subscription bridge) | `python3 ~/firstlight-llm-proxy/proxy.py` | `/tmp/firstlight-llmproxy.out` / `.err` |

Related jobs also present: `build.firstlight.a1retry`, `com.firstlight.crm-sync`.
Resilience jobs added by this directory (opt-in, not installed automatically):
`com.firstlight.backup`, `com.firstlight.healthcheck`.

### List / restart a job

```bash
# Is it loaded?
launchctl list | grep build.firstlight

# Restart (bootout then bootstrap the same plist)
launchctl kickstart -k gui/$(id -u)/build.firstlight.compose        # quick restart
# ...or full reload:
launchctl bootout   gui/$(id -u)/build.firstlight.compose 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/build.firstlight.compose.plist
```

Same pattern for `build.firstlight.cloudflared` and `build.firstlight.llmproxy`
(swap the label / plist filename).

### Order matters on a cold start
1. `build.firstlight.compose` (app must answer :4500 first)
2. `build.firstlight.cloudflared` (tunnel to the running app)
3. `build.firstlight.llmproxy` (needed for model calls; independent of the above)

---

## Where data lives (and what is NOT redundant)

All persistent state is on the external USB drive `T9 Backup`:

- `data/users.json` — accounts
- `data/products.json`, `data/runs-index.json` — product + run index
- `data/enterprise/`, `data/comments/`, `data/checkpoint/`, `data/evidence-artifacts/`
- `public/runs/<slug>/` — per-run artifacts (231+ dirs)

If the drive unmounts, the app's working dir disappears and it stops serving.

---

## Backups

Script: `deploy/backup-data.sh`. Snapshots `data/` and `public/runs/` into
`~/firstlight-backups/<timestamp>/`, keeps the last 14, prunes older.
**Copy-only — it never touches the live data.**

```bash
# One-off manual backup
./deploy/backup-data.sh

# Off-machine mirror (recommended — see limitation below)
FL_BACKUP_REMOTE="user@host:/path/firstlight-backups" ./deploy/backup-data.sh
```

Automate it (every 6 h) with the launchd job:

```bash
cp deploy/com.firstlight.backup.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.firstlight.backup.plist
launchctl list | grep com.firstlight.backup     # verify
```

Logs: `/tmp/firstlight-backup.log` / `.err`.

### Restore

Backups are plain directory copies — restore by copying back.

```bash
# 1. Stop the app so nothing writes mid-restore
launchctl bootout gui/$(id -u)/build.firstlight.compose 2>/dev/null || true

# 2. Pick a snapshot
ls -1 ~/firstlight-backups        # timestamps, newest last

SNAP=~/firstlight-backups/<timestamp>
APP="/Volumes/T9 Backup/EE-lab/software/prompt-to-pcb-ui"

# 3. (Safety) move the current data aside first — never delete blindly
mv "$APP/data" "$APP/data.pre-restore.$(date +%s)"
mv "$APP/public/runs" "$APP/public/runs.pre-restore.$(date +%s)"

# 4. Copy the snapshot back into place
cp -a "$SNAP/data" "$APP/data"
cp -a "$SNAP/public/runs" "$APP/public/runs"

# 5. Restart the app
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/build.firstlight.compose.plist
```

---

## Healthcheck

Script: `deploy/healthcheck.sh`. Verifies drive mount, local :4500, public
endpoint, cloudflared process, and the compose launchd job. Exits non-zero
with a diagnosis if any link is down; POSTs to `$FL_ALERT_WEBHOOK` if set.

```bash
# Manual run
./deploy/healthcheck.sh; echo "exit=$?"

# With alerting
FL_ALERT_WEBHOOK="https://hooks.example.com/..." ./deploy/healthcheck.sh
```

Automate it (every 5 min):

```bash
cp deploy/com.firstlight.healthcheck.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.firstlight.healthcheck.plist
launchctl list | grep com.firstlight.healthcheck
```

Logs: `/tmp/firstlight-healthcheck.log` / `.err`.

### Fast triage (what failed where)

| Symptom | Likely cause | Check |
|---------|--------------|-------|
| public down, local up | tunnel / DNS / TLS | `pgrep -f 'cloudflared.*tunnel'`, `/tmp/firstlight-cloudflared.err` |
| local + public down | app crashed / drive gone | `launchctl list \| grep compose`, `/tmp/firstlight-compose.err`, `mount \| grep 'T9 Backup'` |
| everything down after reboot/logout | GUI session not active | log back into the Mac GUI (see limitation) |
| model calls failing | llmproxy down | `launchctl list \| grep llmproxy`, `/tmp/firstlight-llmproxy.err` |

---

## KNOWN LIMITATION — this is NOT highly available

**Single machine, GUI-session-scoped agents, data on an external USB drive.**

- **Single point of failure:** one Mac. If it sleeps, loses power, drops off
  the network, or the `T9 Backup` USB drive unmounts, the product is down.
- **GUI-session-scoped launchd agents:** these jobs run under
  `gui/$(id -u)` and only run while that user is logged into the GUI. A logout,
  fast-user-switch, or reboot-without-auto-login takes the whole stack down
  until someone logs back in. They are **not** system daemons.
- **Backups live on the same machine by default:** without `FL_BACKUP_REMOTE`
  set, `~/firstlight-backups` is on the same box (often the same drive) as the
  live data — a drive/machine loss takes both. **Set an off-machine target.**
- **No horizontal redundancy / no auto-failover / no TLS-terminating LB you own.**

**For real HA, migrate to the Oracle VM described in `deploy/README.md`**
(persistent disk, systemd services that survive reboot without a GUI login,
reverse proxy with auto-TLS). This runbook keeps the current Mac deployment
survivable in the interim; it does not make it highly available.
