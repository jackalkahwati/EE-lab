# EE-lab

FirstLight: a prompt-to-hardware pipeline (routed, DRC-gated PCBAs plus CAD enclosures, simulation, firmware, and fab packages) and the autonomous bring-up station that tests the boards it produces. This repo holds the planner, the web app, the CLI/MCP client, the marketing site, the station control software, and the hardware/CAD sources.

## Subprojects

| Path | What it is | Run the tests |
|------|------------|---------------|
| `hardware/planner/` | Python planner: spec resolution, part library, netlist synthesis, routing, sim, KiCad export | `pip install -r hardware/planner/requirements.txt && python -m pytest -q hardware/planner` |
| `software/prompt-to-pcb-ui/` | Next.js "Compose" app (the product at app.firstlight.build) and the `/api/v1` API | `cd software/prompt-to-pcb-ui && pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test` |
| `software/firstlight-cli/` | `firstlight` CLI and `firstlight-mcp` MCP server over the v1 API | `cd software/firstlight-cli && npm test` |
| `software/firstlight-website/` | Marketing site (firstlight.build) | `cd software/firstlight-website && npm ci && npm run lint && npm run typecheck` |
| `software/station/` | Bring-up station control software (HAL, engine, API) | `pip install -e "software/station[dev]" && python -m pytest -q software/station` |

`.github/workflows/ci.yml` runs the same commands on every push and pull request.

## Production

Compose runs on a single Mac via launchd behind a Cloudflare tunnel. The runbook, including how to ship new code and which env vars matter, is `software/prompt-to-pcb-ui/deploy/OPS.md`. The `deploy/` READMEs describe future container/VM targets, not what is serving today.

## Review

The audit of the prompt-to-PCB stack and the fixes it drove is in [`docs/prompt-to-pcb-review.md`](docs/prompt-to-pcb-review.md).
