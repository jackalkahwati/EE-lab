# Tier-1 cloud deploy — get Compose off the Mac onto one reliable box

Goal: run the whole backend (Next app + the KiCad/freerouting/flroute/Python
pipeline) in **one well-provisioned Linux container** behind normal HTTPS,
instead of on Jack's Mac behind a Cloudflare tunnel. Single-node on purpose —
jobs are already serialized by an in-process lock, so we don't fight that yet
(that's Tier 2: a worker fleet + queue + object storage).

## What's here

| File | Role |
|---|---|
| `Dockerfile.toolchain` | Linux base: KiCad 8 + JRE + Linux-built flroute + Python deps. Multi-stage + slimmed to **~1.9 GB** (Rust toolchain builds flroute in a throwaway stage; KiCad's 4.8 GB 3D-model library omitted — it only feeds the advisory board.glb export, not routing/DRC). No app code. |
| `verify-linux.sh` | Runs the real board chain **inside Linux** and asserts 0 DRC / 0 unconnected. The go/no-go for the electronics spine. |
| `Dockerfile` | Full app image (Next server + pipeline) on top of the toolchain base. |
| `docker-compose.yml` | One app container + Caddy HTTPS ingress; named volumes for `public/runs` and the parts registry. |
| `Caddyfile` | Automatic Let's Encrypt HTTPS → the app. Replaces the Cloudflare tunnel. |

## Free-tier target ($0/month)

The whole thing runs free:
- **Host: Oracle Cloud Always-Free Ampere A1** — up to 4 Arm OCPU / 24 GB RAM,
  always-free (not a trial), 200 GB block storage. Arm64 matches the image
  built on Apple Silicon. Enough for KiCad + the freerouting JVM + Next.
  (Caveat: free Ampere capacity can be scarce in a region — expect retries.)
- **Ingress: Cloudflare Tunnel** (`deploy/docker-compose.tunnel.yml`) — free,
  no open ports, no public IP, no cert management. Same mechanism fronting the
  Mac today, pointed at the container.
- **LLM: the Claude Code subscription** — no metered spend during testing (see
  the subscription-on-a-box note below).

Bring-up in free mode (no Caddy, no open ports):
```bash
env $(cat deploy/.env | xargs) \
  docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.tunnel.yml \
  up -d --build app cloudflared
```
`deploy/.env` needs `TUNNEL_TOKEN` (Cloudflare Zero Trust → Networks → Tunnels
→ route a hostname to `http://app:4500` → copy the connector token) instead of
`FL_HOST`.

### Subscription LLM on the cloud box (testing only)
The pipeline's LLM legs fall back to the local `claude` CLI. To use the Max
subscription on the box instead of a metered key: install the `claude` CLI in
the container/host and copy your authenticated credentials
(`~/.claude` / the CLI's credential file) onto it, with `CLAUDE_CLI_PATH` set.
Caveats, honestly: this is credential transfer, the token can expire (needs an
interactive re-login), and headless server use of a personal subscription is
ToS-gray. Fine for testing; switch to a funded metered key
(`llm_health.py` → LIVE) for anything real.

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

- **KiCad version — RESOLVED for the electronics spine.** The base installs
  **KiCad 8.0.9** (jammy + the `kicad-8.0` PPA — the reliable apt path; noble
  ships only 7.0.11 and no PPA publishes a noble app build; KiCad 7 can't even
  read the pipeline's board format, so 8+ is the floor). The single pcbnew API
  delta between KiCad 8 and the Mac's 10.0.1 — `ZONE_FILLER.Fill()` argument
  types — is handled with a cross-version try/except in `import_ses.py` (Mac
  behavior byte-identical, A/B verified). **A full board now builds 0 DRC / 0
  unconnected inside the Linux container** (`verify-linux.sh`).
- **Footprint-library parity — the remaining bounded item.** KiCad 8's stock
  footprint libraries lack a few parts newer than KiCad 8 (e.g. the Raspberry
  Pi Pico module — `Module.pretty/RaspberryPi_Pico_SMD_HandSolder`). Boards
  whose block library references those fail to compose on Linux until the
  footprints are vendored. Fix: copy the missing footprints from the Mac's
  KiCad 10 libraries into a vendored dir and point `FL_KICAD_FOOTPRINTS` there
  (or bundle the Mac's footprint libs into the image for exact parity). Parts
  sourced from the shared registry (easyeda2kicad) are unaffected — only the
  stock-library block footprints. Passives, USB, LED, connectors, TestPoint are
  all present in KiCad 8; a Pico-free board is already fully green on Linux.
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
