# Mechanical ID-Fidelity Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop between industrial design and mechanical CAD, in two stages that share one vision judge: (A) the ID concept sheet must be SELF-consistent — all four quadrants depicting the same product — before it can serve as ground truth; (B) after the Onshape executor renders the enclosure, the judge scores the CAD against the ID brief (and the now-trustworthy concept sheet), and the mechanical stage revises the build plan from the judge's specific violations. Every verdict persists honestly, including "unverified" when no vision judge is available.

**Architecture:** Three pieces. (1) `render_plan.py` grows multi-view shaded renders (front/top/right/iso) — the CAD-side evidence, using the same Onshape shadedviews endpoint the isometric preview already uses. (2) A new `scripts/vision_judge.py` mirrors `llm_json.py`'s provider chain but with images: Anthropic SDK vision when a live key exists, else the local `claude` CLI reading image files via its Read tool (both metered keys are currently dead — the CLI tier is the working path; it MUST strip `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from the child env or the dead key overrides subscription auth). (3) `app/api/mechanical/route.ts` runs judge→revise rounds after `renderPlan` and persists `disciplines/mech-fidelity.json`.

**Tech Stack:** Onshape shadedviews API, Anthropic SDK 0.92.0 / claude CLI, Next.js route (existing mechanical stage), TypeScript.

**Honesty rules (non-negotiable):**
- No judge available → the stage still succeeds, fidelity is recorded as `"unverified"` with the reason. Never fake a score.
- The judge sees REAL renders of the REAL geometry. Never score the plan JSON.
- Revise rounds are capped (default 1, env-tunable) and every round's verdict is kept — the file shows the trajectory, not just the final number.

---

### Task 1: Multi-view shaded renders in the Onshape executor

**Files:**
- Modify: `tools/onshape/render_plan.py` (function `_shaded_png` and the export block around line 369)
- Create: `tools/onshape/tests/test_views_plan.json`

- [ ] **Step 1: Parameterize the view matrix and emit four views**

Replace the single `png_path = _shaded_png(...)` call site with:

```python
    png_path = _shaded_png(c, did, wid, eid, os.path.join(out_dir, "enclosure.png"))
    # fidelity evidence: the four canonical views the ID concept sheet uses
    # (front / perspective / top / side), rendered from the REAL geometry
    views_dir = os.path.join(out_dir, "views")
    os.makedirs(views_dir, exist_ok=True)
    view_paths = {}
    for vname, vm in _VIEW_MATRICES.items():
        p = _shaded_png(c, did, wid, eid, os.path.join(views_dir, vname + ".png"), vm)
        if p:
            view_paths[vname] = p
```

And add `"viewPaths": view_paths,` to the returned dict.

Change `_shaded_png` to accept the matrix:

```python
_VIEW_MATRICES = {
    # rows of the camera rotation, 12 comma floats (same format as the iso
    # preview): front looks along -Y with Z up; top looks down -Z; right
    # looks along -X with Z up; iso is the existing preview matrix.
    "front": "1,0,0,0,0,0,1,0,0,-1,0,0",
    "top": "1,0,0,0,0,1,0,0,0,0,1,0",
    "right": "0,1,0,0,0,0,1,0,1,0,0,0",
    "iso": "0.707,0.707,0,0,-0.408,0.408,0.816,0,0.577,-0.577,0.577,0",
}


def _shaded_png(c, did, wid, eid, out_path,
                vm="0.707,0.707,0,0,-0.408,0.408,0.816,0,0.577,-0.577,0.577,0"):
    """Shaded PNG of the part studio from the given view matrix; path or None."""
```

(body unchanged — it already uses `vm`).

- [ ] **Step 2: Write the asymmetric verification plan**

A cube can't prove the matrices differ. This part is taller than wide, with a front-face cutout — each view must look different:

```json
{
  "part": "view-check",
  "units": "mm",
  "operations": [
    { "op": "sketch", "name": "base", "plane": "top", "profile": { "kind": "roundedRect", "cx": 0, "cy": 0, "w": 30, "h": 12, "r": 2 } },
    { "op": "extrude", "name": "body", "sketch": "base", "depth": 50 },
    { "op": "cutout", "name": "frontSlot", "face": "front", "cx": 0, "cy": 25, "w": 10, "h": 30, "depth": 3, "offsetMm": 3 }
  ]
}
```

