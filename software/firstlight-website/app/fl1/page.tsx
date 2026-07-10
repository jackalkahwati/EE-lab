import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ReserveButton } from "../reserve-button";

export const metadata: Metadata = {
  title: "FirstLight FL-1 — Autonomous hardware bring-up",
  description:
    "FL-1 is a single platform that grows with your lab. Bring-up, test, and validation in the box, expandable with tool heads and software packs. Reserve yours.",
  openGraph: {
    title: "FirstLight FL-1 — Autonomous hardware bring-up",
    description:
      "Insert an assembled PCB. FL-1 powers it up, probes it, and produces an evidence-based diagnosis.",
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

const BASE_DOES = [
  ["Bring-up", "Safe power sequencing, rail validation, current limiting, automated startup."],
  ["Firmware", "Automatic flashing, boot verification, recovery, and production programming."],
  ["Validation", "Functional tests, bus and sensor checks, and full power validation."],
  ["Production test", "Calibration, serial programming, traceability, and manufacturing reports."],
];

const HEADS = [
  ["Vision", "Locates the board, reads fiducials, and aligns the PCB."],
  ["Microscope", "Inspects solder joints, component orientation, IC markings, and bridges."],
  ["Probe", "Measures voltage, current, and analog signals at precise test points."],
  ["Communications", "JTAG, SWD, UART, SPI, I2C, CAN, USB, Ethernet. Flash, read, and debug."],
  ["Manipulation", "Presses buttons, mates connectors, operates switches, light gripping."],
];

const BENCH = [
  "Programmable multi-rail power supply and electronic load",
  "Oscilloscope, logic analyzer, and function generator",
  "6.5-digit digital multimeter and precision current monitoring",
  "Protected instrument-routing relay matrix",
];

const PACKS = [
  ["RF Pack", "Spectrum analyzer, VNA, and RF probing. Wi-Fi, Bluetooth, GPS, LoRa, cellular, UWB.", "Roadmap"],
  ["Power Electronics Pack", "High-current supply, differential probes, thermal camera. Motor drivers, inverters, DC/DC.", "Roadmap"],
  ["Battery Pack", "Charger, cycler, cell balancing. Capacity, internal resistance, safety, lifetime.", "Roadmap"],
  ["Optical Inspection Pack", "High-res microscope, thermal camera, structured light. AOI and 3D inspection.", "Roadmap"],
  ["Production Pack", "Barcode and label hardware, multi-board fixtures. MES, ERP, yield analytics, SPC.", "Roadmap"],
  ["Rework Pack", "Precision soldering, hot air, vacuum pickup. Automated component replacement and retest.", "Research"],
];

const ROI = [
  [
    "Replaces a bench of instruments",
    "A scope, logic analyzer, DMM, DAQ, electronic load, programmable supplies, a switch matrix, and a probe station is $40k to $80k of equipment that then sits idle between uses. FL-1 is one machine that does the work of all of them.",
  ],
  [
    "Replaces the expensive thing: engineer time",
    "Board bring-up is days to weeks of a senior hardware engineer, per revision. A team doing regular spins burns a hundred engineer-days a year on it. FL-1 compresses each bring-up from weeks to hours.",
  ],
  [
    "Pays for itself in months",
    "At a lab-instrument price, one machine offsets the instruments it replaces and the engineer time it frees on the first few board programs. Faster once you count the product launches it pulls forward.",
  ],
];

export default function FL1Page() {
  return (
    <main id="main-content">
      <nav className="nav" aria-label="Primary navigation">
        <div className="container nav-inner">
          <Link href="/" className="wordmark">
            <Starburst /> firstlight
          </Link>
          <div className="nav-links">
            <Link href="/#how">Compose</Link>
            <Link href="/#pricing">Pricing</Link>
            <Link href="/fl1">FL-1 machine</Link>
            <a href="#reserve" className="btn btn-small">
              Reserve
            </a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <header className="hero fl1-hero" id="top">
        <div className="container narrow center">
          <p className="kicker">FirstLight FL-1 · Autonomous hardware bring-up</p>
          <h1>
            One platform that brings your <span className="accent">board to life.</span>
          </h1>
          <p className="lede fl1-lede">
            Insert the assembled PCB. Press start. FL-1 powers it up, probes it,
            and gives you an evidence-based diagnosis of exactly what works and
            what failed. One machine that grows with your lab, not a product line
            you outgrow.
          </p>
        </div>
        <div className="container fl1-hero-img">
          <Image
            src="/media/fl1-hero-open.png"
            alt="FirstLight FL-1 with the canopy open, probing a circuit board"
            width={1402}
            height={1122}
            sizes="(max-width: 948px) calc(100vw - 48px), 900px"
            priority
          />
        </div>
      </header>

      {/* One platform */}
      <section className="section section-dark">
        <div className="container narrow">
          <p className="kicker">One platform</p>
          <h2>You buy one machine. You never outgrow it.</h2>
          <p>
            FL-1 is a single platform with a precision gantry, a tool changer,
            and a full instrument suite built in. You expand it over time with
            tool heads and software packs, rather than replacing the machine. The
            arm picks up the tool it needs from a dock along the wall, so the base
            you buy today runs every upgrade that comes later.
          </p>
          <p className="statement">
            One arm. A growing library of tools.
            <span className="accent"> A machine that gets more capable every year you own it.</span>
          </p>
        </div>
      </section>

      {/* What the base does */}
      <section className="section">
        <div className="container">
          <p className="kicker">The FL-1 base</p>
          <h2>Everything you need for bring-up, test, and validation. Standard.</h2>
          <div className="pillars-grid base-grid">
            {BASE_DOES.map(([title, body]) => (
              <div className="output-card" key={title}>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            ))}
          </div>
          <p className="how-lede">
            Plus an AI layer that does root-cause analysis, writes the failure
            report, and explains what to fix in plain English. That alone
            replaces most of a manual bring-up bench, before you add a single
            module.
          </p>
        </div>
      </section>

      {/* Tool heads */}
      <section className="section section-dark">
        <div className="container">
          <p className="kicker">Standard tool heads</p>
          <h2>One arm, the right tool for each job.</h2>
          <div className="heads-grid">
            {HEADS.map(([title, body]) => (
              <div className="head-card" key={title}>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Built-in instruments */}
      <section className="section">
        <div className="container narrow">
          <p className="kicker">Inside the machine</p>
          <h2>An entire instrument bench, built in.</h2>
          <ul className="spec-list fl1-specs">
            {BENCH.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <p className="statement">
            The instruments stay in the machine. Only the probes change.
            <span className="accent"> FL-1 decides what to measure next and what the results mean.</span>
          </p>
        </div>
      </section>

      {/* Expansion packs */}
      <section className="section section-dark">
        <div className="container">
          <p className="kicker">Grows with your lab</p>
          <h2>Add capability with hardware and software packs.</h2>
          <p className="how-lede">
            The base handles bring-up and test. As your needs grow, packs add new
            tool heads, instruments, and software to the same machine. Rolling out
            over time, in the order our customers ask for them.
          </p>
          <div className="packs-grid">
            {PACKS.map(([title, body, status]) => (
              <div className="pack-card" key={title}>
                <div className="pack-head">
                  <h3>{title}</h3>
                  <span className={`pack-status ${status === "Research" ? "research" : ""}`}>
                    {status}
                  </span>
                </div>
                <p>{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ROI */}
      <section className="section" id="roi">
        <div className="container">
          <p className="kicker">Why it belongs in your lab</p>
          <h2>A robotic test engineer, at a lab-instrument price.</h2>
          <div className="roi-grid">
            {ROI.map(([title, body]) => (
              <div className="roi-card" key={title}>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Closed loop */}
      <section className="section section-dark">
        <div className="container narrow center">
          <p className="kicker">The closed loop</p>
          <h2>Compose designs it. FL-1 proves it.</h2>
          <p>
            Compose generates the board and the test plan together, so every
            design arrives with the probe map, expected measurements, and
            pass/fail limits FL-1 needs. Design, build, validate, and improve, in
            one continuous loop that gets better with every board it runs.
          </p>
          <Link href="/#how" className="btn btn-ghost">
            See FirstLight Compose
          </Link>
        </div>
      </section>

      {/* Reserve */}
      <section className="section section-cta" id="reserve">
        <div className="container narrow center">
          <p className="kicker">Reserve your FL-1</p>
          <h2>Hold your place in line for the first production units.</h2>
          <p>
            FL-1 is in engineering validation. A fully refundable{" "}
            <strong>$2,500 deposit</strong> reserves an early production slot and
            locks the founding price. The deposit is applied to your purchase and
            refundable any time before your unit ships.
          </p>
          <div className="reserve-cta">
            <ReserveButton label="Reserve an FL-1, $2,500 refundable" />
          </div>
          <p className="reserve-fine">
            Founding price from $49,500, including 12 months of Compose Team ·
            expand with packs as you grow.
          </p>
        </div>
      </section>

      <footer className="footer">
        <div className="container footer-inner">
          <span className="wordmark small">
            <Starburst /> firstlight
          </span>
          <span className="footer-tag">Every board&apos;s first light.</span>
          <span className="footer-links">
            <Link href="/">Compose</Link>
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
