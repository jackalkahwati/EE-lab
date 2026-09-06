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

## Where production actually runs (changed 2026-09-04)

The app runs from the **internal disk** at `~/firstlight-prod`, NOT from the
external drive. On 2026-09-03 the T9 volume dropped off the USB bus and took the
whole product down, because the app directory, its build and its `.env.local`
all lived on it. Only the bulky run store is still external:

    ~/firstlight-prod/software/prompt-to-pcb-ui/          <- app, build, .env.local, data/
    ~/firstlight-prod/software/prompt-to-pcb-ui/public/runs -> /Volumes/T9 Backup/... (symlink)

So losing the drive is now a degraded state (existing boards unreadable, new
runs fail) rather than an outage (login and the app itself keep working).

`~/EE-lab` is the DEV checkout and must never serve production — that is how a
stray edit becomes a live change.

**The symlink must not exist while building.** Turbopack refuses a symlink that
points outside the project root ("points out of the filesystem root") and the
build dies. The build does not need the run store; only the runtime does. So the
ship procedure below removes it, builds, and puts it back.

## Ship new code

```bash
PROD=~/firstlight-prod/software/prompt-to-pcb-ui
launchctl bootout gui/$UID/build.firstlight.compose        # STOP FIRST: a build
                                                           # rewrites .next under
                                                           # a live next start
cd ~/firstlight-prod && git fetch && git checkout -f -B main origin/main
cd "$PROD"
pnpm install --frozen-lockfile        # only when package.json/lockfile changed
rm -f public/runs && mkdir -p public/runs   # symlink breaks the build
pnpm build                                  # FOREGROUND. A killed background
                                            # build caused a 13-min outage.
rmdir public/runs && ln -s "/Volumes/T9 Backup/EE-lab/software/prompt-to-pcb-ui/public/runs" public/runs
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/build.firstlight.compose.plist
curl -sI localhost:4500 | head -1                          # expect 307
```

When tools/ changed, also refresh the pipeline toolchain:

```bash
cd ~/firstlight-prod/tools/tscircuit && npm install   # postinstall re-patches dsn-converter
```

### flroute — a BUILT binary that git does not carry

`/api/pipeline/run` routes the variant board by spawning
`hardware/pcba-rev-a/tools/flroute/target/release/flroute`. That is a Rust
binary under a gitignored `target/`, so a fresh checkout — or a move to a new
prod directory — arrives WITHOUT it and every routing stage dies with
`spawn ... ENOENT`. That is what happened in the 2026-09-04 move to
`~/firstlight-prod`, and it silently broke board builds until it was noticed.

Check it before believing a deploy is good:

```bash
ls -l ~/firstlight-prod/hardware/pcba-rev-a/tools/flroute/target/release/flroute
```

Missing, or older than the newest commit touching `flroute/src/`? Rebuild it:

```bash
export RUSTUP_HOME=~/.rustup   # see the note below before using a /Volumes path
cd ~/firstlight-prod/hardware/pcba-rev-a/tools/flroute && cargo build --release
```

### The firmware stage needs a Rust toolchain AND the embedded targets

The firmware discipline runs `cargo build --target thumbv6m-none-eabi` (RP2040;
thumbv7em/thumbv7m for STM32 parts). With no default toolchain it fails with:

```
error: rustup could not choose a version of cargo to run, because one wasn't
       specified explicitly, and no default is configured
```

That is a HOST setup gap, not a design fault, and it fails late — after design,
placement, routing, validation and ERC have all passed — so it reads like a
pipeline bug. Check it before blaming a board:

```bash
rustup toolchain list          # must not say "no installed toolchains"
rustup target list --installed # must include thumbv6m-none-eabi
```

Repair (minimal profile keeps it near 1 GB and skips the component that fails
on the T9-backed rustup home):

```bash
rustup set profile minimal
rustup default stable
rustup target add thumbv6m-none-eabi thumbv7em-none-eabihf thumbv7m-none-eabi
```

Verified working by compiling a `no_std` crate for thumbv6m — a toolchain that
answers `rustc --version` can still be missing the embedded target, and the
error for that looks nothing like the error for a missing default.

Two traps, both hit on 2026-09-04:

* **Do not copy the binary from another checkout without checking its date.**
  The one in `~/EE-lab` was built at 17:07 on 2026-07-09 while
  `flroute/src/` last changed at 17:19 the same day — it predated
  `95c9a8e` "don't route signals on plane layers (chip-down fix)". Stale by
  twelve minutes, wrong for exactly the path being debugged. Sizes differ
  (746,768 stale vs 802,576 current), which is the quickest tell.