Save as `tools/onshape/tests/test_views_plan.json`.

- [ ] **Step 3: Run the executor against it and verify the views differ**

```bash
cd "/Volumes/T9 Backup/EE-lab"
mkdir -p /tmp/viewcheck
python3 tools/onshape/render_plan.py /tmp/viewcheck view-check < tools/onshape/tests/test_views_plan.json | python3 -m json.tool | grep -E "ok|viewPaths" -A6
python3 - <<'EOF'
import hashlib, glob
hs = {p: hashlib.md5(open(p, 'rb').read()).hexdigest() for p in glob.glob('/tmp/viewcheck/views/*.png')}
assert len(hs) == 4, "expected 4 views, got %d" % len(hs)
assert len(set(hs.values())) == 4, "some views are IDENTICAL — matrices wrong: %r" % hs
print("4 distinct views OK")
EOF
```

Expected: `"ok": true`, four view paths, `4 distinct views OK`. Then open `/tmp/viewcheck/views/front.png` — the front slot must be visible face-on; the top view must show only the 30×12 outline. If front/right are swapped, swap those two matrices.

- [ ] **Step 4: Commit**

```bash
git add tools/onshape/render_plan.py tools/onshape/tests/test_views_plan.json
git commit -m "mech: multi-view shaded renders (front/top/right/iso) for the fidelity judge"
```

---

### Task 2: Vision judge script

**Files:**
- Create: `software/prompt-to-pcb-ui/scripts/vision_judge.py`

- [ ] **Step 1: Write the judge**

Same provider-chain philosophy as `scripts/llm_json.py` (read that file first — reuse its `_first_json` style extraction and CLI env-stripping exactly):

```python
#!/usr/bin/env python3
"""Vision JSON judgment — images + rubric in, one JSON verdict out.

stdin:  {"system": str, "user": str, "images": [abs paths]}
stdout: {"ok": true, "provider": str, "verdict": {...}}
        {"ok": false, "reason": "unavailable", "errors": [...]}   # honest gate

Providers, in order:
  anthropic  — SDK vision blocks (works when the metered key is alive)
  claude-cli — local Max subscription: `claude -p` with ONLY the Read tool,
               prompt references the image paths; the CLI reads them visually.
               MUST strip ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the
               child env (a dead key otherwise overrides subscription auth).
"""
import base64
import json
import os
import subprocess
import sys


def _first_json(text):
    i = text.find("{")
    while i != -1:
        depth = 0
        for j in range(i, len(text)):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[i:j + 1])
                    except Exception:
                        break
        i = text.find("{", i + 1)
    raise ValueError("no JSON object in model reply")


def _anthropic(system, user, images):
    import anthropic
    client = anthropic.Anthropic()
    content = []
    for p in images:
        ext = os.path.splitext(p)[1].lower().lstrip(".")
        media = "image/jpeg" if ext in ("jpg", "jpeg") else "image/" + (ext or "png")
        content.append({"type": "image", "source": {
            "type": "base64", "media_type": media,
            "data": base64.b64encode(open(p, "rb").read()).decode()}})
    content.append({"type": "text", "text": user})
    out = []
    with client.messages.stream(
            model="claude-opus-4-8", max_tokens=2000, system=system,
            messages=[{"role": "user", "content": content}]) as s:
        for t in s.text_stream:
            out.append(t)
    return _first_json("".join(out))


def _claude_cli(system, user, images):
    img_lines = "\n".join("Read this image file: %s" % p for p in images)
    prompt = "%s\n\n%s\n\n%s\n\nReply with ONLY the JSON object." % (system, img_lines, user)
    env = {k: v for k, v in os.environ.items()
           if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}
    r = subprocess.run(
        ["claude", "-p", "--model", "opus", "--output-format", "text",
         "--allowedTools", "Read"],
        input=prompt, capture_output=True, text=True, timeout=300, env=env)
    if r.returncode != 0:
        raise RuntimeError("claude cli rc=%d: %s" % (r.returncode, (r.stderr or "")[:200]))
    return _first_json(r.stdout)


def main():
    req = json.load(sys.stdin)
    system, user = req.get("system", ""), req.get("user", "")
    images = [p for p in req.get("images", []) if os.path.exists(p)]
    if not images:
        print(json.dumps({"ok": False, "reason": "unavailable",
                          "errors": ["no readable images"]}))
        return 0
    errs = []
    for name, fn in (("anthropic", _anthropic), ("claude-cli", _claude_cli)):
        try:
            verdict = fn(system, user, images)
            print(json.dumps({"ok": True, "provider": name, "verdict": verdict}))
            return 0
        except Exception as e:
            errs.append("%s: %s" % (name, str(e)[:200]))
    print(json.dumps({"ok": False, "reason": "unavailable", "errors": errs}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Test with two synthetic images (real vision, tiny cost)**

```bash
cd "/Volumes/T9 Backup/EE-lab/software/prompt-to-pcb-ui"
python3 - <<'EOF'
# two obviously different images: a red square and a blue circle
from PIL import Image, ImageDraw
a = Image.new("RGB", (200, 200), "white"); ImageDraw.Draw(a).rectangle([50, 50, 150, 150], fill="red"); a.save("/tmp/vj_a.png")
b = Image.new("RGB", (200, 200), "white"); ImageDraw.Draw(b).ellipse([50, 50, 150, 150], fill="blue"); b.save("/tmp/vj_b.png")
EOF
echo '{"system":"You compare images and answer in JSON.","user":"Image 1 and image 2: same shape and color? Reply {\"same\": bool, \"shape1\": str, \"shape2\": str}","images":["/tmp/vj_a.png","/tmp/vj_b.png"]}' \
  | python3 scripts/vision_judge.py | python3 -m json.tool
