/**
 * Industrial Design brief — the FIRST stage of the pipeline, one tier above the
 * Product Architect. Turns a natural-language product INTENT into a structured
 * ID brief: form factor, ergonomics, CMF (color/material/finish), a rough outer
 * envelope, and an aesthetic point of view. The brief then CONSTRAINS the
 * Product Architect (its envelope becomes the size budget; its POV the product
 * philosophy), so every downstream discipline inherits a coherent physical form.
 *
 * Like the board interview and the architect, this is a stateless clarifying
 * dialogue: the client sends the intent + answers so far, the model returns the
 * next question or a finalized brief. Pure LLM — no external system, no geometry
 * yet (that is a later phase). General across product categories.
 */

/** Color / material / finish — the tactile + visual identity of the product. */
export interface CMF {
  material?: string // primary material(s), e.g. "PC/ABS", "anodized aluminium", "silicone"
  finish?: string // surface treatment, e.g. "matte soft-touch", "bead-blast", "gloss"
  color?: string // primary colorway
}

/** A finalized Industrial Design brief. Every field is advisory design intent —
 *  it declares WHAT the form should be, not a manufactured part. */
export interface IdBrief {
  product: string // short product name
  formFactor: string // one line: the physical form ("handheld wand", "clip-on puck")
  ergonomics: string // how it is held / worn / mounted / used
  envelopeMm: { x?: number; y?: number; z?: number } // rough max outer envelope
  cmf: CMF
  aesthetic: string // the design point of view (minimal / rugged / clinical / playful ...)
  controls?: string[] // physical affordances (button, dial, touch, none)
  keyFeatures?: string[] // defining ID features (display, lanyard loop, kickstand ...)
  constraints?: string[] // ID-level constraints handed to downstream disciplines
  rationale?: string // one line: why this form serves the intent
}

/**
 * Normalize an LLM-produced brief: guarantee every field exists with a sane
 * type, so the architect and UI never see a missing field.
 */
export function normalizeIdBrief(raw: Partial<IdBrief> | undefined): IdBrief {
  const s = (raw ?? {}) as IdBrief
  const e = (s.envelopeMm ?? {}) as IdBrief['envelopeMm']
  const cmf = (s.cmf ?? {}) as CMF
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && isFinite(v) ? v : undefined
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
  return {
    product: s.product || 'Untitled product',
    formFactor: s.formFactor || '',
    ergonomics: s.ergonomics || '',
    envelopeMm: { x: num(e.x), y: num(e.y), z: num(e.z) },
    cmf: { material: cmf.material || undefined, finish: cmf.finish || undefined, color: cmf.color || undefined },
    aesthetic: s.aesthetic || '',
    controls: list(s.controls),
    keyFeatures: list(s.keyFeatures),
    constraints: list(s.constraints),
    rationale: s.rationale || '',
  }
}

/** Compact one-block summary of a brief — injected into the Architect prompt as
 *  hard constraints, and usable for UI. Omits empty fields. */
export function idBriefSummary(b: IdBrief): string {
  const env = b.envelopeMm
  const envStr =
    env.x || env.y || env.z
      ? `envelope ≈ ${[env.x, env.y, env.z].map((v) => (v != null ? `${v}` : '?')).join(' × ')} mm`
      : ''
  const cmf = [b.cmf.material, b.cmf.finish, b.cmf.color].filter(Boolean).join(', ')
  return [
    b.formFactor && `form: ${b.formFactor}`,
    b.ergonomics && `ergonomics: ${b.ergonomics}`,
    envStr,
    cmf && `CMF: ${cmf}`,
    b.aesthetic && `aesthetic: ${b.aesthetic}`,
    b.controls?.length && `controls: ${b.controls.join(', ')}`,
    b.keyFeatures?.length && `features: ${b.keyFeatures.join(', ')}`,
    b.constraints?.length && `ID constraints: ${b.constraints.join('; ')}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** The exact JSON contract the Industrial Designer LLM must emit (embedded in
 *  its prompt). */
export const ID_BRIEF_SCHEMA = `{
  "product": "<short name>",
  "formFactor": "<one line: the physical form, e.g. 'clip-on oval puck' or 'benchtop instrument'>",
  "ergonomics": "<how it is held / worn / mounted / operated>",
  "envelopeMm": { "x": <n>, "y": <n>, "z": <n> },
  "cmf": { "material": "<primary material(s)>", "finish": "<surface finish>", "color": "<colorway>" },
  "aesthetic": "<the design point of view: minimal | rugged | clinical | playful | industrial | ...>",
  "controls": ["<physical affordance>", "..."],
  "keyFeatures": ["<defining ID feature>", "..."],
  "constraints": ["<ID-level constraint for downstream disciplines>", "..."],
  "rationale": "<one line: why this form serves the intent>"
}`
