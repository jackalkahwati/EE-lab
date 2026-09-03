import type { Metadata } from "next";
import Link from "next/link";
import { CopyForAi } from "./CopyForAi";

const COMPOSE_URL =
  process.env.NEXT_PUBLIC_COMPOSE_URL ?? "https://app.firstlight.build";

export const metadata: Metadata = {
  title: "FirstLight Developers | API, CLI and MCP",
  description:
    "Drive the FirstLight Compose pipeline programmatically. REST API for builds and artifacts, a CLI for CI, and an MCP server so any AI agent can design real hardware.",
  openGraph: {
    title: "FirstLight Developers | API, CLI and MCP",
    description:
      "A prompt goes in over REST. A routed, DRC-gated PCBA, a real CAD enclosure, simulations, firmware, and manufacturing docs come out. Drive it from CI or hand it to an AI agent as MCP tools.",
    images: [
      {
        url: "/media/fl1-front.png",
        width: 1402,
        height: 1122,
        alt: "FirstLight FL-1 autonomous PCB bring-up station",
      },
    ],
  },
};

export default function Developers() {
  return (
    <main id="main-content">
      {/* Nav */}
      <nav className="nav" aria-label="Primary navigation">
        <div className="container nav-inner">
          <Link href="/" className="wordmark">
            <Starburst /> Firstlight
          </Link>
          <div className="nav-center">
            <Link href="/#how">How it works</Link>
            <Link href="/#iterate">Iterate</Link>
            <Link href="/#pricing">Pricing</Link>
            <Link href="/fl1">FL-1 machine</Link>
            <Link href="/developers" aria-current="page">
              Developers
            </Link>
          </div>
          <div className="nav-actions">
            <a href={COMPOSE_URL} className="nav-signin">
              Sign in
            </a>
            <a href={COMPOSE_URL} className="btn btn-small">
              Start free trial
            </a>
          </div>
        </div>
      </nav>

      <header className="hero hero-compact">
        <div className="container">
          <div className="hero-copy">
            <p className="kicker">Developers · API · CLI · MCP</p>
            <h1>
              The whole pipeline, <span className="accent">programmable.</span>
            </h1>
            <p className="hero-value">
              Gate hardware in CI the way you gate code. Build board design into
              your own tool. Or give an AI agent the ability to design real,
              manufacturable hardware,{" "}
              <span className="accent">not just describe it.</span>
            </p>
            <p className="sub">
              Everything Compose does in the browser is available over a REST
              API. A prompt goes in. A routed, DRC gated PCBA, a real CAD
              enclosure, simulations, firmware and manufacturing docs come out.
              Drive it from CI with the CLI, or hand it to an AI agent as MCP
              tools.
            </p>
            <div className="hero-cta">
              <CopyForAi />
              <span className="hero-cta-note">
                Paste the whole reference into Claude, Cursor or ChatGPT so it
                can build with FirstLight for you.
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Quickstart */}
      <section className="section section-dark" id="quickstart">
        <div className="container doc">
          <h2>Quickstart</h2>
          <p>
            Mint an API key in Compose under Integrations. Keys start read
            only. Creating builds needs the read_write scope. Then
          </p>
          <CodeBlock title="terminal">{`export FIRSTLIGHT_API_KEY=flk_live_...

curl -X POST https://app.firstlight.build/api/v1/boards \\
  -H "Authorization: Bearer $FIRSTLIGHT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt": "USB-C powered desk presence puck with a 60GHz radar module and an LED status ring"}'

# 202 { "runId": "run-…", "status": "queued", "statusUrl": "/api/v1/runs/run-…" }`}</CodeBlock>
          <p>
            A full build takes about seven minutes and runs the same gates as
            the app. Electronics passes only when the board routes clean with
            zero DRC errors, the enclosure carries a real fit check, and every
            simulation is labeled with its fidelity and the tool that produced
            it. Builds are queued and run one at a time.
          </p>
        </div>
      </section>

      {/* API reference */}
      <section className="section" id="api">
        <div className="container doc">
          <h2>REST API</h2>
          <p>
            All endpoints authenticate with{" "}
            <code>Authorization&#58; Bearer flk_live_…</code> and live under{" "}
            <code>/api/v1</code>.
          </p>
          <div className="doc-endpoints">
            <Endpoint verb="POST" path="/api/v1/boards">
              Start a build from a prompt (read_write scope). Returns 202 with
              a runId immediately. The run is owned by the key&apos;s creator
              and private to that account. Pass{" "}
              <code>rebuildRunId</code> instead of a prompt to re-verify an
              existing run. Stages whose inputs are provably unchanged skip as
              current, so a rebuild only pays for what changed.
            </Endpoint>
            <Endpoint verb="GET" path="/api/v1/runs/&lt;runId&gt;">
              Build status. Per stage progress across electronics, mechanical,
              simulation, firmware, manufacturing, supply chain and validation,
              plus the honest electronics verdict and wall clock timing.
            </Endpoint>
            <Endpoint verb="GET" path="/api/v1/runs/&lt;runId&gt;/artifacts">
              Inventory of what the run actually produced. Only files that
              exist on disk are listed. Nothing is promised that was not built.
            </Endpoint>
            <Endpoint verb="GET" path="/api/v1/runs/&lt;runId&gt;/artifacts/&lt;kind&gt;">
              Download one artifact. Kinds include <code>step</code>,{" "}
              <code>glb</code>, <code>schematic</code>, <code>layout</code>,{" "}
              <code>pcb</code>, <code>bom</code>, <code>fab-package</code>,{" "}
              <code>firmware</code>, <code>simulation</code> and the discipline
              reports.
            </Endpoint>
            <Endpoint verb="GET" path="/api/v1/boards">
              The enterprise board portfolio visible to this key.
            </Endpoint>
          </div>
          <CodeBlock title="poll until complete">{`curl -s https://app.firstlight.build/api/v1/runs/$RUN_ID \\
  -H "Authorization: Bearer $FIRSTLIGHT_API_KEY"

# { "status": "running",
#   "stages": { "electronics": { "status": "passed",
#                "detail": "chip-scale board 29×29mm · routed clean, 0 DRC errors" }, … } }`}</CodeBlock>
        </div>
      </section>

      {/* Limits, status codes & artifacts */}
      <section className="section section-dark" id="limits">
        <div className="container doc">
          <h2>Limits</h2>
          <ul className="doc-list">
            <li>
              <strong>Prompt length</strong> — 8 to 2000 characters. Outside that
              range returns <code>400</code>. (A rebuild carries no prompt.)
            </li>
            <li>
              <strong>Build queue</strong> — up to five builds may be pending per
              instance. A sixth returns <code>429</code>; retry once one drains.
            </li>
            <li>
              <strong>Serialized</strong> — builds run one at a time.{" "}
              <code>POST /boards</code> returns your <code>queuePosition</code>{" "}
              immediately, then the pipeline runs in the background.
            </li>
            <li>
              <strong>Build time</strong> — a full run takes about seven minutes.
              Poll <code>statusUrl</code>; do not hold the connection open.
            </li>
            <li>
              <strong>Credits</strong> — each build spends a platform run-credit.
              Plan credits reset monthly (use-or-lose); purchased credits roll
              over. Frontier-model builds are plan-gated — see <code>402</code>.
            </li>
            <li>
              <strong>Key scope</strong> — <code>read</code> can poll and
              download; <code>read_write</code> is required to create or import.
            </li>
          </ul>

          <h2 style={{ marginTop: "2.75rem" }}>Status codes</h2>
          <ul className="doc-list">
            <li><code>202</code> — build accepted and queued.</li>
            <li><code>400</code> — bad input (prompt length, wrong file types).</li>
            <li>
              <code>401</code> — missing, invalid, or revoked key (creating needs{" "}
              <code>read_write</code>).
            </li>
            <li>
              <code>402</code> — plan gate: your plan or credits do not allow the
              requested model. Upgrade, or bring your own LLM key.
            </li>
            <li><code>403</code> — the run is not owned by your key.</li>
            <li><code>404</code> — unknown run.</li>
            <li><code>429</code> — build queue full (five pending). Retry later.</li>
          </ul>

          <h2 style={{ marginTop: "2.75rem" }}>Artifact kinds</h2>
          <p>
            Every kind you can pass to <code>/artifacts/&lt;kind&gt;</code>. Only
            kinds the run actually produced appear in its inventory.
          </p>
          <ul className="doc-list">
            <li><code>spec</code> — resolved product spec (JSON)</li>
            <li><code>board</code> — placements, nets, board stats (JSON)</li>
            <li><code>schematic</code> — schematic (SVG)</li>
            <li><code>layout</code> — layout (SVG)</li>
            <li><code>pcb</code> — KiCad <code>.kicad_pcb</code></li>
            <li><code>fab-package</code> — Gerbers, drill, BOM, CPL (zip)</li>
            <li><code>bom</code> — bill of materials (CSV)</li>
            <li><code>step</code> — enclosure (STEP)</li>
            <li><code>glb</code> — enclosure (GLB)</li>
            <li><code>mechanical</code> — mechanical fit report (JSON)</li>
            <li><code>firmware</code> — firmware (zip)</li>
            <li><code>simulation</code> — simulation report</li>
            <li><code>manufacturing</code> — manufacturing report</li>
            <li><code>supply-chain</code> — sourcing report</li>
            <li><code>validation</code> — validation report</li>
            <li><code>id-brief</code> — industrial-design brief</li>
            <li><code>concept-render</code> — concept render (JPG)</li>
            <li><code>timing</code> — per-stage timing (JSON)</li>
          </ul>
        </div>
      </section>

      {/* CLI */}
      <section className="section" id="cli">
        <div className="container doc">
          <h2>CLI</h2>
          <p>
            The CLI ships in the repository under{" "}
            <code>software/firstlight-cli</code> (it is not yet published to
            npm). Clone the repo and run it directly with Node 18+, or install
            it globally from your checkout. Set <code>FIRSTLIGHT_API_KEY</code>;
            for self-hosted instances also set <code>FIRSTLIGHT_URL</code>{" "}
            (default <code>https://app.firstlight.build</code>).
          </p>
          <CodeBlock title="install">{`export FIRSTLIGHT_API_KEY=flk_live_...

# run straight from a checkout
node /path/to/EE-lab/software/firstlight-cli/bin/cli.mjs build "..." --wait

# or install the firstlight / firstlight-mcp binaries globally from the checkout
npm i -g ./software/firstlight-cli`}</CodeBlock>
          <p>
            The <code>firstlight</code> CLI wraps the API for terminals and CI.{" "}
            <code>build --wait</code> exits 0 only when every stage finishes
            green, so a pipeline job can gate on it directly.
          </p>
          <CodeBlock title="terminal">{`firstlight build "USB-C ambient air quality tile with an SGP40 VOC sensor" --wait
#   run run-… queued (position 0)
#   running (pipeline)  ✓ electronics  … mechanical  … firmware …
#   complete  ✓ electronics ✓ mechanical ✓ simulation ✓ firmware ✓ manufacturing ✓ supplyChain ✓ validation

firstlight artifacts &lt;runId&gt;
firstlight get &lt;runId&gt; step -o enclosure.step
firstlight get &lt;runId&gt; fab-package -o fab.zip
firstlight status &lt;runId&gt; --watch
firstlight boards`}</CodeBlock>
          <p>
            Add <code>--json</code> to any command for machine output. Set{" "}
            <code>FIRSTLIGHT_API_KEY</code> and, for self hosted instances,{" "}
            <code>FIRSTLIGHT_URL</code>.
          </p>
        </div>
      </section>

      {/* MCP */}
      <section className="section" id="mcp">
        <div className="container doc">
          <h2>MCP for AI agents</h2>
          <p>
            <code>firstlight-mcp</code> exposes the pipeline as Model Context
            Protocol tools, so Claude Code, Cursor or any MCP client can design
            and fetch real hardware in a conversation.
          </p>
          <CodeBlock title="Claude Code">{`claude mcp add firstlight \\
  -e FIRSTLIGHT_API_KEY=flk_live_... \\
  -- node /path/to/EE-lab/software/firstlight-cli/bin/mcp.mjs`}</CodeBlock>
          <p>Six tools, mapped one to one onto the API</p>
          <ul className="doc-list">
            <li>
              <code>create_board</code> starts a build from a prompt and
              returns the runId
            </li>
            <li>
              <code>import_design</code> seeds a product from an existing{" "}
              <code>.kicad_pcb</code> and/or <code>.step</code> on disk instead
              of a prompt
            </li>
            <li>
              <code>board_status</code> reports stage progress and the honest
              electronics verdict
            </li>
            <li>
              <code>list_artifacts</code> lists what the run actually produced
            </li>
            <li>
              <code>get_artifact</code> downloads a file locally, or returns
              small JSON and SVG artifacts inline
            </li>
            <li>
              <code>list_boards</code> lists the board portfolio
            </li>
          </ul>
        </div>
      </section>

      {/* Honesty */}
      <section className="section section-dark" id="honesty">
        <div className="container doc">
          <h2>The honesty contract</h2>
          <p>
            The API is the same pipeline as the app, with the same gates. A
            board passes only when it routes clean with zero DRC errors from a
            real KiCad check. The enclosure fit check compares the actual PCB
            against the actual cavity. Simulations state their fidelity and
            solver on every result, and metrics that cannot be computed are
            reported as gated, never invented. Artifact listings contain only
            files that exist.
          </p>
          <p className="statement">
            If the machine could not verify it, the API will not claim it.
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="footer">
        <div className="container footer-inner">
          <span className="wordmark small">
            <Starburst /> Firstlight
          </span>
          <span className="footer-tag">Every board&apos;s first light.</span>
          <span className="footer-links">
            <a href={COMPOSE_URL}>Sign in</a>
            <Link href="/terms">Terms of Use</Link>
            <Link href="/privacy">Privacy Policy</Link>
          </span>
          <span className="footer-copy">
            &copy; {new Date().getFullYear()} StarDrive Inc. All rights
            reserved.
          </span>
        </div>
      </footer>
    </main>
  );
}

