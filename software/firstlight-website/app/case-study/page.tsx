import type { Metadata } from "next";
import Link from "next/link";

const COMPOSE_URL =
  process.env.NEXT_PUBLIC_COMPOSE_URL || "https://app.firstlight.build";

export const metadata: Metadata = {
  title: "Built with Compose | The FL-1 case study",
  description:
    "We used FirstLight Compose to design, simulate, and iterate FL-1, our precision hardware bring-up machine. The dogfooding story, told honestly, and how it made the product better.",
  openGraph: {
    title: "Built with Compose | The FL-1 case study",
    description:
      "The machine that tests your product is the next bottleneck. We built ours with Compose.",
  },
};

const PIPELINE = [
  ["01 · Design", "Prompt to routed PCBA", "Real parts, a real netlist, routed and checked against a live KiCad DRC at the fab's rule profile. Two to eight copper layers, escalated as density demands."],
  ["02 · Mechanical", "Fit-checked enclosure", "A CAD enclosure generated from the board, with the actual PCB checked against the actual cavity. Not a rendering, a fit check."],
  ["03 · Simulate", "Physics and function", "Multi-physics and functional SPICE run on the design that shipped, each result labeled with its solver and its fidelity."],
  ["04 · Build", "Fab and sourcing docs", "Gerbers, drill, pick-and-place, BOM, and a test plan. The package that turns a routed board into an order."],
];

const CHAIN = [
  ["Digitizer", "ADS1115. 16-bit delta-sigma ADC over I2C."],
  ["Reference", "REF3025. 2.5 V precision voltage reference."],
  ["Front end", "CD74HC4067. 16-channel analog mux."],
  ["Controller", "RP2040. Drives channel select, reads the ADC."],
  ["Comms", "MAX3485. RS-485 to the instrument bus."],
];

const RECEIPTS = [
  ["2.5 V reference", "Holds under a load step", "0 uV settled error"],
  ["Mux to ADC", "Settles to 16-bit in time", "0.3 us, about 1000x margin"],
  ["RS-485 drive", "Valid differential on the bus", "2.36 V, 1.57x spec"],
  ["Power rail (PDN)", "Rail stays decoupled", "0.16 ohm, under 8 mV ripple"],
];

const SOLVERS = ["ngspice electrical", "scikit-fem thermal", "CalculiX structural", "OpenFOAM CFD", "Elmer acoustics"];

const JOURNEY = [
  [
    "DRC-clean is not correct",
    "A board can route perfectly and still be non-functional. A mux with only its power pin wired, an MCU with no flash to boot from. Manufacturability checks never catch it.",
    "A design-correctness gate. A rules engine that verifies the design is wired to work, every IC functionally connected and the signal chain intact, and blocks buildable-but-wrong before it reaches fab.",
  ],
  [
    "Dense precision boards fight two layers",
    "The measurement front end would not route clean on two layers. Real via congestion, not a bug.",
    "Multi-layer routing on 4, 6, and 8 layers, and an auto-partition that splits a too-dense board into a two-board kit with a synthesized connector. A rigid-flex path that folds those halves into one part is in progress.",
  ],
  [
    "It simulates hid what mattered",
    "Thermal and mechanical passing said nothing about whether the circuit works. The reference, the settling, the drive.",
    "Functional SPICE as a gate. Netlist-parameterized ngspice decks that run automatically on the critical paths. The numbers above are the output.",
  ],
];