```

Expected: `"ok": true`, verdict with `"same": false`, shape1 square-ish, shape2 circle-ish. (If Pillow is missing, generate the PNGs with any tool — the judge doesn't care how they were made.)

- [ ] **Step 3: Commit**

```bash
git add scripts/vision_judge.py
git commit -m "mech: vision judge — image JSON verdicts over the llm_json provider chain"
```

---

### Task 3: ID concept-sheet self-consistency gate

The sheet is ONE image-gen call asked to draw a 2×2 grid — image models routinely draw four slightly different products, and nothing checks. An inconsistent sheet poisons the mechanical judge (no ground truth). Two layers: harden the prompt, then GATE the result with the vision judge and regenerate from the specific mismatches. (Sequential hero-conditioned generation — perspective view first, fed as the reference for the other three — is the reserve move if the gate shows this loop not converging; do NOT build it in this plan.)

**Files:**
- Modify: `software/prompt-to-pcb-ui/app/api/id-render/route.ts`

- [ ] **Step 1: Harden the prompt**

In `buildPrompt`, after the four-quadrant layout line, add:

```typescript
    'CRITICAL — all four quadrants depict the IDENTICAL physical object, as if four photographs of ONE prototype on a turntable: identical proportions, identical color/material/finish, and every feature (port, button, vent, window, seam) in the same position in every view where its face is visible. No variations between views.',
```

- [ ] **Step 2: Add the consistency judge + retry loop**

Add next to the imports (same spawn pattern the mechanical route uses in Task 5 — if Task 5 hasn't run yet, copy the `runJudge` function here; extract to a shared `lib/` helper only if both land):

```typescript
import { spawn } from 'node:child_process'

const CONSISTENCY_ROUNDS = Number(process.env.FL_ID_CONSISTENCY_ROUNDS || 1)
const CONSISTENCY_ENABLED = process.env.FL_ID_CONSISTENCY !== '0'

function runJudge(images: string[], system: string, user: string): Promise<{ ok: boolean; provider?: string; verdict?: unknown; errors?: string[] }> {
  const script = path.join(process.cwd(), 'scripts', 'vision_judge.py')
  return new Promise((resolve) => {
    const py = spawn(process.env.FL_PYTHON || 'python3', [script], { timeout: 320_000 })
    let out = ''
    py.stdout.on('data', (d) => (out += d))
    py.on('error', () => resolve({ ok: false, errors: ['spawn failed'] }))
    py.on('close', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop() || '{}')) }
      catch { resolve({ ok: false, errors: ['judge produced no JSON'] }) }
    })
    py.stdin.write(JSON.stringify({ system, user, images }))
    py.stdin.end()
  })
}

