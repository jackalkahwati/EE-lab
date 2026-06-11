# Onshape API Toolchain

Direct Onshape REST automation for the bring-up station CAD. Built after
Adam (adam.new) proved uneconomical on the 190+ part studio — these scripts
did the entire EVT motion pass (≈75 vendor-true bodies, 2 fix passes, full
audit) for zero tokens.

## Setup

API keys from https://dev-portal.onshape.com/keys (Read + Write documents),
stored in `.env` (gitignored):

```
ONSHAPE_ACCESS_KEY=...
ONSHAPE_SECRET_KEY=...
```

Run anything with: `set -a && source .env && set +a && python3 <script>`

Target document/IDs are hardcoded at the top of each script ("EE lab",
Part Studio 1).

## Files

- `onshape_client.py` — minimal REST client (Basic Auth, 429/5xx retry)
- `features.py` — sketch/extrude/composite feature builder + part naming +
  `all_bboxes()` (every solid's bbox in ONE FeatureScript eval call)
- `create_subsystem_assemblies.py` — assembly tabs + instance inserts
- `build_x_axis_evt.py`, `build_y_axis_evt.py`, `build_z_axis_evt.py` —
  EVT motion geometry (Run 1–3); headers document the engineering deviations
- `build_run4_sensors_swept.py` — limit switches, swept volumes, clearance report
- `fix_pass_x_drive_relocation.py` — X drive Y=0 → Y=−257 (work-corridor fix)
- `fix_pass2_audit_defects.py` — the 19 park-position defect fixes
- `audit_run5.py` — full audit: states, naming, park interference with
  containment whitelist, per-body swept checks, coaxiality, stack heights

## Hard-won API facts

- **Rate limits**: the per-part `boundingboxes` endpoint 429s after ~100
  rapid calls and the window outlasts 15 s backoff. Use `all_bboxes()`
  (single FeatureScript eval) for anything model-wide; throttle builds ~2 s.
- **URL-encode partIds** — they contain `+` and `/` (`quote(pid, safe="")`).
- **FeatureScript**: `box` is a reserved word; eval responses nest values as
  `BTFSValue*` btType objects (decode `key` before `value`); the `queries`
  param must be `{}` not `[]`.
- **Extrude params**: `startOffsetBound` uses enum `StartOffsetType` (not
  `BoundingType`). `symmetric: true` works with BLIND + full depth.
- **Plane conventions** (verified empirically): Top sketch (x,y)→world (X,Y),
  extrude +Z. Right sketch (x,y)→world (+Y,Z), extrude +X. Front sketch
  (x,y)→world (X,Z), extrude −Y; both `opposite=True` and
  `offset_opposite=True` → span [offset, offset+depth] in +Y.
- **Composite parts can't be inserted into assemblies via the public
  instances endpoint** — returns 200 with empty body and does nothing.
  Insert member parts individually instead.
- **Onshape 500/502s happen mid-session** — every build script is
  idempotent (skips features that already exist by name) so re-running
  after a crash is safe; orphan sketches from failed extrudes need cleanup.
- Clone the `sketchPlane` parameter from an existing sketch rather than
  guessing default-plane deterministic IDs.