* **`~/.rustup` is a symlink to `/Volumes/T9 Backup/offload/.rustup`.**
  rustup works through the symlink but is denied when `RUSTUP_HOME` is set to
  the literal `/Volumes/...` path (macOS TCC on removable volumes — the same
  denial that broke the backup job). If the toolchain is missing, install a
  minimal one to a LOCAL `RUSTUP_HOME`, build, and delete it again:
  `rustup set profile minimal` keeps it near 1 GB, and the boot volume runs
  with about 5 GB free.

Skip the rebuild entirely when only non-app files changed. Normal downtime is
under 30 seconds.

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

### Onshape credentials (the mechanical stage depends on them)

`ONSHAPE_ACCESS_KEY` / `ONSHAPE_SECRET_KEY` must be present or the enclosure CAD
step produces nothing — the app spawns `tools/onshape/render_plan.py`, which
builds the enclosure in a real Onshape document and exports STEP. They live in
TWO places on purpose:

    software/prompt-to-pcb-ui/.env.local   # the app passes them to the spawn
    tools/onshape/.env                     # so the script also works run by hand

Both are gitignored; the source of truth is the work-hub vault. `render_plan.py`
uses `setdefault`, so the environment wins over the file.

Verify with a read-only call:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -u "$ONSHAPE_ACCESS_KEY:$ONSHAPE_SECRET_KEY" \
  https://cad.onshape.com/api/documents?limit=1     # expect 200
