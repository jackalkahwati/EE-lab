import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'API Reference — FirstLight',
  description: 'Programmatic prompt-to-product: build boards, poll runs, and download real artifacts over the FirstLight v1 API.',
}

/** Small building blocks kept local so this page is self-contained. */
function Endpoint({ method, path, scope, children }: { method: string; path: string; scope?: string; children: React.ReactNode }) {
  const color = method === 'GET' ? 'text-emerald-500' : 'text-sky-500'
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-4">
      <div className="flex flex-wrap items-center gap-2 font-mono text-sm">
        <span className={`font-semibold ${color}`}>{method}</span>
        <span className="text-foreground">{path}</span>
        {scope && <span className="ml-auto rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{scope}</span>}
      </div>
      <div className="mt-3 text-sm text-muted-foreground [&_code]:rounded [&_code]:bg-secondary [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_code]:text-foreground">
        {children}
      </div>
    </div>
  )
}
function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-border bg-[#0f0f0f] p-4 text-[12.5px] leading-relaxed text-zinc-200">
      <code>{children}</code>
    </pre>
  )
}

export default function ApiDocsPage() {
  const KINDS = [
    ['spec', 'product-spec.json — the resolved product spec'],
    ['board', 'board.json — placements, nets, board stats'],
    ['schematic', 'schematic SVG'],
    ['layout', 'layout SVG'],
    ['pcb', 'KiCad .kicad_pcb'],
    ['fab-package', 'PCBA fabrication package (zip: Gerbers, drill, BOM, CPL)'],
    ['bom', 'bom.csv'],
    ['step', 'mechanical enclosure STEP'],
    ['glb', 'mechanical enclosure GLB'],
    ['mechanical', 'mechanical.json'],
    ['firmware', 'firmware.zip'],
    ['simulation', 'simulation discipline report'],
    ['manufacturing', 'manufacturing discipline report'],
    ['supply-chain', 'supply-chain discipline report'],
    ['validation', 'validation discipline report'],
    ['id-brief', 'industrial-design brief'],
    ['concept-render', 'concept render JPG'],
    ['timing', 'per-stage timing.json'],
  ]
  return (
    <main className="mx-auto max-w-3xl px-6 py-14">
      <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Developers</p>
      <h1 className="mt-2 text-3xl font-semibold text-foreground">API Reference</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
        The FirstLight <span className="font-mono">v1</span> API drives the same pipeline as Compose — prompt in,
        real engineering artifacts out (routed PCB, Gerbers, BOM, CAD, firmware). Everything is a
        run: create one, poll it, download its artifacts.
      </p>

      {/* Auth */}
      <h2 className="mt-10 text-xl font-semibold text-foreground">Authentication</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        All requests authenticate with an API key in the <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[12px] text-foreground">Authorization</code> header.
        Mint keys in the <a href="/enterprise/integrations" className="text-sky-500 underline underline-offset-2">Integrations console</a>.
        Keys are shown once. Every run is owned by and billed to the key&apos;s creator.
      </p>
      <div className="mt-3"><Code>{`Authorization: Bearer flk_live_xxxxxxxxxxxxxxxxxxxxxxxx`}</Code></div>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li><span className="font-mono text-foreground">read</span> — poll runs and download artifacts.</li>
        <li><span className="font-mono text-foreground">read_write</span> — additionally create boards and imports.</li>
      </ul>

      {/* Quick start */}
      <h2 className="mt-10 text-xl font-semibold text-foreground">Quick start</h2>
      <p className="mt-2 text-sm text-muted-foreground">Create a board, poll until it finishes (~7&nbsp;min), then download the fab package.</p>
      <div className="mt-3"><Code>{`# 1. create
curl -s https://app.firstlight.build/api/v1/boards \\
  -H "Authorization: Bearer $FL_KEY" -H "content-type: application/json" \\
  -d '{"prompt":"USB-C powered RP2040 dev board with an IMU and a Qwiic connector"}'
# -> {"runId":"run-...","status":"queued","statusUrl":"/api/v1/runs/run-...","artifactsUrl":"..."}

# 2. poll
curl -s https://app.firstlight.build/api/v1/runs/run-... \\
  -H "Authorization: Bearer $FL_KEY"
# -> {"runId":"run-...","status":"running"|"complete"|"failed","stages":{...}}

# 3. download artifacts once complete
curl -s https://app.firstlight.build/api/v1/runs/run-.../artifacts \\
  -H "Authorization: Bearer $FL_KEY"
curl -sL https://app.firstlight.build/api/v1/runs/run-.../artifacts/fab-package \\
  -H "Authorization: Bearer $FL_KEY" -o board.zip`}</Code></div>

      {/* Endpoints */}
      <h2 className="mt-10 text-xl font-semibold text-foreground">Endpoints</h2>
      <div className="mt-4 space-y-4">
        <Endpoint method="POST" path="/api/v1/boards" scope="read_write">
          Build a product from a prompt. Body: <code>{`{ "prompt": "…" }`}</code> (8–2000 chars),
          or <code>{`{ "rebuildRunId": "run-…" }`}</code> to re-run an existing board.
          Returns <code>202</code> with <code>{`{ runId, status:"queued", queuePosition, statusUrl, artifactsUrl }`}</code>. A full build takes ~7&nbsp;minutes; poll <code>statusUrl</code>.
        </Endpoint>
        <Endpoint method="POST" path="/api/v1/imports" scope="read_write">
          Import an existing design. <code>multipart/form-data</code> with a <code>.kicad_pcb</code> (PCBA) and/or a <code>.step</code> (CAD assembly).
          Returns <code>{`{ runId, statusUrl, artifactsUrl }`}</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/v1/runs/{runId}" scope="read">
          Run status. Returns <code>{`{ runId, status, stages, board, id }`}</code> where <code>status</code> is
          <code> queued</code> · <code>running</code> · <code>complete</code> · <code>failed</code>, and <code>stages</code> maps each pipeline
          stage (design, electronics, mechanical, disciplines…) to its state and detail.
        </Endpoint>
        <Endpoint method="GET" path="/api/v1/runs/{runId}/artifacts" scope="read">
          Inventory of artifacts that actually exist for the run. Returns
          <code>{`{ runId, count, artifacts:[{ kind, bytes, modifiedAt, mime, url }] }`}</code>. Nothing is listed unless the file is really on disk.
        </Endpoint>
        <Endpoint method="GET" path="/api/v1/runs/{runId}/artifacts/{kind}" scope="read">
          Download one artifact by <code>kind</code> (see the table below). Streams the raw file with its content type.
        </Endpoint>
      </div>

      {/* Artifact kinds */}
      <h2 className="mt-10 text-xl font-semibold text-foreground">Artifact kinds</h2>
      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <tbody>
            {KINDS.map(([k, d]) => (
              <tr key={k} className="border-b border-border last:border-0">
                <td className="whitespace-nowrap px-4 py-2 font-mono text-[12.5px] text-foreground">{k}</td>
                <td className="px-4 py-2 text-muted-foreground">{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Status codes */}
      <h2 className="mt-10 text-xl font-semibold text-foreground">Status &amp; errors</h2>
      <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
        <li><code className="font-mono text-foreground">202</code> — build accepted and queued.</li>
        <li><code className="font-mono text-foreground">400</code> — bad input (prompt length, wrong file types).</li>
        <li><code className="font-mono text-foreground">401</code> — missing, invalid, or revoked API key (creating needs <code>read_write</code>).</li>
        <li><code className="font-mono text-foreground">402</code> — plan gate: your plan/credits don&apos;t allow the requested model. Upgrade, or use your own key (BYOK).</li>
        <li><code className="font-mono text-foreground">403</code> — the run isn&apos;t owned by your key.</li>
        <li><code className="font-mono text-foreground">404</code> — unknown run.</li>
      </ul>

      {/* CLI / MCP */}
      <h2 className="mt-10 text-xl font-semibold text-foreground">CLI &amp; MCP</h2>
      <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-muted-foreground">
        A <span className="font-mono text-foreground">firstlight</span> CLI and an MCP server are <span className="text-foreground">planned but not yet shipped</span>.
        Until then, use the HTTP API above — every capability (build, import, poll, download) is available through it.
        We&apos;ll document the CLI and MCP here when they land.
      </div>

      <p className="mt-10 text-xs text-muted-foreground">
        Base URL <code className="font-mono">https://app.firstlight.build</code>. Questions? <a href="/contact" className="text-sky-500 underline underline-offset-2">Contact us</a>.
      </p>
    </main>
  )
}
