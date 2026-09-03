import Image from "next/image";
import Link from "next/link";
import { TryCompose } from "./try-compose";
import { MfgVignette, SourcingVignette, ValidationVignette, EditLoopVignette } from "./vignettes";

const COMPOSE_URL =
  process.env.NEXT_PUBLIC_COMPOSE_URL || "http://localhost:4500";
const CONTACT = "jack@thestardrive.com";

const PIPELINE = [
  "electronics",
  "industrial design",
  "mechanical",
  "simulation",
  "firmware",
  "manufacturing",
  "sourcing",
  "validation",
];

const OUTPUTS = [
  ["Manufacturable fab package", "Gerbers, drill, pick-and-place, and BOM, routed and gated on real KiCad DRC. A board only goes green when the checks actually pass."],
  ["Enclosure CAD", "A two-shell enclosure generated to match the industrial design, with bosses aligned to the board's mounting holes, fit-checked and exported as real STEP."],
  ["Boards shaped to the product", "A round product gets a circular board with mounting holes on a bolt circle. The PCB follows the enclosure, not the other way around."],
  ["Physics simulation", "Real solves, honestly labeled and run as each design needs them: FEM thermal and modal, 3D FEA in CalculiX, natural-convection CFD in OpenFOAM, cavity acoustics in Elmer, antenna FDTD in openEMS, rail impedance in ngspice. A design that runs hot fails in simulation before anyone tools a mold."],
  ["Firmware", "A compiled firmware image that targets the board that actually shipped, with the peripheral map, power states, and USB reporting."],
  ["Manufacturing, sourcing & test", "An NPI package sized to your volume, a sourcing plan with real parts and lead-time risks called out, and an FL-1 validation test plan with the gaps flagged, never papered over."],
];

const AUDIENCES: [string, string][] = [
  ["Hardware startups", "Reach a manufacturable first product without hiring a full electrical, mechanical, and firmware team on day one. Ship your first board this month, not next quarter, and put your budget into what makes you different."],
  ["Solo & indie builders", "Turn an idea into routed copper, a real enclosure, and a fab package in an afternoon. The disciplines you don't have in-house are covered, and gated on real checks, so what you send to fab is buildable, not a guess."],
  ["Product & engineering teams", "Kill the expensive early spins. Explore ten design directions before lunch, each one validated in simulation, so the version your EE picks up is already close. Defense and space teams get an ITAR-ready deployment."],
];

// Real third-party tools in the pipeline: [slug, name, role, iconW, iconH]
type Tool = [string, string, string, number, number];

// Design, sourcing & manufacturing services the pipeline drives
const TOOLCHAIN: Tool[] = [
  ["onshape", "Onshape", "enclosure CAD", 128, 128],
  ["kicad", "KiCad", "DRC signoff", 128, 128],
  ["freerouting", "freerouting", "autorouting", 128, 128],
  ["tscircuit", "tscircuit", "board build", 128, 128],
  ["atopile", "atopile", "hardware source", 128, 128],
  ["digikey", "DigiKey", "live sourcing", 32, 32],
  ["mouser", "Mouser", "live sourcing", 128, 128],
  ["octopart", "Octopart", "part intelligence", 128, 128],
  ["pcbway", "PCBWay", "fab quotes", 128, 37],
  ["jlcpcb", "JLCPCB", "fab quotes", 48, 48],
  ["macrofab", "MacroFab", "assembly quotes", 128, 128],
];

// Physics solvers behind the gates; the sim-router runs the subset each design needs
const SIM_STACK: Tool[] = [
  ["scipy", "SciPy", "thermal & modal FEM", 64, 64],
  ["gmsh", "gmsh", "FEA meshing", 128, 128],
  ["calculix", "CalculiX", "3D FEA solve", 0, 0],
  ["openfoam", "OpenFOAM", "thermal CFD", 128, 128],
  ["elmer", "Elmer", "acoustic FEM", 128, 128],
  ["openems", "openEMS", "antenna FDTD", 135, 100],
  ["ngspice", "ngspice", "PDN impedance", 128, 128],
];

