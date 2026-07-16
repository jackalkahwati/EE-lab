# Tier-1 cloud deploy — get Compose off the Mac onto one reliable box

Goal: run the whole backend (Next app + the KiCad/freerouting/flroute/Python
pipeline) in **one well-provisioned Linux container** behind normal HTTPS,
instead of on Jack's Mac behind a Cloudflare tunnel. Single-node on purpose —
jobs are already serialized by an in-process lock, so we don't fight that yet
(that's Tier 2: a worker fleet + queue + object storage).

## What's here

| File | Role |
|---|---|
| `Dockerfile.toolchain` | Linux base: KiCad + JRE + Linux-built flroute + Python deps. No app code. Proves the native stack ports. |
| `verify-linux.sh` | Runs the real board chain **inside Linux** and asserts 0 DRC / 0 unconnected. The go/no-go for the electronics spine. |
| `Dockerfile` | Full app image (Next server + pipeline) on top of the toolchain base. |
| `docker-compose.yml` | One app container + Caddy HTTPS ingress; named volumes for `public/runs` and the parts registry. |
| `Caddyfile` | Automatic Let's Encrypt HTTPS → the app. Replaces the Cloudflare tunnel. |

## Prerequisites (the two real gates)

1. **A metered LLM key with credit.** The pipeline's LLM legs fall back to the
   local `claude` CLI (Jack's Max subscription) which **cannot run on a cloud
   host**. Top up Anthropic or OpenAI and confirm:
   `python3 software/prompt-to-pcb-ui/scripts/llm_health.py` → `metered LLM: LIVE`.
2. **Toolchain portability** — the pipeline scripts must resolve KiCad/Python
   paths from `FL_KICAD_*` env (done in the portability refactor). Verify on
   Linux with `verify-linux.sh` below.

## Prove it (local, needs Docker)

```bash
cd "<repo root>"
# 1. base toolchain image
docker build -f deploy/Dockerfile.toolchain -t firstlight-toolchain .
# 2. does the pipeline run clean on Linux?  (mounts the repo, runs the chain)
docker run --rm -v "$PWD":/repo -w /repo firstlight-toolchain bash deploy/verify-linux.sh
#    → expect: "LINUX PIPELINE: CLEAN"
```

If that prints a clean board, the hard question is answered: the stack ports.

## Deploy (on the cloud box)

A box with real CPU/RAM — KiCad + the freerouting JVM are compute-heavy; size
for the sims later. Debian/Ubuntu with Docker + compose.

```bash
# DNS: point compose.firstlight.build A/AAAA at this box; open 80 + 443.
git clone <repo> && cd <repo>
cat > deploy/.env <<EOF
FL_HOST=compose.firstlight.build
AUTH_SECRET=<same secret the sessions are signed with>
ANTHROPIC_API_KEY=<funded key>
FL_LLM_ORDER=anthropic,openai,claude-cli
FL_TERMINAL=0            # operator shell off; set 1 + FL_ADMIN_EMAILS only if wanted
FL_ADMIN_EMAILS=jack@lattis.io
EOF
env $(cat deploy/.env | xargs) docker compose -f deploy/docker-compose.yml up -d --build
```

Caddy fetches the HTTPS cert automatically. Then cut `app.firstlight.build`
(or a new `compose.firstlight.build`) over to this box and stop the Mac's
`build.firstlight.compose` + `cloudflared` launchd services. The Mac is now
free; the box is the single point of truth.

## Known caveats (honest)

- **KiCad version parity.** The base installs KiCad from the `kicad-9.0`
  Ubuntu PPA; the Mac runs 10.0.1. The design-rules-in-board-file behavior the
  pipeline depends on exists in KiCad 9, so DRC parity is expected — but prod
  should pin the **exact** Mac version (KiCad nightly PPA or a source build)
  once `verify-linux.sh` confirms the board matches. Treat any DRC delta
  between Mac-10 and Linux-9 as a version-parity task, not a code bug.
- **npm lockfile.** This tree's lockfile is currently broken (`npm ci` fails);
  the app Dockerfile installs with `--force`. Repair the lockfile before
  relying on this for reproducible builds.
- **Sims not in the base image yet.** OpenFOAM/Elmer/openEMS/ccx/gmsh are a
  larger follow-on layer (all Linux-native, so lower risk than KiCad — just
  big). The electronics + mechanical(Onshape, already cloud) + LLM path is the
  spine proven first; a product that declares a sim will honestly report the
  solver unavailable until that layer is added.
- **Still single-node.** One container = one pipeline at a time. Fine until you
  have concurrent users; then it's Tier 2.
```