export default function CaseStudyPage() {
  return (
    <main id="main-content" className="case-study">
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

      {/* Hero */}
      <header className="hero" id="top">
        <div className="container narrow">
          <p className="kicker">Case study · Built with Compose</p>
          <h1>
            We used Compose to build the machine that{" "}
            <span className="accent">brings hardware up.</span>
          </h1>
          <p className="hero-value">
            The rig that powers, programs, measures, and validates your product
            is the next bottleneck. Bespoke, low-volume, EE-heavy, and it gates
            your ship date.
          </p>
          <p className="lede">
            So we built ours with Compose. Boards, simulation, iteration. The
            same pipeline we sell. This is what that looked like, told honestly,
            including where it is still hard.
          </p>
        </div>
      </header>

      {/* The second wall */}
      <section className="section section-dark">
        <div className="container narrow">
          <p className="kicker">The second wall</p>
          <h2>Every hardware team hits the same wall twice.</h2>
          <p>
            The first wall is designing the product. Everyone plans for it. The
            second wall is the machine that proves the product works. The fixture
            that sequences power, flashes firmware, drives stimulus, reads 16-bit
            signals back, and decides pass or fail.
          </p>
          <p>
            It is custom, it is one-off, and it is where schedules quietly die,
            because it needs the same electrical, mechanical, and firmware effort
            as a product nobody will ever sell. Compose was built for the first
            wall. It turns out to be just as good at the second.
          </p>
          <p className="statement">
            So we pointed it at our own machine.
            <span className="accent"> We dogfood the product we sell.</span>
          </p>
        </div>
      </section>

      {/* What FL-1 is */}
      <section className="section">
        <div className="container narrow">
          <p className="kicker">The subject</p>
          <h2>FL-1, a precision bring-up machine, designed in Compose.</h2>
          <p className="how-lede">
            Its job is to sit on the bench, connect to a board under test, and
            measure it truthfully. 16 analog channels, digitized to 16 bits
            against a precision reference, controlled over I2C, reported over an
            RS-485 instrument bus. This is the measurement chain Compose wired.
          </p>
          <ul className="spec-list">
            {CHAIN.map(([role, part]) => (
              <li key={role}>
                <strong className="accent">{role}.</strong> {part}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* The pipeline */}
      <section className="section section-dark">
        <div className="container">
          <p className="kicker">The pipeline</p>
          <h2>A sentence goes in. A verified, manufacturable board comes out.</h2>
          <div className="pillars-grid">
            {PIPELINE.map(([step, title, body]) => (
              <div className="output-card" key={title}>
                <p className="kicker">{step}</p>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            ))}
          </div>
          <p className="how-lede">
            The same flow a customer runs. No special path for us. Each stage
            grounds on the last, and the whole loop iterates. When a board runs
            hot or fails a check, it feeds back and re-designs rather than faking
            convergence.
          </p>
        </div>
      </section>

      {/* The receipts */}
      <section className="section">
        <div className="container">
          <p className="kicker">The receipts</p>
          <h2>The simulation is real. Here are the numbers.</h2>
          <p className="how-lede">
            Not a vibe check. Actual solvers on the actual netlist. Beyond the
            thermal and mechanical passes, Compose ran a functional SPICE deck on
            each critical signal path of the measurement board, parameterized
            from the real parts on the board.
          </p>
          <div className="roi-grid">
            {RECEIPTS.map(([path, proves, result]) => (
              <div className="roi-card" key={path}>
                <h3>{path}</h3>
                <p>{proves}.</p>
                <p className="receipt-result">{result}</p>
              </div>
            ))}
          </div>
          <ul className="spec-list" style={{ marginTop: "1.5rem" }}>
            {SOLVERS.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <p className="how-lede">
            Honest scope. These are critical-path capability checks with
            datasheet-class device assumptions. They confirm the reference holds,
            the source settles to resolution, the driver drives, the rail is
            decoupled. They are not a whole-board behavioral model. Final
            functional truth still comes from bench bring-up, which is exactly the
            job FL-1 exists to do.
          </p>
        </div>
      </section>

      {/* The honest journey */}
      <section className="section section-dark">
        <div className="container">
          <p className="kicker">Why dogfooding matters</p>
          <h2>Building a real machine with it made the product better.</h2>
          <p className="how-lede">
            This is the part a demo cannot give you. Pointing Compose at hard,
            real hardware surfaced real gaps, and each one became a shipped
            capability. The machine got built. The product got sharper.
          </p>
          <div className="roi-grid">
            {JOURNEY.map(([found, foundBody, built]) => (
              <div className="roi-card" key={found}>
                <p className="kicker">Found on the bench</p>
                <h3>{found}</h3>
                <p>{foundBody}</p>
                <p className="kicker kicker-shipped">Shipped in Compose</p>
                <p>{built}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="section" id="start">
        <div className="container narrow">
          <p className="kicker">The takeaway</p>
          <h2>
            Compose builds your product. And the{" "}
            <span className="accent">machine that proves it works.</span>
          </h2>
          <p className="lede">
            The bring-up rig is the bottleneck no one budgets for. It is
            electrical, mechanical, and firmware, and it is exactly what this
            pipeline compresses. We know, because we built ours with it.
          </p>
          <div className="cta-row">
            <a href={COMPOSE_URL} className="btn btn-large">
              Start a free trial
            </a>
            <Link href="/fl1" className="btn btn-ghost">
              See the FL-1 machine
            </Link>
          </div>
          <p className="how-lede fine">
            FL-1 is a live, in-progress build. Everything here was produced by
            Compose through the iterative process described above. Where the
            automated pipeline still lands short of a clean board on the densest
            designs, we say so. That frontier is what the multi-layer, partition,
            and flex work continues to push.
          </p>
        </div>
      </section>

      <footer className="footer">
        <div className="container footer-inner">
          <span className="wordmark small">
            <Starburst /> Firstlight
          </span>
          <span className="footer-tag">Every board&apos;s first light.</span>
          <span className="footer-links">
            <Link href="/">Compose</Link>
            <Link href="/fl1">FL-1 machine</Link>
            <Link href="/developers">Developers</Link>
            <Link href="/terms">Terms of Use</Link>
            <Link href="/privacy">Privacy Policy</Link>
            <a href="mailto:jack@thestardrive.com">Contact</a>
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
