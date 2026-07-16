/**
 * Mechanical ID-fidelity contract — the judge's rubric, the verdict shape,
 * and the critique block fed back into the mechanical planner on a revise
 * round. The judge compares RENDERED CAD (multi-view PNGs) against the ID
 * brief text and, when the concept sheet exists, the ID render image.
 */
import type { IdBrief } from '@/lib/id-brief'

export interface FidelityViolation {
  aspect: 'formFactor' | 'envelope' | 'feature' | 'control' | 'proportion' | 'other'
  expected: string
  observed: string
  fix: string // concrete, actionable, in build-plan vocabulary terms
}

export interface FidelityVerdict {
  score: number // 0-100
  adheres: boolean
  violations: FidelityViolation[]
  summary: string
}

export interface FidelityRound {
  round: number
  provider: string
  verdict: FidelityVerdict
}

export interface FidelityReport {
  state: 'verified' | 'failed-threshold' | 'unverified'
  reason?: string // for unverified: why the judge was unavailable
  threshold: number
  rounds: FidelityRound[]
}

export const FIDELITY_THRESHOLD = Number(process.env.FL_MECH_FIDELITY_THRESHOLD || 70)
export const FIDELITY_ROUNDS = Number(process.env.FL_MECH_FIDELITY_ROUNDS || 1)
export const FIDELITY_ENABLED = process.env.FL_MECH_FIDELITY !== '0'

export function judgeSystem(): string {
  return (
    'You are an industrial-design reviewer. You compare rendered CAD views of an ' +
    'enclosure against an industrial design brief (and a concept sheet image when ' +
    'provided). You are strict about FORM (silhouette, proportions, envelope) and ' +
    'FEATURES (ports, vents, controls, windows present in the right faces), and ' +
    'you ignore rendering style, color, and material appearance — the CAD is ' +
    'unstyled geometry. Reply with ONLY a JSON object.'
  )
}

export function judgeUser(brief: IdBrief, viewNames: string[], hasConceptSheet: boolean): string {
  const briefTxt = JSON.stringify({
    product: brief.product,
    formFactor: brief.formFactor,
    envelopeMm: brief.envelopeMm,
    ergonomics: brief.ergonomics,
    keyFeatures: brief.keyFeatures,
    controls: brief.controls,
    constraints: brief.constraints,
  })
  return [
    `CAD views provided, in order: ${viewNames.join(', ')}.`,
    hasConceptSheet
      ? 'The FINAL image is the ID concept sheet (2x2: front, perspective, top, side) — the form the CAD must realize.'
      : 'No concept sheet is available — judge against the brief text alone.',
    `ID BRIEF: ${briefTxt}`,
    'Score how faithfully the CAD realizes the ID (0-100; 100 = the concept made solid).',
    'Every violation must carry a concrete "fix" phrased for a parametric CAD planner whose vocabulary is: sketch (roundedRect/rect/circle/ring), extrude, pocket, standoff, cutout (on a named face), fillet, component.',
    'Reply with ONLY: {"score": n, "adheres": bool, "violations": [{"aspect": "formFactor|envelope|feature|control|proportion|other", "expected": str, "observed": str, "fix": str}], "summary": str}',
  ].join('\n')
}

export function critiqueBlock(round: number, verdict: FidelityVerdict): string {
  const fixes = verdict.violations.map((v, i) => `${i + 1}. [${v.aspect}] ${v.fix} (expected: ${v.expected}; currently: ${v.observed})`)
  return (
    `\nFIDELITY CRITIQUE (revision round ${round} — a design reviewer compared the RENDERED CAD to the ID brief; score ${verdict.score}/100):\n` +
    fixes.join('\n') +
    `\nRevise the plan to resolve these SPECIFIC violations. Keep everything that already adheres (board fit, standoffs at real hole positions, wall rules) unchanged.\n`
  )
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && isFinite(v) ? v : d)

export function normalizeVerdict(raw: unknown): FidelityVerdict {
  const r = (raw ?? {}) as Record<string, unknown>
  const asp = ['formFactor', 'envelope', 'feature', 'control', 'proportion', 'other']
  const violations: FidelityViolation[] = (Array.isArray(r.violations) ? r.violations : [])
    .map((v: any): FidelityViolation => ({
      aspect: asp.includes(v?.aspect) ? v.aspect : 'other',
      expected: String(v?.expected ?? ''),
      observed: String(v?.observed ?? ''),
      fix: String(v?.fix ?? ''),
    }))
    .filter((v) => v.fix)
  const score = Math.max(0, Math.min(100, num(r.score, 0)))
  return { score, adheres: r.adheres === true, violations, summary: String(r.summary ?? '') }
}