function CodeBlock({
  title,
  children,
}: {
  title: string;
  children: string;
}) {
  return (
    <figure className="window doc-window">
      <div className="window-bar">
        <span className="window-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="window-title">{title}</span>
        <span className="window-dots window-dots-ghost" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
      <pre className="doc-code">
        <code>{children}</code>
      </pre>
    </figure>
  );
}

function Endpoint({
  verb,
  path,
  children,
}: {
  verb: string;
  path: string;
  children: React.ReactNode;
}) {
  return (
    <div className="doc-endpoint">
      <div className="doc-endpoint-sig">
        <span className={`doc-verb doc-verb-${verb.toLowerCase()}`}>{verb}</span>
        <code>{path}</code>
      </div>
      <p>{children}</p>
    </div>
  );
}

function Starburst() {
  return (
    <svg viewBox="0 0 32 32" className="starburst" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
        <line x1="16" y1="4" x2="16" y2="12" />
        <line x1="16" y1="20" x2="16" y2="28" />
        <line x1="4" y1="16" x2="12" y2="16" />
        <line x1="20" y1="16" x2="28" y2="16" />
        <line x1="7.5" y1="7.5" x2="12.2" y2="12.2" />
        <line x1="19.8" y1="19.8" x2="24.5" y2="24.5" />
        <line x1="24.5" y1="7.5" x2="19.8" y2="12.2" />
        <line x1="7.5" y1="24.5" x2="12.2" y2="19.8" />
      </g>
    </svg>
  );
}
