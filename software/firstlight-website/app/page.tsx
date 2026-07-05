import { TryCompose } from "./try-compose";

const COMPOSE_URL =
  process.env.NEXT_PUBLIC_COMPOSE_URL || "http://localhost:4500";
const CONTACT = "jack@thestardrive.com";

const PIPELINE = [
  "design",
  "placement",
  "routing",
  "validation",
  "erc",
  "firmware",
];

const OUTPUTS = [
  ["Manufacturable fab package", "Gerbers, drill, pick-and-place, STEP, BOM, accepted by any board house."],
  ["Firmware", "A compiled, self-test firmware image generated for your board."],
  ["FL-1 test plan", "A machine-readable probe map with pass/fail limits, ready for hardware validation."],
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
    <main>
      {/* Nav */}
      <nav className="nav">
        <div className="container nav-inner">
          <a href="#top" className="wordmark">
            <Starburst /> firstlight
          </a>
          <div className="nav-links">
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="/fl1">FL-1 machine</a>
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
        <div className="container hero-grid">
          <div className="hero-copy">
            <p className="kicker">FirstLight Compose · AI hardware design</p>
            <h1>
              Design a real PCB <span className="accent">from a sentence.</span>
            </h1>
            <p className="lede">
              Describe what you&apos;re building in plain language. Compose places
              the parts, routes the board, runs the electrical checks, generates
              the firmware, and hands you a manufacturable fab package. Minutes,
              not weeks.
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
                <strong>12/12</strong> nets routed
              </li>
              <li>
                <strong>0</strong> DRC violations
              </li>
              <li>
                <strong>3 min</strong> prompt to fab package
              </li>
            </ul>
          </div>
          <div className="hero-image">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/media/board-top.png"
              alt="A PCB designed and routed by FirstLight Compose from a plain-language prompt"
            />
          </div>
        </div>
      </header>

      {/* Problem */}
      <section className="section section-dark">
        <div className="container narrow">
          <h2>
            AI can describe a circuit.
            <br />
            Getting to a board you can build is the hard part.
          </h2>
          <p>
            Schematic ideas are cheap. Turning one into placed, routed,
            electrically-clean copper with the right parts, firmware, and a
            fabrication package still means days of manual CAD, or a contract
            engineer. Compose closes that gap in a single continuous run.
          </p>
          <p className="statement">
            Describe it. Compose builds it.
            <span className="accent"> A manufacturable board, checked and ready to order.</span>
          </p>
        </div>
      </section>

      {/* How Compose works */}
      <section className="section" id="how">
        <div className="container">
          <p className="kicker">How it works</p>
          <h2>From a prompt to a manufacturable board, in one run.</h2>
          <div className="pipeline">
            {PIPELINE.map((s) => (
              <span key={s} className="pipeline-stage">
                ✓ {s}
              </span>
            ))}
          </div>
          <p className="how-lede">
            A short design interview fills in the details, MCU, radio, power,
            connectors, with sensible defaults. Then the full pipeline runs in
            front of you, gated at every stage: nothing ships unless the copper
            is clean and every net connects.
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

      {/* Pricing */}
      <section className="section section-dark" id="pricing">
        <div className="container">
          <p className="kicker">Pricing</p>
          <h2>Start free. Upgrade when you ship.</h2>
          <p className="pricing-note">
            A credit buys a board run. Simple boards cost one; complex boards
            cost more, so you only pay for what you design. Buy top-up credits
            anytime, the bigger the pack, the lower the per-credit price.
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
              <span className="price-badge">Pro</span>
              <h3>Pro</h3>
              <p className="price">
                $49<span>/month</span>
              </p>
              <ul>
                <li>100 credits per month</li>
                <li>Buy more anytime, volume discounts</li>
                <li>Principal-EE design reviews</li>
                <li>Bring-your-own AI provider key</li>
              </ul>
              <a href={COMPOSE_URL} className="btn price-cta">
                Go Pro
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
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/media/fl1-hero-open.png"
                alt="FirstLight FL-1 Desktop with the canopy open, probing a board, the autonomous PCB bring-up and diagnosis station"
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
                <a className="btn" href="/fl1#reserve">
                  Reserve an FL-1
                </a>
                <a className="btn btn-ghost" href="/fl1">
                  Learn more
                </a>
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
            design model: canopy, fixture drawer, and an autonomous probing run.
          </p>
          <video
            controls
            autoPlay
            loop
            muted
            playsInline
            preload="metadata"
            className="demo-video"
          >
            <source src="/media/promo.mp4" type="video/mp4" />
          </video>
        </div>
      </section>

      {/* Footer */}
      <footer className="footer">
        <div className="container footer-inner">
          <span className="wordmark small">
            <Starburst /> firstlight
          </span>
          <span className="footer-tag">Every board&apos;s first light.</span>
          <span className="footer-links">
            <a href={COMPOSE_URL}>Sign in</a>
            <a href="/terms">Terms of Use</a>
            <a href="/privacy">Privacy Policy</a>
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