const CONSISTENCY_SYSTEM =
  'You inspect a 2x2 industrial-design concept sheet (front / perspective / top / side of what should be ONE product). ' +
  'You check whether all four quadrants depict the SAME physical object. Ignore lighting and viewing angle; flag real ' +
  'disagreements: different proportions, a feature present in one view and absent where its face is visible in another, ' +
  'different feature positions, different colors or materials. Reply with ONLY a JSON object.'

const CONSISTENCY_USER =
  'Is this sheet self-consistent — one product, four views? Reply with ONLY: ' +
  '{"consistent": bool, "score": 0-100, "mismatches": [{"views": "which two views disagree", "detail": "what differs, concretely"}]}'
```

Then restructure `POST`'s generate step into a loop. The current code calls `generateImage(prompt, scaffoldPng)` once and persists; replace with:

```typescript
    let prompt = buildPrompt(brief)
    let result = await generateImage(prompt, scaffoldPng)
    const consistency: { state: 'verified' | 'failed-threshold' | 'unverified'; reason?: string; rounds: { round: number; provider: string; verdict: unknown }[] } =
      { state: 'unverified', rounds: [] }

    if (result.ok && CONSISTENCY_ENABLED && runId && RUN_ID.test(runId)) {
      for (let round = 0; round <= CONSISTENCY_ROUNDS; round++) {
        // the judge reads files — write the candidate to a temp path in the run dir
        const dir = path.join(process.cwd(), 'public', 'runs', runId, 'id')
        await fs.mkdir(dir, { recursive: true })
        const candidate = path.join(dir, `candidate-${round}.${result.mime === 'image/png' ? 'png' : 'jpg'}`)
        await fs.writeFile(candidate, Buffer.from(result.dataBase64, 'base64'))

        const res = await runJudge([candidate], CONSISTENCY_SYSTEM, CONSISTENCY_USER)
        if (!res.ok) { consistency.reason = (res.errors ?? []).join(' | ') || 'judge unavailable'; break }
        const v = (res.verdict ?? {}) as { consistent?: boolean; score?: number; mismatches?: { views?: string; detail?: string }[] }
        consistency.rounds.push({ round, provider: res.provider ?? '?', verdict: v })

        if (v.consistent === true || (typeof v.score === 'number' && v.score >= 80)) { consistency.state = 'verified'; break }
        if (round === CONSISTENCY_ROUNDS) { consistency.state = 'failed-threshold'; break }
        // regenerate with the SPECIFIC mismatches as added constraints
        const fixes = (v.mismatches ?? []).map((m, i) => `${i + 1}. ${m.views}: ${m.detail}`).join(' ')
        const retry = await generateImage(
          prompt + ` PREVIOUS ATTEMPT WAS INCONSISTENT BETWEEN VIEWS — fix exactly these disagreements and keep everything else: ${fixes}`,
          scaffoldPng)
        if (!retry.ok) { consistency.reason = 'regeneration gated: ' + (retry.message ?? retry.reason); break }
        result = retry
      }
      try {
        await fs.writeFile(path.join(process.cwd(), 'public', 'runs', runId, 'id', 'consistency.json'),
          JSON.stringify(consistency, null, 1))
      } catch { /* evidence file, not a gate */ }
    }
```

The existing persist block then writes whatever `result` ended as (the best candidate). Clean up `candidate-*.png` files after persisting, or leave them — they're useful evidence; leaving them is fine, note it in the response payload. Add `consistency` to the route's JSON response.

- [ ] **Step 3: Typecheck**

Run: `cd software/prompt-to-pcb-ui && npx tsc --noEmit`
Expected: silent. (`generateImage`'s failure shape is `{ ok: false, reason, message }` — check `lib/image-gen.ts` and match its actual field names.)

- [ ] **Step 4: Live test on a real brief**

Replay `/api/id-render` for a run that previously produced a visibly inconsistent sheet (POST the same brief + scaffold). Read `public/runs/<runId>/id/consistency.json`: round 0's mismatches must describe REAL disagreements visible in `candidate-0.*` (spot-check by eye), and the final sheet should be the improved candidate. If the judge chain is down, state must be `unverified` with the reason — and the sheet still ships.

- [ ] **Step 5: Commit**

```bash
git add app/api/id-render/route.ts
git commit -m "id: concept-sheet self-consistency gate — judge + constrained regeneration"
```

---

### Task 4: Fidelity types + prompts (TypeScript)

**Files:**
- Create: `software/prompt-to-pcb-ui/lib/mech-fidelity.ts`

- [ ] **Step 1: Write the module**

```typescript
/**
 * Mechanical ID-fidelity contract — the judge's rubric, the verdict shape,
 * and the critique block fed back into the mechanical planner on a revise
 * round. The judge compares RENDERED CAD (multi-view PNGs) against the ID
 * brief text and, when the concept sheet exists, the ID render image.
 */