const FL1_INSTRUMENTS = [
  "Programmable multi-rail power & electronic load",
  "Oscilloscope, logic analyzer & DAQ",
  "6.5-digit digital multimeter",
  "Automated precision probing & Kelvin 4-wire measurement",
  "UART, I²C, SPI, USB, Ethernet, CAN-FD testing",
  "Machine vision & thermal inspection",
];

export default function Home() {
  return (
    <main id="main-content">
      {/* Nav */}
      <nav className="nav" aria-label="Primary navigation">
        <div className="container nav-inner">
          <a href="#top" className="wordmark">
            <Starburst /> Firstlight
          </a>
          <div className="nav-center">
            <a href="#how">How it works</a>
            <a href="#iterate">Iterate</a>
            <a href="#pricing">Pricing</a>
            <Link href="/fl1">FL-1 machine</Link>
            <Link href="/developers">Developers</Link>
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

      {/* Hero, Compose */}
      <header className="hero" id="top">
        <div className="container hero-grid">
          <div className="hero-copy">
            <p className="kicker">FirstLight Compose · AI product engineering</p>
            <h1>
              Design a real product <span className="accent">from a sentence.</span>
            </h1>
            <p className="hero-value">
              The electronics, mechanical, firmware, sourcing, and validation
              work of a small hardware team, the part that normally takes months
              and a five-figure budget, in about seven minutes.{" "}
              <span className="accent">You review what it flags. It does the rest.</span>
            </p>
            <p className="lede">
              Describe what you&apos;re building in plain language. Compose designs
              and routes the board, wraps it in an enclosure that actually fits,
              runs real physics simulation, generates firmware for the board that
              shipped, and hands you the manufacturing, sourcing, and test plans
              to build it. It is proven today on precision measurement and sensor
              boards, an MCU with analog and I&#178;C front ends on rigid FR-4.
            </p>
            <TryCompose />
            <p className="run-caption">
              Start with a free Pro trial on your own model key.{" "}
              <a href={COMPOSE_URL} className="compose-link">
                Open Compose &rarr;
              </a>
            </p>
            <ul className="run-stats hero-stats">
              <li>
                <strong>0</strong> DRC errors, gated and never assumed
              </li>
              <li>
                <strong>8</strong> engineering disciplines, one run
              </li>
              <li>
                <strong>~7 min</strong> prompt to product package
              </li>
            </ul>
          </div>
          <div className="hero-shot">
            <div className="shot-stage">
              <WindowFrame title="FirstLight Compose">
                <Image
                  src="/media/compose-hero.jpg"
                  alt="The Compose workspace, with a circular PCBA rendered in 3D, every pipeline discipline green, live logs streaming in the terminal"
                  width={1600}
                  height={914}
                  sizes="(max-width: 860px) calc(100vw - 48px), 576px"
                  priority
                />
              </WindowFrame>
            </div>
          </div>
        </div>
      </header>

      {/* Toolchain — real third-party integrations */}
      <section className="toolchain" aria-label="Tools and services Compose integrates with">
        <div className="container">
          <p className="kicker">Integrations</p>
          <p className="toolchain-lede">
            Every run drives the same tools professional hardware teams
            already trust.
          </p>
          <ToolStrip tools={TOOLCHAIN} />
          <p className="toolchain-note">
            Enclosure CAD is driven live in Onshape and boards only go green
            on real KiCad DRC. Fab quotes come from PCBWay and JLCPCB&apos;s
            own price APIs; sourcing checks live distributor stock.
          </p>
        </div>
      </section>

      {/* Simulation stack — real solvers behind the physics gates */}
      <section className="toolchain toolchain-follow" aria-label="Simulation solvers Compose runs">
        <div className="container">
          <p className="kicker">Simulation</p>
          <p className="toolchain-lede">
            Six real solvers, plus gmsh meshing, behind the physics gates.
            Compose runs the analyses each design needs, and nothing goes green
            without the solves it calls for.
          </p>
          <ToolStrip tools={SIM_STACK} />
          <p className="toolchain-note">
            When a design calls for them, SciPy runs the thermal and modal FEM;
            gmsh meshes and CalculiX solves the 3D FEA. OpenFOAM runs the
            natural-convection CFD, Elmer the cavity acoustics, openEMS the
            antenna FDTD, and ngspice sweeps the rail decoupling network. Every
            result is labeled with the tool and fidelity that produced it, and a
            gate that fails says so.
          </p>
        </div>
      </section>

      {/* Who it's for */}
      <section className="section" id="who">
        <div className="container">
          <p className="kicker">Who it&apos;s for</p>
          <h2>Built for the people actually shipping hardware.</h2>
          <div className="outputs-grid audiences-grid">
            {AUDIENCES.map(([title, body]) => (
              <div className="output-card" key={title}>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Problem */}
      <section className="section section-dark">
        <div className="container narrow">
          <h2>
            AI can describe a circuit.
            <br />
            Getting to a product you can build is the hard part.
          </h2>
          <p>
            Schematic ideas are cheap. Turning one into routed copper, an
            enclosure that actually fits it, firmware for the board that
            shipped, and the manufacturing, sourcing, and test plans to build
            it still means weeks across five disciplines, or a contract team.
            Compose closes that gap in a single continuous run, and it does it
            honestly. Every stage is gated on real checks, from KiCad DRC to
            geometric fit to finite-element physics, and a gate that fails says
            so instead of shipping a green lie.
          </p>
          <p className="statement">
            Describe it. Compose builds it.
            <span className="accent"> A manufacturable board, its enclosure, firmware, and the plans to ship it.</span>
          </p>
        </div>
      </section>

      {/* How Compose works */}
      <section className="section" id="how">
        <div className="container">
          <p className="kicker kicker-seq">How it works</p>
          <h2>From a prompt to a manufacturable board, in one run.</h2>
          <ol className="pipeline">
            {PIPELINE.map((s, i) => (
              <li key={s} className="pipeline-stage">
                <span className="pipeline-num">{String(i + 1).padStart(2, "0")}</span>
                <span className="pipeline-name">{s}</span>
              </li>
            ))}
          </ol>
          <p className="how-lede">
            A short design interview fills in what matters, like size, volume,
            and connectivity. Then the full pipeline runs in front of you, live
            logs streaming, gated at every stage. The industrial design drives
            the mechanical CAD; the board takes the enclosure&apos;s shape; the
            firmware targets the board that shipped. Nothing goes green unless
            its real checks pass. When physics says a design runs hot,
            you find out before tooling, not after.
          </p>
          <div className="outputs-grid">
            {OUTPUTS.map(([title, body]) => (
              <div className="output-card" key={title}>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            ))}
          </div>
          <p className="statement">
            Design and validation are one system.
            <span className="accent"> Testability is built in before the board is ever fabricated.</span>
          </p>
        </div>
      </section>

      {/* Beyond the board, generated docs */}
      <section className="section" id="docs">
        <div className="container split">
          <div className="split-copy">
            <p className="statement statement-xl">
              It doesn&apos;t stop at the board.
              <span className="accent"> Manufacturing, sourcing, and test plans are generated from the same design. Readable, honest, and flagged where an engineer is still needed.</span>
            </p>
            <a href={COMPOSE_URL} className="arrow-link">
              Open Compose &rarr;
            </a>
          </div>
          <div className="split-media">
            <WindowFrame title="Manufacturing package">
              <MfgVignette />
            </WindowFrame>
          </div>
        </div>
        <div className="container doc-row">
          <WindowFrame title="Sourcing plan">
            <SourcingVignette />
          </WindowFrame>
          <WindowFrame title="FL-1 validation plan">
            <ValidationVignette />
          </WindowFrame>
        </div>
      </section>

      {/* Iterate — the edit loop */}
      <section className="section" id="iterate">
        <div className="container split">
          <div className="split-media">
            <WindowFrame title="Targeted revision">
              <EditLoopVignette />
            </WindowFrame>
          </div>
          <div className="split-copy">
            <p className="statement statement-xl">
              Version one is the start, not the answer.
              <span className="accent"> Describe a change in plain language. Compose routes it, rebuilds only what it touches, and shows you the diff.</span>
            </p>
            <p>
              Every build is a revision of a durable product. Pin the decisions
              you want kept, a part, a dimension, a budget, and every rebuild
              must keep them. Pins are verified against the built design, never
              just trusted.
            </p>
          </div>
        </div>
        <div className="container">
          <div className="iterate-grid">
            <div className="output-card">
              <h3>A work queue, not a report</h3>
              <p>Every honest flag the pipeline raises, a failed simulation, an unspecified part, a fit risk, becomes an actionable item. Click it, answer one question, and the fix routes back through the pipeline.</p>
            </div>
            <div className="output-card">
              <h3>Built for the whole team</h3>
              <p>Share a product read-only with comments anchored to the exact artifact, the fit check, a BOM line, a thermal result. Request approval on a revision and it lands in the enterprise console with evidence attached.</p>
            </div>
            <div className="output-card">
              <h3>Hand edits round-trip</h3>
              <p>Export the STEP or the KiCad board, edit it by hand, and import it back as a revision. Compose strips exactly the claims your edit invalidated, and nothing regenerates over your work.</p>
            </div>
          </div>
          <div className="provenance-strip">
            <div className="provenance-copy">
              <h3>Every revision is sealed.</h3>
              <p>
                Compose records each build as a signed session on the open
                source{" "}
                <a href="https://github.com/jackalkahwati/Checkpoint-Protocol" target="_blank" rel="noreferrer">
                  Checkpoint Protocol
                </a>
                . An Ed25519 signed snapshot chain ties every revision to the
                prompt, the artifacts, and the gate results that produced it,
                and the whole history is verifiable on demand. A seal is
                provenance, not approval. A failed check seals as failed.
              </p>
            </div>
            <code className="provenance-proof">verify-history · all accepted snapshots have valid seals · 0 unsigned</code>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="section" id="pricing">
        <div className="container">
          <p className="kicker">Pricing</p>
          <h2>Pay for outcomes, not tokens.</h2>
          <p className="pricing-note">
            FirstLight compresses years of product development into minutes.
            Bring your own model key, and a plan buys platform runs, priced by
            board size &mdash; so runs are deliberately valuable. Start Pro with a
            free trial; ship on a plan, and license annually for a team.
          </p>
          <div className="pricing-grid">
            <div className="price-card price-card-pro">
              <span className="price-badge">Free trial</span>
              <h3>Pro</h3>
              <p className="price">
                $49<span>/month</span>
              </p>
              <ul>
                <li>Starts with a free trial</li>
                <li>Bring your own model key, every model</li>
                <li>Full exports &mdash; Gerbers, BOM, CAD, firmware</li>
                <li>Priority build queue, revision history</li>
              </ul>
              <a href={COMPOSE_URL} className="btn price-cta">
                Start free trial
              </a>
            </div>
            <div className="price-card">
              <h3>Studio</h3>
              <p className="price">
                $499<span>/month</span>
              </p>
              <ul>
                <li>For teams shipping products regularly</li>
                <li>Team seats &amp; shared workspace</li>
                <li>Highest build priority</li>
                <li>Principal-EE design reviews</li>
              </ul>
              <a
                href={`${COMPOSE_URL}/contact?plan=studio`}
                className="btn btn-ghost price-cta"
              >
                Talk to us
              </a>
            </div>
            <div className="price-card">
              <span className="price-badge">Production</span>
              <h3>Enterprise</h3>
              <p className="price">
                Custom<span>/year</span>
              </p>
              <ul>
                <li>Private / on-prem deployment</li>
                <li>Your designs are never used for training</li>
                <li>SSO, SLA, custom part libraries</li>
                <li>ITAR-ready for defense &amp; space</li>
              </ul>
              <a
                href={`${COMPOSE_URL}/contact?plan=enterprise`}
                className="btn btn-ghost price-cta"
              >
                Contact sales
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* FL-1, coming next, reserve */}
      <section className="section band-dark" id="fl1">
        <div className="container">
          <p className="kicker">Coming next · FirstLight FL-1</p>
          <h2>The machine that brings your board to life.</h2>
          <div className="fl1-grid">
            <div className="fl1-image">
              <Image
                src="/media/fl1-hero-open.png"
                alt="FirstLight FL-1 Desktop with the canopy open, probing a board, the autonomous PCB bring-up and diagnosis station"
                width={1402}
                height={1122}
                sizes="(max-width: 860px) calc(100vw - 48px), 512px"
              />
            </div>
            <div>
              <p>
                Compose designs the board. FL-1 validates the physical one.
                Insert the assembled PCB, press start, and the machine
                autonomously powers it up, probes it, and tells you exactly what
                works and what failed, using the test plan Compose generated.
              </p>
              <ul className="spec-list fl1-specs">
                {FL1_INSTRUMENTS.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
              <p className="fl1-status">
                FL-1 is in engineering validation. Reserve your place in line for
                the first production units.
              </p>
              <p className="fl1-dogfood">
                And FL-1 itself was designed in Compose. We used our own product
                to build the machine that tests hardware.{" "}
                <Link href="/case-study">Read the case study &rarr;</Link>
              </p>
              <div className="fl1-cta-row">
                <Link className="btn" href="/fl1#reserve">
                  Reserve an FL-1
                </Link>
                <Link className="btn btn-ghost" href="/fl1">
                  Learn more
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Demo video */}
      <section className="section" id="demo">
        <div className="container narrow">
          <h2>First board, first light.</h2>
          <p>
            FL-1 in motion, a CAD-rendered concept film from the production
            design model. Canopy, fixture drawer, and an autonomous probing run.
          </p>
          <div className="demo-frame">
            <WindowFrame title="FL-1 concept film">
              <video
                controls
                playsInline
                preload="none"
                poster="/media/web-hero.png"
                className="demo-video"
                aria-label="CAD concept film of the FL-1 performing an autonomous probing run"
              >
                <source src="/media/promo.mp4" type="video/mp4" />
                Your browser does not support embedded video.
              </video>
            </WindowFrame>
          </div>
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
            <Link href="/case-study">Case study</Link>
            <Link href="/developers">Developers</Link>
            <Link href="/terms">Terms of Use</Link>
            <Link href="/privacy">Privacy Policy</Link>
            <a href={`mailto:${CONTACT}`}>Contact</a>
          </span>
          <span className="footer-copy">
            &copy; {new Date().getFullYear()} StarDrive Inc. All rights reserved.
          </span>
        </div>
      </footer>
    </main>
  );
}

function ToolStrip({ tools }: { tools: Tool[] }) {
  return (
    <ul className="toolchain-grid">
      {tools.map(([slug, name, role, w, h]) => (
        <li
          key={slug}
          className={slug === "pcbway" ? "tool-chip tool-chip-wide" : "tool-chip"}
        >
          <span className="tool-tile">
            {w > 0 ? (
              <Image
                src={`/media/integrations/${slug}.png`}
                alt={`${name} logo`}
                width={w}
                height={h}
              />
            ) : (
              <span className="tool-glyph" aria-hidden="true">
                ccx
              </span>
            )}
          </span>
          <span className="tool-meta">
            <strong>{name}</strong>
            <small>{role}</small>
          </span>
        </li>
      ))}
    </ul>
  );
}

function WindowFrame({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <figure className="window">
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
      <div className="window-body">{children}</div>
    </figure>
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
