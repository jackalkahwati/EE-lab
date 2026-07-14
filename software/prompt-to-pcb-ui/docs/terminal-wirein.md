# Terminal panel + status bar — wire-in instructions

Standalone pieces already built (no existing file touched):

- `lib/terminal-log.ts` — client log bus: `logLine()`, `clearLog()`, `useTerminalLog()`, `useProblemCount()`
- `components/terminal-panel.tsx` — `<TerminalPanel collapsed onToggle heightPx? tab? onTabChange?/>`
- `components/status-bar.tsx` — `<StatusBar runId pipeline running tiers problemCount onProblemsClick startedAt/>`

The panel reads the log bus itself; the status bar is 100% prop-driven. Nothing
below runs until these edits land, so apply them when the live run is over and
a reload is safe.

---

## A. `app/compose/page.tsx` — mount the panel + bar below the 3-pane row

### A1. Imports (top of file, with the other component imports)

```tsx
import { TerminalPanel, type TerminalTab } from '@/components/terminal-panel'
import { StatusBar } from '@/components/status-bar'
import { logLine, useProblemCount } from '@/lib/terminal-log'
```

### A2. State (inside `Compose2Page`, next to the other useState calls, e.g. right after `const [pipelineRunId, setPipelineRunId] = useState<string | null>(null)`)

```tsx
// bottom Terminal panel + status bar
const [termCollapsed, setTermCollapsed] = useState(true)
const [termTab, setTermTab] = useState<TerminalTab>('terminal')
const problemCount = useProblemCount()
// wall-clock start of the in-flight pipeline (drives the status-bar elapsed)
const [pipeStartedAt, setPipeStartedAt] = useState<number | null>(null)
```

### A3. Collapse persistence (localStorage key `c2-termCollapsed`)

The page already has a mount effect restoring `c2-leftW` / `c2-rightW`
(`useEffect` starting `const l = Number(localStorage.getItem('c2-leftW'))`).
Add one line inside it:

```tsx
setTermCollapsed(localStorage.getItem('c2-termCollapsed') !== '0')  // default collapsed
```

and use a toggle handler that persists:

```tsx
const toggleTerm = () => setTermCollapsed((c) => {
  localStorage.setItem('c2-termCollapsed', c ? '0' : '1')  // '0' = open
  return !c
})
```

### A4. Layout — full-width row BELOW the 3-pane row

The main return (the one starting
`<main className="flex h-[calc(100dvh-2.75rem)] overflow-hidden bg-background text-foreground">`)
is currently a horizontal flex of `aside / Handle / section / Handle / section`.
Make the main a column, wrap the existing five children in a `flex-1` row, and
append the two new components:

```tsx
<main className="flex h-[calc(100dvh-2.75rem)] flex-col overflow-hidden bg-background text-foreground">
  <div className="flex min-h-0 flex-1 overflow-hidden">
    {/* ...UNCHANGED: <aside> (ComposeChat) · <Handle which="left"/> ·
        center <section> · <Handle which="right"/> · right <section> ... */}
  </div>

  <TerminalPanel
    collapsed={termCollapsed}
    onToggle={toggleTerm}
    tab={termTab}
    onTabChange={setTermTab}
  />
  <StatusBar
    runId={pipelineRunId ?? selectedId ?? null}
    pipeline={pipelineRunId ? pipeStatusByRun[pipelineRunId] : pipeStatus}
    running={!!pipelineRunId}
    tiers={llmTiers}                 /* see A6 — plain strings only */
    problemCount={problemCount}
    onProblemsClick={() => { setTermTab('problems'); if (termCollapsed) toggleTerm() }}
    startedAt={pipeStartedAt}
  />
</main>
```

Note: `pipeStatus` / `pipeStatusByRun` / `pipelineRunId` / `selectedId` are the
page's existing names. The blank-slate early return (`if (!selectedRun) { ... }`)
can optionally get the same two components appended the same way (wrap its
`<aside>` + placeholder `<div>` in a `flex min-h-0 flex-1` row and make its
`<main>` `flex-col`); logs from a first build then show even before a run exists.

### A5. Pipeline transition logging + elapsed clock — 2 lines in `runPipeline`

Inside `const runPipeline = async (runIdArg?: string) => { ... }`:

1. Start the clock right after `setPipelineRunId(runId)`:

```tsx
setPipeStartedAt(Date.now())
```

and clear it in the existing `finally`:

```tsx
finally { setPipelineRunId(null); setPipeStartedAt(null); pipeAbort.current = null }
```

2. Log every stage transition — the existing `onStage` callback is the single
funnel. Change the arrow body from the bare `setPipeStatusByRun(...)` to:

```tsx
onStage: (e) => {
  logLine({
    source: 'pipeline',
    level: e.status === 'failed' ? 'error' : e.status === 'blocked' ? 'warn'
      : e.status === 'passed' ? 'ok' : 'info',
    text: `${e.stage} → ${e.status}${e.detail ? ` — ${e.detail}` : ''}`,
    runId,
  })
  setPipeStatusByRun((prev) => ({
    ...prev,
    [runId]: { ...prev[runId], [e.stage]: { status: e.status, detail: e.detail } },
  }))
},
```

(`e` is a `StageEvent` from `lib/run-pipeline` — fields `stage`, `status`,
`detail`; `runId` is already in scope.)

### A6. Tiers (plain strings — never import server code)

The client's model choice lives in `components/llm-settings.tsx` localStorage
(`fl-llm-provider`, shown via `LLM_PROVIDERS`). A minimal honest value:

```tsx
import { LLM_PROVIDERS } from '@/components/llm-settings'
// inside the component (client-only read, matches llmHeaders' storage):
const [llmTiers, setLlmTiers] = useState<string[]>([])
useEffect(() => {
  const id = localStorage.getItem('fl-llm-provider') ?? ''
  setLlmTiers([LLM_PROVIDERS.find((p) => p.id === id)?.label ?? 'Platform default'])
}, [])
```

Pass `tiers={llmTiers}`. If/when the server reports per-call tiers, replace the
strings — the prop stays `string[]`.

---

## B. `components/compose-chat.tsx` — log the board-build SSE stream

Import at the top:

```tsx
import { logLine } from '@/lib/terminal-log'
```

There are TWO EventSource handlers with the identical shape — `buildBoard`
(fresh build) and `startRev` (revision). In EACH `es.onmessage`, the branch

```tsx
else if (ev.type === 'log' && ev.stage && ev.text)
  setLogs((l) => [...l.slice(-60), { stage: ev.stage!, text: ev.text!, level: ev.level }])
```

becomes (3 added lines):

```tsx
else if (ev.type === 'log' && ev.stage && ev.text) {
  logLine({ source: 'build', level: ev.level === 'err' ? 'error' : 'info',
    text: `${ev.stage}: ${ev.text}`, runId: id })
  setLogs((l) => [...l.slice(-60), { stage: ev.stage!, text: ev.text!, level: ev.level }])
}
```

Notes:
- `id` is the local `run-${crypto.randomUUID()}` in both functions.
- The SSE `level` is `'err'` for errors (see the existing render:
  `l.level === 'err' ? 'text-destructive' : ...`) — map it to `'error'`.
- Optional extras (nice, not required): in the same handlers' `ev.type ===
  'error'` branch add `logLine({ source: 'build', level: 'error', text:
  ev.text ?? 'pipeline error', runId: id })`, and in `es.onerror` add
  `logLine({ source: 'system', level: 'error', text: 'build stream connection
  lost', runId: id })`.

---

## C. Suggested persistence keys (recap)

| Key                | Meaning                        | Values          |
|--------------------|--------------------------------|-----------------|
| `c2-termCollapsed` | bottom panel collapsed state   | `'1'` collapsed (default) · `'0'` open |

(Height is intentionally not persisted — the drag edge resets to 220px per
mount; add `c2-termH` the same way as `c2-leftW` if wanted later.)

---

## D. Sanity checklist after wiring

1. `npx tsc --noEmit` clean.
2. Fresh page: status bar shows `no run`, problems `0`, panel collapsed to 28px.
3. Start a build: `build`-chipped lines stream into TERMINAL; scrolling up
   pauses follow, the `resume` pill returns to the tail.
4. Pipeline auto-start: `pipeline`-chipped transitions appear (`electronics →
   running`, `… → passed — chip-scale board …`); status bar shows the run id,
   running counter `n/7`, and the elapsed clock ticking.
5. A failed/blocked stage appears in PROBLEMS with the count badge; clicking
   the status-bar problems badge opens the panel on the PROBLEMS tab.