import type { IdBrief } from '@/lib/id-brief'

export interface FidelityViolation {
  aspect: 'formFactor' | 'envelope' | 'feature' | 'control' | 'proportion' | 'other'
  expected: string
  observed: string
  fix: string // concrete, actionable, in build-plan vocabulary terms
}

export interface FidelityVerdict {
  score: number // 0-100
  adheres: boolean
  violations: FidelityViolation[]
  summary: string
}

export interface FidelityRound {
  round: number
  provider: string
  verdict: FidelityVerdict
}

export interface FidelityReport {
  state: 'verified' | 'failed-threshold' | 'unverified'
  reason?: string // for unverified: why the judge was unavailable
  threshold: number
  rounds: FidelityRound[]
}

export const FIDELITY_THRESHOLD = Number(process.env.FL_MECH_FIDELITY_THRESHOLD || 70)
export const FIDELITY_ROUNDS = Number(process.env.FL_MECH_FIDELITY_ROUNDS || 1)
export const FIDELITY_ENABLED = process.env.FL_MECH_FIDELITY !== '0'

export function judgeSystem(): string {
  return (
    'You are an industrial-design reviewer. You compare rendered CAD views of an ' +
    'enclosure against an industrial design brief (and a concept sheet image when ' +
    'provided). You are strict about FORM (silhouette, proportions, envelope) and ' +
    'FEATURES (ports, vents, controls, windows present in the right faces), and ' +
    'you ignore rendering style, color, and material appearance — the CAD is ' +
    'unstyled geometry. Reply with ONLY a JSON object.'
  )
}

export function judgeUser(brief: IdBrief, viewNames: string[], hasConceptSheet: boolean): string {
  const briefTxt = JSON.stringify({
    product: brief.product,
    formFactor: brief.formFactor,
    envelopeMm: brief.envelopeMm,
    ergonomics: brief.ergonomics,
    keyFeatures: brief.keyFeatures,
    controls: brief.controls,
    constraints: brief.constraints,
  })
  return [
    `CAD views provided, in order: ${viewNames.join(', ')}.`,
    hasConceptSheet
      ? 'The FINAL image is the ID concept sheet (2x2: front, perspective, top, side) — the form the CAD must realize.'
      : 'No concept sheet is available — judge against the brief text alone.',
    `ID BRIEF: ${briefTxt}`,
    'Score how faithfully the CAD realizes the ID (0-100; 100 = the concept made solid).',
    'Every violation must carry a concrete "fix" phrased for a parametric CAD planner whose vocabulary is: sketch (roundedRect/rect/circle/ring), extrude, pocket, standoff, cutout (on a named face), fillet, component.',
    'Reply with ONLY: {"score": n, "adheres": bool, "violations": [{"aspect": "formFactor|envelope|feature|control|proportion|other", "expected": str, "observed": str, "fix": str}], "summary": str}',
  ].join('\n')
}

export function critiqueBlock(round: number, verdict: FidelityVerdict): string {
  const fixes = verdict.violations.map((v, i) => `${i + 1}. [${v.aspect}] ${v.fix} (expected: ${v.expected}; currently: ${v.observed})`)
  return (
    `\nFIDELITY CRITIQUE (revision round ${round} — a design reviewer compared the RENDERED CAD to the ID brief; score ${verdict.score}/100):\n` +
    fixes.join('\n') +
    `\nRevise the plan to resolve these SPECIFIC violations. Keep everything that already adheres (board fit, standoffs at real hole positions, wall rules) unchanged.\n`
  )
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && isFinite(v) ? v : d)

