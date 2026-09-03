/**
 * Documentation vignettes — rebuilt, zoomed-in fragments of real Compose
 * output, set in the instrument face (mono) on the light table, instead of
 * static screenshots. Every line of content is lifted verbatim from one real
 * run's generated artifacts (the Desk Presence Puck build), including the
 * honest amber flags — the vignette is a re-typeset zoom, never a mockup.
 * Static by design: the hero glow is the site's only animation.
 */

function Row({
  i,
  children,
  className = "",
}: {
  i: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`vg-row ${className}`} data-row={i}>
      {children}
    </div>
  );
}

function Chip({ tone, children }: { tone: "ok" | "warn" | "dim"; children: React.ReactNode }) {
  return <span className={`vg-chip vg-chip-${tone}`}>{children}</span>;
}

export function MfgVignette() {
  return (
    <div className="vignette" aria-label="Zoomed fragment of a generated manufacturing plan, content from a real Compose run">
      <div className="vg-head">
        <span className="vg-title">Desk Presence Puck · Manufacturing Plan</span>
        <Chip tone="dim">advisory</Chip>
      </div>
      <div className="vg-kicker">SMT process &amp; BOM</div>
      <Row i={1}>
        <span>2-layer, 25×25 mm · 10 components · RP2040 + USB-C</span>
        <Chip tone="ok">chip-scale</Chip>
      </Row>
      <Row i={2}>
        <span>Panelization 12-16 units/panel · 2,000 units/yr</span>
        <Chip tone="ok">low volume</Chip>
      </Row>
      <Row i={3}>
        <span>Standard lead-free reflow · no exotic processes</span>
        <Chip tone="ok">DFM</Chip>
      </Row>
      <Row i={4} className="vg-row-warn">
        <span>BOM incomplete, no 60 GHz radar module listed yet</span>
        <Chip tone="warn">engineer needed</Chip>
      </Row>
      <div className="vg-term">
        <span className="vg-term-line">manufacturing → passed · artifact generated</span>
        <span className="vg-caret" aria-hidden="true" />
      </div>
    </div>
  );
}

export function SourcingVignette() {
  return (
    <div className="vignette" aria-label="Zoomed fragment of a generated sourcing plan, content from a real Compose run">
      <div className="vg-head">
        <span className="vg-title">Sourcing · canonical parts</span>
        <Chip tone="dim">not live-sourced</Chip>
      </div>
      <Row i={1}>
        <span>
          <b>RP2040</b> · QFN-48 · ~$2-3/u · 4-8 wk
        </span>
        <Chip tone="ok">no single-source risk</Chip>
      </Row>
      <Row i={2}>
        <span>
          <b>MX126-5.0-02P</b> · USB-C · ~$0.50-0.80/u · 2-4 wk
        </span>
        <Chip tone="ok">Molex + 2 alternates</Chip>
      </Row>
      <Row i={3}>
        <span>C2, C3 · 0402 decoupling · commodity</span>
        <Chip tone="ok">multi-vendor</Chip>
      </Row>
      <Row i={4} className="vg-row-warn">
        <span>8 of 10 BOM lines still unspecified</span>
        <Chip tone="warn">critical gap</Chip>
      </Row>
    </div>
  );
}

export function ValidationVignette() {
  return (
    <div className="vignette" aria-label="Zoomed fragment of a generated FL-1 validation plan, content from a real Compose run">
      <div className="vg-head">
        <span className="vg-title">FL-1 validation · coverage</span>
        <Chip tone="dim">generated plan</Chip>
      </div>
      <Row i={1}>
        <span>USB enumeration &amp; data integrity · 48 h continuous</span>
        <Chip tone="ok">planned</Chip>
      </Row>
      <Row i={2}>
        <span>Power budget · 1200 mW active / 50 µW sleep</span>
        <Chip tone="ok">planned</Chip>
      </Row>
      <Row i={3}>
        <span>LED ring state machine · visual + logic capture</span>
        <Chip tone="ok">planned</Chip>
      </Row>
      <Row i={4} className="vg-row-warn">
        <span>Radar detection range · targets undefined, baseline first</span>
        <Chip tone="warn">gap flagged</Chip>
      </Row>
    </div>
  );
}

export function EditLoopVignette() {
  return (
    <div className="vignette" aria-label="Rebuilt zoom of a targeted revision in Compose, content from a real edit">
      <div className="vg-head">
        <span className="vg-title">Revise · Desk Presence Puck</span>
        <Chip tone="dim">rev 1 → rev 2</Chip>
      </div>
      <Row i={1}>
        <span className="vg-typed">&ldquo;reduce the enclosure height by 2 mm&rdquo;</span>
        <Chip tone="dim">routed</Chip>
      </Row>
      <Row i={2}>
        <span>re-runs mechanical, simulation · everything else stays current</span>
        <Chip tone="ok">targeted</Chip>
      </Row>
      <Row i={3}>
        <span>mechanical · fresh CAD, fit checked against the real board</span>
        <Chip tone="ok">rebuilt</Chip>
      </Row>
      <Row i={4}>
        <span>electronics, firmware, docs · inputs unchanged, proven by hash</span>
        <Chip tone="ok">reused</Chip>
      </Row>
      <Row i={5}>
        <span>rev 2 diff · enclosure height 22 → 20 mm, board untouched</span>
        <Chip tone="ok">reviewable</Chip>
      </Row>
      <div className="vg-term">
        <span className="vg-term-line">targeted revision complete · minutes, not a full rebuild</span>
        <span className="vg-caret" aria-hidden="true" />
      </div>
    </div>
  );
}
