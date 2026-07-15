import Image from "next/image";
import Link from "next/link";
import { TryCompose } from "./try-compose";

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
  ["Physics simulation", "Real finite-element thermal and modal solves with scikit-fem, honestly labeled. A design that runs hot fails in simulation before anyone tools a mold."],
  ["Firmware", "A compiled firmware image that targets the board that actually shipped, with the peripheral map, power states, and USB reporting."],
  ["Manufacturing, sourcing & test", "An NPI package sized to your volume, a sourcing plan with real parts and lead-time risks called out, and an FL-1 validation test plan with the gaps flagged, never papered over."],
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
            <a href="#pricing">Pricing</a>
            <Link href="/fl1">FL-1 machine</Link>
            <Link href="/developers">Developers</Link>
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

      {/* Hero, Compose */}
      <header className="hero" id="top">
        <div className="container">
          <div className="hero-copy">
            <p className="kicker">FirstLight Compose · AI product engineering</p>
            <h1>
              Design a real product <span className="accent">from a sentence.</span>
            </h1>
            <p className="lede">
              Describe what you&apos;re building in plain language. Compose designs
              and routes the board, wraps it in an enclosure that actually fits,
              runs real physics simulation, generates firmware for the board that
              shipped, and hands you the manufacturing, sourcing, and test plans
              to build it. About seven minutes, end to end.
            </p>
            <TryCompose />
            <p className="run-caption">
              Free account, 5 credits a month, no card required.{" "}
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
        </div>
        <div className="container hero-shot">
          <div className="shot-stage">
            <WindowFrame title="FirstLight Compose">
              <Image
                src="/media/compose-hero.jpg"
                alt="The Compose workspace, with a circular PCBA rendered in 3D, every pipeline discipline green, live logs streaming in the terminal"
                width={1600}
                height={914}
                sizes="(max-width: 1248px) calc(100vw - 48px), 1152px"
                priority
              />
            </WindowFrame>
          </div>
        </div>
      </header>

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
            <span className="accent"> A manufacturable product. Board, enclosure, firmware, and the plans to ship it.</span>
          </p>
        </div>
      </section>

      {/* How Compose works */}
      <section className="section" id="how">
        <div className="container">
          <p className="kicker">How it works</p>
          <h2>From a prompt to a manufacturable product, in one run.</h2>
          <div className="pipeline">
            {PIPELINE.map((s) => (
              <span key={s} className="pipeline-stage">
                ✓ {s}
              </span>
            ))}
          </div>
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
              <Image
                src="/media/doc-mfg.jpg"
                alt="A generated manufacturing package in Compose: SMT and reflow assembly notes, power and thermal constraints, DFM checks, NPI and yield drivers, and a cost and supply-chain breakdown"
                width={1600}
                height={980}
                sizes="(max-width: 900px) calc(100vw - 48px), 620px"
              />
            </WindowFrame>
          </div>
        </div>
        <div className="container doc-row">
          <WindowFrame title="Sourcing plan">
            <Image
              src="/media/doc-sourcing.jpg"
              alt="A generated sourcing plan in Compose, listing real parts with lead-time and substitution risks called out"
              width={1600}
              height={980}
              sizes="(max-width: 900px) calc(100vw - 48px), 564px"
            />
          </WindowFrame>
          <WindowFrame title="FL-1 validation plan">
            <Image
              src="/media/doc-validation.jpg"
              alt="A generated FL-1 validation test plan in Compose, with functional, electrical, and reliability coverage and the remaining gaps flagged"
              width={1600}
              height={980}
              sizes="(max-width: 900px) calc(100vw - 48px), 564px"
            />
          </WindowFrame>
        </div>
      </section>

      {/* Pricing */}
      <section className="section section-dark" id="pricing">
        <div className="container">
          <p className="kicker">Pricing</p>
          <h2>Start free. Go to production with us.</h2>
          <p className="pricing-note">
            Evaluate Compose free, every account gets the full design pipeline.
            Production teams license the platform annually, with board-program
            bundles, seats for the whole lab, and support that answers.
          </p>
          <div className="pricing-grid">
            <div className="price-card">
              <h3>Free</h3>
              <p className="price">
                $0<span>/month</span>
              </p>
              <ul>
                <li>5 credits per month</li>
                <li>Full design pipeline</li>
                <li>Fab package + firmware downloads</li>
                <li>FL-1 test plan on every board</li>
              </ul>
              <a href={COMPOSE_URL} className="btn btn-ghost price-cta">
                Start free
              </a>
            </div>
            <div className="price-card price-card-pro">
              <span className="price-badge">Production</span>
              <h3>Teams &amp; Enterprise</h3>
              <p className="price">
                Custom<span>/year</span>
              </p>
              <ul>
                <li>90-day paid pilot, credited toward Year 1</li>
                <li>Board-program bundles + seats for your team</li>
                <li>Principal-EE design reviews, SLA, SSO</li>
                <li>ITAR-ready deployment for defense &amp; space</li>
              </ul>
              <a
                href={`mailto:${CONTACT}?subject=Compose%20for%20production`}
                className="btn price-cta"
              >
                Talk to us
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* FL-1, coming next, reserve */}
      <section className="section" id="fl1">
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
      <section className="section section-dark" id="demo">
        <div className="container narrow center">
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
