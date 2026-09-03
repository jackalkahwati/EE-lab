/**
 * Types for lib/subsystem-compose.mjs.
 *
 * The implementation is plain ESM JavaScript on purpose: the unit suite is
 * `node --test tests/*.test.mjs` and cannot resolve the `@/` TypeScript alias,
 * so keeping it .mjs makes it directly testable. This declaration gives
 * TypeScript callers the real shape.
 */

export interface Port {
  signal: string
  net: string
}

export interface Subsystem {
  name: string
  purpose?: string
  parts?: Array<Record<string, unknown> & { name?: string; footprint?: string; kind?: string }>
  nets?: Array<[string, string]>
  gnd?: string[]
  provides?: Port[]
  requires?: Port[]
}

export type ProblemSeverity = 'error' | 'warning'

export type ProblemCode =
  | 'no_subsystems'
  | 'unnamed_subsystem'
  | 'duplicate_subsystem'
  | 'prefix_collision'
  | 'empty_subsystem'
  | 'unnamed_part'
  | 'duplicate_part'
  | 'no_nets'
  | 'malformed_net'
  | 'malformed_port'
  | 'unknown_ref'
  | 'duplicate_provide'
  | 'unsatisfied_require'
  | 'unused_provide'
  | 'orphan_part'

export interface Problem {
  severity: ProblemSeverity
  code: ProblemCode
  message: string
  subsystem?: string
  signal?: string
  ref?: string
}

export interface ComposedInterface {
  signal: string
  from: string
  fromEndpoint: string
  to: string[]
  toEndpoints: string[]
}

export interface ComposedPart extends Record<string, unknown> {
  name: string
  /** Which subsystem contributed it. Bookkeeping, not runner input. */
  subsystem: string
}

export interface ComposeStats {
  subsystems: number
  parts: number
  nets: number
  interfaces: number
  errors: number
  warnings: number
}

export interface ComposeResult {
  parts: ComposedPart[]
  nets: Array<[string, string]>
  gnd: string[]
  interfaces: ComposedInterface[]
  problems: Problem[]
  stats: ComposeStats
}

export interface GenerationBrief {
  name: string
  purpose: string
  mustProvide: string[]
  mayRequire: string[]
  contract: string
}

export function composeSubsystems(
  subsystems: Subsystem[] | null | undefined,
  opts?: { requireEveryProvideUsed?: boolean },
): ComposeResult

export function verifyComposition(result: Partial<ComposeResult> | null | undefined): Problem[]

export function splitForGeneration(
  plan: { subsystems?: Array<{ name?: string; purpose?: string; provides?: Port[]; requires?: Port[] }> } | null | undefined,
): GenerationBrief[]
