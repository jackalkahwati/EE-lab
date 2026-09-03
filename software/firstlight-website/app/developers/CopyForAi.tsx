"use client";

import { useState } from "react";

/**
 * The full FirstLight API reference as clean, self-contained markdown — sized to
 * paste straight into an AI tool (Claude, Cursor, ChatGPT) so it can drive the
 * pipeline. Kept in sync by hand with the sections on this page.
 */
const DOC_MD = `# FirstLight Compose API — how to use it

FirstLight turns a natural-language product prompt into real, manufacturable hardware: a routed, DRC-gated PCBA (KiCad), a CAD enclosure, simulations, firmware, and manufacturing docs. Everything the Compose app does in the browser is available over a REST API, a CLI, and an MCP server.

Base URL: https://app.firstlight.build
Auth: every request needs the header  Authorization: Bearer flk_live_...
Mint a key in Compose -> Integrations. Keys start read-only; creating builds needs the read_write scope. Each run is owned by and private to the key's creator.

## Flow: prompt -> poll -> download
1. Create a build:
   POST /api/v1/boards   body { "prompt": "..." }
   -> 202 { "runId": "run-...", "status": "queued", "queuePosition": 0, "statusUrl": "...", "artifactsUrl": "..." }
2. Poll status (a full build takes ~7 minutes; do not hold the connection open):
   GET /api/v1/runs/{runId}
   -> { "runId", "status": "queued|running|complete|failed", "stages": { "electronics": {...}, ... } }
3. When status is "complete", list and download artifacts:
   GET /api/v1/runs/{runId}/artifacts
   GET /api/v1/runs/{runId}/artifacts/{kind}   e.g. fab-package, pcb, step, bom

## Endpoints
- POST /api/v1/boards            (read_write) Start a build from { "prompt": "..." }, or re-verify an existing run with { "rebuildRunId": "run-..." }. Unchanged stages skip. Returns 202 + runId.
- POST /api/v1/imports           (read_write) Import an existing design: multipart/form-data with a .kicad_pcb (PCBA) and/or a .step (CAD assembly).
- GET  /api/v1/runs/{runId}                    Build status + per-stage progress + the honest electronics verdict.
- GET  /api/v1/runs/{runId}/artifacts          Inventory of artifacts that actually exist for the run.
- GET  /api/v1/runs/{runId}/artifacts/{kind}   Download one artifact (raw file, correct content type).
- GET  /api/v1/boards                          The board portfolio visible to this key.

## Artifact kinds
spec, board, schematic, layout, pcb, fab-package, bom, step, glb, mechanical, firmware, simulation, manufacturing, supply-chain, validation, id-brief, concept-render, timing.

## Limits
- Prompt length: 8 to 2000 characters (a rebuild carries no prompt).
- Build queue: up to 5 builds pending per instance; a 6th returns 429. Builds run one at a time (serialized) — queuePosition is returned on create.
- A full build takes about 7 minutes.
- Each build spends a platform run-credit; plan credits reset monthly, purchased credits roll over. Frontier-model builds are plan-gated.
- Key scope: read can poll + download; read_write is required to create or import.

## Status codes
202 accepted/queued · 400 bad input (prompt length, file types) · 401 missing/invalid/revoked key (create needs read_write) · 402 plan gate (model/credits not allowed; upgrade or BYOK) · 403 run not owned by your key · 404 unknown run · 429 build queue full (5 pending).

## CLI
The CLI lives in the repo at software/firstlight-cli (not yet published to npm). Run it from a checkout with Node 18+:
  node /path/to/EE-lab/software/firstlight-cli/bin/cli.mjs <command>
or install the firstlight / firstlight-mcp binaries globally from the checkout:
  npm i -g ./software/firstlight-cli
export FIRSTLIGHT_API_KEY=flk_live_...
firstlight build "USB-C ambient air quality tile with an SGP40 VOC sensor" --wait   # exits 0 only when every stage passes — gate CI on it
firstlight status <runId> --watch
firstlight artifacts <runId>
firstlight get <runId> step -o enclosure.step
firstlight get <runId> fab-package -o fab.zip
firstlight boards
# Add --json to any command for machine output. Set FIRSTLIGHT_URL for self-hosted instances.

## MCP (for AI agents like Claude Code, Cursor)
claude mcp add firstlight -e FIRSTLIGHT_API_KEY=flk_live_... -- node /path/to/EE-lab/software/firstlight-cli/bin/mcp.mjs
Six tools, mapped one-to-one onto the API:
- create_board   start a build from a prompt, returns the runId
- import_design  seed a product from an existing .kicad_pcb and/or .step on disk instead of a prompt
- board_status   stage progress + the honest electronics verdict
- list_artifacts what the run actually produced
- get_artifact   download a file locally (or return small JSON/SVG inline)
- list_boards    the board portfolio

## The honesty contract
The API is the same pipeline as the app, with the same gates. A board passes only when it routes clean with zero DRC errors from a real KiCad check. The enclosure fit check compares the actual PCB against the actual cavity. Simulations state their fidelity and solver on every result; metrics that cannot be computed are reported as gated, never invented. Artifact listings contain only files that exist. If the machine could not verify it, the API will not claim it.
`;

export function CopyForAi() {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(DOC_MD);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // clipboard blocked (insecure context / permissions) — select-fallback
      const ta = document.createElement("textarea");
      ta.value = DOC_MD;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 2200);
      } catch {
        /* give up silently */
      }
      ta.remove();
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="copy-docs-btn"
      aria-label="Copy the full API documentation as markdown for your AI tools"
    >
      <span className="copy-docs-icon" aria-hidden="true">
        {copied ? (
          <svg viewBox="0 0 20 20" width="15" height="15">
            <path
              d="M4 10.5l4 4 8-9"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" width="15" height="15">
            <rect
              x="6.5"
              y="6.5"
              width="9"
              height="10"
              rx="1.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
            />
            <path
              d="M4 13.2V4.2A1.7 1.7 0 015.7 2.5h7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
          </svg>
        )}
      </span>
      {copied ? "Copied for your AI" : "Copy docs for AI"}
    </button>
  );
}
