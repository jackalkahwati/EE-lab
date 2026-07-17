# firstlight-cli

FirstLight Compose from the terminal — and from AI agents.

Two binaries, one tiny API client:

- **`firstlight`** — CLI: build a product from a prompt, watch the pipeline, pull artifacts.
- **`firstlight-mcp`** — MCP server (stdio): the same pipeline as tools for Claude Code, Cursor, or any MCP client.

Both talk to the Compose v1 API (`/api/v1/*`), authenticated by an API key minted in Compose → Integrations. Creating builds requires a `read_write` key.

## Setup

```sh
export FIRSTLIGHT_API_KEY=flk_live_…          # Compose → Integrations → API keys
export FIRSTLIGHT_URL=https://app.firstlight.build   # default; omit unless self-hosting
```

## CLI

```sh
firstlight build "USB-C desk presence puck with a 60GHz radar and an LED ring" --wait
firstlight import --step enclosure.step --name "My widget"   # start from an existing design
firstlight import --pcb board.kicad_pcb --step assembly.step  # PCBA + CAD assembly together
firstlight rebuild <runId> --wait      # re-verify: unchanged stages skip as current
firstlight status <runId> --watch
firstlight artifacts <runId>
firstlight get <runId> fab-package -o fab.zip
firstlight get <runId> step -o enclosure.step
firstlight boards
```

`--json` on any command for machine output. `build --wait` exits 0 only when the
run completes with every gate green (DRC-clean electronics, fit-checked
enclosure) — wire it straight into CI.

## MCP (Claude Code)

```sh
claude mcp add firstlight -e FIRSTLIGHT_API_KEY=flk_live_… -- node /path/to/firstlight-cli/bin/mcp.mjs
```

Tools: `create_board`, `import_design`, `board_status`, `list_artifacts`, `get_artifact`, `list_boards`.
`import_design` seeds a product from an existing `.kicad_pcb` and/or `.step` on disk instead of a prompt.

A build takes ~7 minutes; `create_board` returns a `runId` immediately and the
agent polls `board_status`. Artifact kinds include `fab-package` (gerbers +
assembly zip), `step`, `glb`, `schematic`, `layout`, `bom`, `simulation`,
`firmware`, and the discipline reports.

## Honesty contract

The API is the same pipeline as the Compose UI with the same gates: electronics
passes only routed-clean with zero DRC errors, the enclosure fit check is real,
simulations carry their fidelity + tool labels, and artifacts listed are only
files that actually exist on disk.