```


## Router runner env knobs (`tools/tscircuit/run_board.mjs`)

Measuring a routing change through the full strategy ladder takes 20–50 min and the
earlier rungs are wall-clock budgeted, so under machine load the ladder can time out
before the rung you changed even runs (it did: a via-geometry change was "measured"
three times against copper the target rung never produced). Use these:

- `FL_ONLY_RUNG="<substring of rung name>"` — run just the matching rung(s), e.g.
  `FL_ONLY_RUNG="built-in router, 4-layer HDI"`. The log prints how many rungs it kept.
- `FL_LADDER_BUDGET_MS=3600000` — lift the 240 s ladder deadline. Skipped rungs are now
  logged as `[t] ladder: skipped '<rung>' — budget spent`.
- `FL_FR_DEBUG=1` — dump freerouting DSN passes and the via sizes fabRepair saw.
- `FL_VIA_PADSTACK=0` — opt OUT of the profile-derived freerouting via keep-out (on by
  default; `FL_VIA_PADSTACK_UM=<um>` overrides the size). With it the hard QFN board
  ships at 0 DRC errors through freerouting; 910 µm and up starts stranding nets.
- `FL_ROUTE_GND=1` — route GND as a net (chain of traces over the ground pins) before the
  pour. Opt-in: it closed the one open ground pad on an LQFP board (score 25 → 2) but
  stranded 4 nets on a QFN board the pour alone ships clean (0 → 175). Next step is a
  targeted retry for only the pads the pour reports unreached.
- `FL_GP_DEBUG=1` — the ground pour prints, per unreached GND pad, which rule rejected
  every via candidate (`hole` / `copper` / `track`).
- `FL_DUMP_CJ=<path>` — write the winning circuit-json.
- `FL_BASELINE=1` — disable every cache/skip optimisation (identical results, slower).

- `FL_THT_PADSTACK=0` opts out of inflating through-hole padstacks in the DSN (default on: header/terminal pad copper is grown so tracks and vias keep the profile's `hole_clearance` from the pad's HOLE, not just the trace clearance from its copper — the 0.43-0.49 mm hole-clearance class on boards with a 2.54 mm header).
- `FL_GND_RETRY=0` opts out of the targeted ground retry (default on): when the pour names ground pads it could not reach, the winning rung is re-run on the SAME placement with one 2-pin stub net per stranded pad to its nearest reached ground pad; kept only if the grounded board's DRC score drops AND no signal net opens. `FL_ROUTE_GND=1` still routes ALL of ground as a chain (opt-in).
- `FL_POUR_SELECT=0` opts out of post-pour rung selection (default on): the top 3 rungs by pre-pour score are each poured and the one whose GROUNDED board scores best ships (`drcRepair.pourSelection` records the candidates). The pour merges stub/chain nets into GND by NAME (a net between two ground pins), never by geometry.

Compare rung-to-rung using `drcRepair.iterations[]` in the output JSON, not the final
winner: the winner changes with whichever rungs the deadline let run.

## Building a board from the command line (no UI)

Two entry points, both in `tools/cli/`:

- **`tools/cli/fl-board.sh "<prompt>" [outdir]`** — no server, no auth. Runs the
  planner (`hardware/planner/plan_cli.py`), the netlist export (`synth.py --netlist`),
  and the router (`tools/tscircuit/run_board.mjs`): the same chain as the pipeline's
  electronics stage, minus the LLM architect's prompt rewrite. Prints the planner's
  honest report (substituted / unsupported parts), the ladder trail and the shipped
  verdict; writes `design.json`, `spec.json`, `board.json`, `board.kicad_pcb`, `run.log`.
  `FL_WALL_MS=285000` emulates the prod wall (SIGTERM at the wall; the runner ships
  its best rung with `wallHit: true`). `FL_ONLY_RUNG` / `FL_ROUTE_GND` etc. apply.
- **`FL_API_KEY=flk_live_… tools/cli/fl-api.sh "<prompt>"`** — the FULL pipeline over
  the programmatic API (`POST /api/v1/boards`, poll `GET /api/v1/runs/<id>`): same
  stages and gates as Compose, run owned by the key's creator. Mint a read_write key
  at `/enterprise/integrations`; export it, never pass it as an argument.
  `FL_BASE` overrides the base URL (default the production app).
- **`FL_APP_DIR=~/firstlight-prod/software/prompt-to-pcb-ui node tools/cli/fl-key.mjs --owner <email>`**
  mints a read_write key straight into that checkout's enterprise store (prints the
  plaintext once on stdout; revoke at `/enterprise/integrations`). Runs owned by the key
  are owned by `--owner`.

## Simulation solvers (tools/sim/run_sim.py)

The sim stage runs under the service's `python3` (`FL_PYTHON` overrides; the launchd
PATH puts /opt/homebrew/bin first). Gates, in the order they bit on real boards:

- **structural / enclosure 3D FEA** need `brew install costerwi/calculix/calculix-ccx`
  (found as `/opt/homebrew/bin/ccx_*`) AND the `gmsh` **Python module** in that
  interpreter: `/opt/homebrew/bin/python3 -m pip install --break-system-packages gmsh`.
  The gmsh CLI alone is not enough — the runner meshes through the Python API.
- **cavity acoustic FEM** needs ElmerSolver at `~/.local/elmer/bin/ElmerSolver` (no
  package for macOS; build from source with the GCC toolchain — Apple clang has no
  OpenMP: `-DCMAKE_C_COMPILER=gcc-16 -DCMAKE_CXX_COMPILER=g++-16 -DWITH_MPI=OFF
  -DWITH_ELMERGUI=OFF -DCMAKE_POLICY_VERSION_MINIMUM=3.5`).
- thermal / drop / PDN / RF need only scipy + ngspice; CFD needs OpenFOAM.

Check what the runner sees: `python3 tools/sim/run_sim.py < request.json` with a run's
`disciplines/simulation.json` → `inputs` as the request; rows say `install-gated: …`.

## Part registry (sourcing)

`tools/parts/registry.sqlite` is gitignored and holds the JLCPCB catalog (~684k
orderable parts, ~350 MB) that the planner's netlist export sources every part
from. A fresh checkout has an EMPTY registry and every BOM row comes out
unsourced. Populate it:

```bash
# download the jlcparts dataset (split zip: cache.zip + cache.z01..zNN) and join it
cd ~/.jlcparts-cache && for i in $(seq 1 40); do f=$(printf 'cache.z%02d' $i); curl -sfL -o "$f" "https://yaqwsx.github.io/jlcparts/data/$f" || { rm -f "$f"; break; }; done
curl -sfL -o cache.zip https://yaqwsx.github.io/jlcparts/data/cache.zip
cat $(ls cache.z?? | sort) cache.zip > joined.zip && unzip -o joined.zip     # -> cache.sqlite3 (~5.9 GB)
cd ~/EE-lab && python3 tools/parts/ingest_jlcparts.py --db ~/.jlcparts-cache/cache.sqlite3
cp tools/parts/registry.sqlite ~/firstlight-prod/tools/parts/registry.sqlite  # prod reads its own copy
```
`zip -s 0` does NOT join these parts correctly on macOS (produced a malformed
sqlite); `cat` in z01..zNN then .zip order does.
