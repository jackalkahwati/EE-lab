import type { Metadata } from "next";
import Link from "next/link";

const COMPOSE_URL =
  process.env.NEXT_PUBLIC_COMPOSE_URL ?? "https://app.firstlight.build";

export const metadata: Metadata = {
  title: "FirstLight Developers | API, CLI and MCP",
  description:
    "Drive the FirstLight Compose pipeline programmatically. REST API for builds and artifacts, a CLI for CI, and an MCP server so any AI agent can design real hardware.",
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
              Start free
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
            <p className="sub">
              Everything Compose does in the browser is available over a REST
              API. A prompt goes in. A routed, DRC gated PCBA, a real CAD
              enclosure, simulations, firmware and manufacturing docs come out.
              Drive it from CI with the CLI, or hand it to an AI agent as MCP
              tools.
            </p>
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
              and private to that account.
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

      {/* CLI */}
      <section className="section section-dark" id="cli">
        <div className="container doc">
          <h2>CLI</h2>
          <p>
            The <code>firstlight</code> CLI wraps the API for terminals and CI.{" "}
            <code>build --wait</code> exits 0 only when every stage finishes
            green, so a pipeline job can gate on it directly.
          </p>
          <CodeBlock title="terminal">{`firstlight build "USB-C ambient air quality tile with an SGP40 VOC sensor" --wait
#   run run-… queued (position 0)
#   running (pipeline)  ✓ electronics  … mechanical  … firmware …
#   complete  ✓ electronics ✓ mechanical ✓ simulation ✓ firmware ✓ manufacturing ✓ supplyChain ✓ validation

firstlight artifacts <runId>
firstlight get <runId> step -o enclosure.step
firstlight get <runId> fab-package -o fab.zip
firstlight status <runId> --watch
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
  -- npx firstlight-mcp`}</CodeBlock>
          <p>Five tools, mapped one to one onto the API</p>
          <ul className="doc-list">
            <li>
              <code>create_board</code> starts a build from a prompt and
              returns the runId
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
        <code dangerouslySetInnerHTML={{ __html: path }} />
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
