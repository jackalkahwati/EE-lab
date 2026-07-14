/**
 * Model tiers — the ONE place that trades speed against quality.
 *
 * Why this file exists: every stage used to be hardcoded to `claude-sonnet-5`, so the
 * same model that picked the MCU also wrote boilerplate sourcing prose. That's a flat
 * allocation — it overpays for prose and underpays for design. Tiering it here makes the
 * tradeoff explicit and reversible instead of scattered across eight route files.
 *
 * MEASURED (2026-07-14, real runs):
 *  - Opus on the design path produced a visibly better board — correct USB-C CC1/CC2 sink
 *    pulldowns, a 74LVC1T45 level shifter for the WS2812B ring, RF keep-out under the radar.
 *    Sonnet never produced that depth. That quality gain is real and reproducible.
 *  - BUT no Opus run completed end-to-end, so its latency cost was never cleanly measured.
 *    Two hypotheses (re-plan-loop multiplier, 300s CLI timeout) were both investigated and
 *    both were WRONG — the honest state is "unmeasured", not "too slow".
 *  - The interview split IS measured: question turns on Haiku + 3 questions instead of 4 cut
 *    ~200s -> ~30s with no loss of adaptivity or question sharpness.
 *
 * DEFAULT = the known-fast tier, because speed is the current priority. To buy the design
 * quality back once the pipeline is green and measured, either flip `design` below to
 * 'claude-opus-4-8' or set FL_DESIGN_MODEL=claude-opus-4-8 — no code change needed.
 *
 * Note on the CLI path: lib/llm.ts `claudeCodeCall` maps the model string to a CLI alias via
 * /opus/i -> 'opus', /haiku/i -> 'haiku', else 'sonnet'. So these strings must literally
 * contain "opus"/"haiku" to select those aliases.
 */
export const MODEL = {
  /**
   * Stages that DECIDE the design: part set + topology (electronics-cs), the architecture
   * (architect), the ID form (industrial-design), the enclosure (mechanical), and the
   * redesign controller. This is the tier to raise to 'claude-opus-4-8' for quality.
   */
  design: process.env.FL_DESIGN_MODEL || 'claude-sonnet-5',

  /**
   * Density re-plan rounds: mechanically coarsen/shed an ALREADY-decided design so it routes
   * clean. Not new design work — kept cheap deliberately so re-plan rounds never multiply the
   * design tier's cost across iterations.
   */
  replan: process.env.FL_REPLAN_MODEL || 'claude-sonnet-5',

  /**
   * The four doc disciplines (firmware / manufacturing / supplyChain / validation): structured
   * summarization of facts already decided by the spec + built board. They make no design
   * decisions, and they're the longest generations in the pipeline.
   */
  docs: process.env.FL_DOCS_MODEL || 'claude-haiku-4-5',

  /** One adaptive, one-sentence clarifying question. Cheap by design. */
  interviewQuestion: process.env.FL_INTERVIEW_Q_MODEL || 'claude-haiku-4-5',

  /**
   * The FINAL product spec the entire downstream pipeline is built from. Quality-critical —
   * do not downgrade this to save a few seconds; everything else inherits its mistakes.
   */
  interviewSpec: process.env.FL_INTERVIEW_SPEC_MODEL || 'claude-sonnet-5',
} as const
