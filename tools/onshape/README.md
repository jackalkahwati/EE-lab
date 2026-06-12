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

## Capabilities proven (all via POST, no rate-limited GETs needed)

- `add_sketch`/`add_extrude` (NEW bodies), with arcs via `rounded_rect()`
- `delete_bodies()` — deleteBodies feature by partIds
- `transform_translate()` — move bodies (sketches do NOT move with them)
- `fillet_edge_at()` — 3D fillets, edge picked by FeatureScript
  qContainsPoint query string
- `add_extrude_remove()` — scoped boolean cuts (used for the 132-hole shell
  vent fields in a single feature)
- `all_bboxes()` — every solid's bbox in one FeatureScript eval
- Part rename + appearance (color/opacity) via metadata

## Hard-won API facts

- **Rate limits**: the per-part `boundingboxes` endpoint 429s after ~100
  rapid calls and the window outlasts 15 s backoff. Use `all_bboxes()`
  (single FeatureScript eval) for anything model-wide; throttle builds ~2 s.
- **URL-encode partIds** — they contain `+` and `/` (`quote(pid, safe="")`).
- **FeatureScript**: `box` is a reserved word; eval responses nest values as
  `BTFSValue*` btType objects (decode `key` before `value`); the `queries`
  param must be `{}` not `[]`.
- **Sketch entity geometry is in METERS** (Onshape internal SI) while
  depth/offset feature parameters are mm expression strings. Passing mm
  sketch coords puts geometry ~1000x off in space; scoped REMOVE cuts then
  land in benign-looking INFO state and cut NOTHING (THROUGH_ALL cuts
  ERROR). If a cut reports INFO, render and check before building on it.
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
  guessing default-plane deterministic IDs — or use the probed IDs for this
  document: Top "JDC" (xy→XY, +Z), Front "JCC" (xy→XZ, −Y), Right "JEC"
  (xy→+Y,Z, +X). Probe with a throwaway body when in doubt.
- `GET /features` has a long penalty window once tripped (minutes+, survives
  8-min waits). Design scripts to avoid it: feature POSTs return the
  featureId for later deletion; name new bodies via the parts list; use
  `all_bboxes()` for geometry. Everything in this toolchain's helper layer
  is GET-free except `plane_param()`/`get_features()`.
- REMOVE extrudes ERROR (no notices) when the cut boundary is exactly
  coincident with a target body's face. Inset the cut, or use the
  tangent-fillet trick: radius chosen so the curve meets the obstructing
  face exactly (see finish_pass.py step 11).
- Transform moves bodies but not their defining sketches — orphaned sketch
  curves remain at the old location; hide sketches in the UI.

## Assembly mates via API: verdict (2026-06-11)

- **Mate groups work** (`BTMMateGroup-65` + `BTMIndividualOccurrenceQuery-626`
  paths). `motion_check.py` partitions 263 instances into Static/X/Y/Z rigid
  groups programmatically — the bulk of manual mating.
- **Slider mates can be created** — but only by cloning a real UI mate's full
  serialization (found via public-document search): all 26 parameters, plus
  implicit `BTMMateConnector-66` sub-features whose originQuery is
  `BTMInferenceQueryWithOccurrence-1083` with `inferenceType: MID_AXIS_POINT`
  on a cylindrical face. Raw `BTMIndividualQueryWithOccurrence-811` geometry
  queries in `mateConnectorsQuery` get silently blanked.
- **But don't**: implicit connectors on independently-extruded cylinders get
  arbitrary secondary axes; the slider's rotation lock then rests the stages
  in a rotated configuration. `matevalues` POST works (needs
  `ownerOccurrencePath`) but cannot correct it, and `occurrencetransforms`
  is overridden by the solver; one assembly wedged permanently (transforms
  accepted but ignored even after deleting all mates) and had to be deleted
  and rebuilt. Final division of labor: groups + verification via API,
  the 3 slider mates by hand in the UI (~30 s each, screw cylinder -> nut
  cylinder -> limits).

## Browser automation (MCP browser / CDP) — slider mates: SOLVED (2026-06-11)

Where the REST API could not create healthy slider mates, driving the
Onshape web UI through the logged-in Chrome (port 9222) succeeded: the
Motion Check assembly now has all 4 groups + 3 slider mates (X/Y/Z
screw-to-nut), all OK, parked at exact relative zero via the matevalues
endpoint afterward.

Technique notes:
- Onshape's WebGL canvas accepts synthetic (untrusted) pointer events —
  dispatch pointermove/mousemove, dwell ~400 ms (the inference raycast
  needs frames), then pointerdown/up + click.
- Per-mate-type toolbar buttons exist (use[href$="#svg-icon-slider"]);
  instance-list filtering, multi-select, and context-menu Isolate are all
  DOM. Keyboard Shift+7/Shift+1 switch Iso/Front views (the view cube is
  canvas, not DOM).
- Verify picks by counting "Mate connector of" in the dialog's innerText —
  but reads LAG the solve by 1-2 s; a successful second pick SNAPS the
  parts immediately, so stale follow-up clicks toggle connectors off.
  Pattern that works: one candidate -> wait 2.5 s -> accept immediately
  when the count hits 2.
- Tiny targets (the nut collar): separate the parts first by transforming
  the free group along its DOF via occurrencetransforms (legal moves stick),
  then pick the fat lone target.
- NEVER round-trip-update mate features via the REST features endpoint —
  it corrupts units/queries (limits became "0 deg") and the browser undo
  stack does not see API edits. Set limits in the creation dialog or edit
  in UI; set positions via matevalues only.
- Mates have gauge freedom with nothing Fixed: relative park is exact, the
  global offset is one UI Fix away (right-click a static part -> Fix).