export function normalizeVerdict(raw: unknown): FidelityVerdict {
  const r = (raw ?? {}) as Record<string, unknown>
  const asp = ['formFactor', 'envelope', 'feature', 'control', 'proportion', 'other']
  const violations: FidelityViolation[] = (Array.isArray(r.violations) ? r.violations : [])
    .map((v: any): FidelityViolation => ({
      aspect: asp.includes(v?.aspect) ? v.aspect : 'other',
      expected: String(v?.expected ?? ''),
      observed: String(v?.observed ?? ''),
      fix: String(v?.fix ?? ''),
    }))
    .filter((v) => v.fix)
  const score = Math.max(0, Math.min(100, num(r.score, 0)))
  return { score, adheres: r.adheres === true, violations, summary: String(r.summary ?? '') }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd software/prompt-to-pcb-ui && npx tsc --noEmit`
Expected: silent. (`lib/id-brief.ts` exports `IdBrief` — verify the field names used in `judgeUser` against it and adjust to its actual shape if any differ.)

- [ ] **Step 3: Commit**

```bash
git add lib/mech-fidelity.ts
git commit -m "mech: fidelity verdict contract + judge prompts + critique block"
```

---

### Task 5: The loop in the mechanical route

**Files:**
- Modify: `software/prompt-to-pcb-ui/app/api/mechanical/route.ts`

- [ ] **Step 1: Add the judge runner (next to `renderPlan`, same spawn pattern)**

```typescript
import { FIDELITY_ENABLED, FIDELITY_ROUNDS, FIDELITY_THRESHOLD, critiqueBlock, judgeSystem, judgeUser, normalizeVerdict, type FidelityReport } from '@/lib/mech-fidelity'

/** Run the vision judge; resolves to a report entry or an unavailable marker. */
function runJudge(images: string[], system: string, user: string): Promise<{ ok: boolean; provider?: string; verdict?: unknown; errors?: string[] }> {
  const script = path.join(process.cwd(), 'scripts', 'vision_judge.py')
  return new Promise((resolve) => {
    const py = spawn(process.env.FL_PYTHON || 'python3', [script], { timeout: 320_000 })
    let out = ''
    py.stdout.on('data', (d) => (out += d))
    py.on('error', () => resolve({ ok: false, errors: ['spawn failed'] }))
    py.on('close', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop() || '{}')) }
      catch { resolve({ ok: false, errors: ['judge produced no JSON'] }) }
    })
    py.stdin.write(JSON.stringify({ system, user, images }))
    py.stdin.end()
  })
}
```

- [ ] **Step 2: Wrap the existing plan→render flow in the fidelity loop**

In `POST`, the current code builds `userMsg`, calls `callLLM`, then `renderPlan`. Restructure to:

```typescript
    const fidelity: FidelityReport = { state: 'unverified', threshold: FIDELITY_THRESHOLD, rounds: [] }
    let plan = await callLLM(userMsg, override)
    let rendered = await renderPlan(plan, outDir, name)

    if (FIDELITY_ENABLED && idBrief) {
      for (let round = 0; round <= FIDELITY_ROUNDS; round++) {
        const viewNames = ['front', 'top', 'right', 'iso'].filter((v) => rendered?.viewPaths?.[v])
        const images = viewNames.map((v) => rendered.viewPaths[v] as string)
        // concept sheet last, when the ID render exists (render.json pointer)
        let hasSheet = false
        try {
          const meta = JSON.parse(await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, 'id', 'render.json'), 'utf8'))
          const sheet = path.join(process.cwd(), 'public', meta.url.split('?')[0])
          await fs.access(sheet)
          images.push(sheet); hasSheet = true
        } catch { /* no concept sheet — brief-text judging */ }
        if (!images.length) { fidelity.reason = 'no CAD views rendered'; break }

        const res = await runJudge(images, judgeSystem(), judgeUser(idBrief, viewNames, hasSheet))
        if (!res.ok) { fidelity.reason = (res.errors ?? []).join(' | ') || 'judge unavailable'; break }
        const verdict = normalizeVerdict(res.verdict)
        fidelity.rounds.push({ round, provider: res.provider ?? '?', verdict })

        if (verdict.adheres || verdict.score >= FIDELITY_THRESHOLD) { fidelity.state = 'verified'; break }
        if (round === FIDELITY_ROUNDS) { fidelity.state = 'failed-threshold'; break }
        // revise: same grounded prompt + the judge's concrete fixes
        plan = await callLLM(userMsg + critiqueBlock(round + 1, verdict), override)
        rendered = await renderPlan(plan, outDir, name)
      }
    } else if (FIDELITY_ENABLED && !idBrief) {
      fidelity.reason = 'no ID brief for this run'
    } else {
      fidelity.reason = 'disabled (FL_MECH_FIDELITY=0)'
    }

    try {
      const dDir = path.join(process.cwd(), 'public', 'runs', runId, 'disciplines')
      await fs.mkdir(dDir, { recursive: true })
      await fs.writeFile(path.join(dDir, 'mech-fidelity.json'), JSON.stringify(fidelity, null, 1))
    } catch { /* fidelity file is evidence, not a gate on the response */ }
```

Include `fidelity` in the route's JSON response alongside the existing render fields, so the client can show the score/state.

- [ ] **Step 3: Typecheck**

Run: `cd software/prompt-to-pcb-ui && npx tsc --noEmit`
Expected: silent. (Adjust to the file's real local variable names — `outDir`, `name`, `override`, `userMsg` — whatever the current `POST` uses; the loop preserves the existing single-pass behavior when fidelity is disabled or the brief is missing.)

- [ ] **Step 4: Commit**

```bash
git add app/api/mechanical/route.ts
git commit -m "mech: ID-fidelity loop — judge rendered CAD vs ID brief, revise from violations"
```

---

### Task 6: Integration test, regression, ship

- [ ] **Step 1: Find a real run with an ID brief to replay**

```bash
cd "/Volumes/T9 Backup/EE-lab/software/prompt-to-pcb-ui"
ls public/runs/*/disciplines/id-brief.json 2>/dev/null | tail -3
```

Pick the newest `runId`. If none exists, run one Compose job in the UI first (any product with an enclosure).

- [ ] **Step 2: Replay the mechanical stage against it**

```bash
RUN=<runId>
SPEC=$(python3 -c "import json;print(json.dumps(json.load(open('public/runs/$RUN/spec.json'))))" 2>/dev/null || echo '{"product":"test enclosure"}')
curl -s -X POST http://localhost:3000/api/mechanical \
  -H 'content-type: application/json' \
  -d "{\"runId\":\"$RUN\",\"spec\":$SPEC}" | python3 -m json.tool | grep -E '"state"|"score"|"adheres"|"summary"|ok' 
cat "public/runs/$RUN/disciplines/mech-fidelity.json" | python3 -m json.tool
```

Expected: `mech-fidelity.json` exists with `state` one of `verified` / `failed-threshold` (real verdicts with violations), OR `unverified` with an honest reason if the judge chain is down. Eyeball the round-0 violations against the actual views in the run dir — they must describe things visible in the images, not hallucinated features.

- [ ] **Step 3: Regression — fidelity disabled must equal old behavior**

```bash
FL_MECH_FIDELITY=0 npm run dev &   # or set in the service env for one run
# re-POST the same request; expect the same render fields as before,
# fidelity.state == "unverified", reason "disabled (FL_MECH_FIDELITY=0)"
```

Expected: mechanical stage output unchanged apart from the fidelity field; no judge spawned.

- [ ] **Step 4: Ship**

```bash
cd "/Volumes/T9 Backup/EE-lab"
git push origin repo-review-hardening-auth-ux
cd software/prompt-to-pcb-ui && npm run build
launchctl kickstart -k gui/501/build.firstlight.compose
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/   # expect 307
```

- [ ] **Step 5: Live smoke + memory**

Run one full Compose job with a form-heavy prompt (e.g. "handheld GPS tracker with an angled fascia and side lanyard loop") and read `mech-fidelity.json`: round 0 should catch the fascia/loop if the plan skipped them, and round 1's render should score higher. Then write the shipped state + traps (view matrices, judge availability, prompt-injection-shaped critique) into a `firstlight-mech-fidelity.md` memory file and index it in MEMORY.md.
