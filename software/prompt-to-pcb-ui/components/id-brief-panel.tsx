'use client'

/**
 * Industrial Design stage — the RIGHT-pane detailed results. The full ID brief
 * laid out field by field: form, ergonomics, envelope, CMF, controls, features,
 * constraints, rationale. Advisory design intent (no manufactured part).
 */
import type { IdBrief } from '@/lib/id-brief'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  if (children == null || children === '') return null
  return (
    <div className="border-b border-border/60 px-4 py-2.5">
      <div className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-[13px] text-foreground">{children}</div>
    </div>
  )
}

function Tags({ items }: { items?: string[] }) {
  if (!items?.length) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {items.map((t, i) => (
        <span key={i} className="rounded-sm border border-border bg-secondary/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">{t}</span>
      ))}
    </div>
  )
}

export function IdBriefPanel({ brief }: { brief: IdBrief }) {
  const e = brief.envelopeMm ?? {}
  const env = [e.x, e.y, e.z].some((v) => v != null)
    ? `${e.x ?? '?'} × ${e.y ?? '?'} × ${e.z ?? '?'} mm`
    : null
  const cmf = [brief.cmf?.material, brief.cmf?.finish, brief.cmf?.color].filter(Boolean).join(' · ')

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="text-sm font-semibold text-foreground">{brief.product}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          Industrial design brief — advisory intent, wraps the built board
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Row label="form factor">{brief.formFactor}</Row>
        <Row label="ergonomics">{brief.ergonomics}</Row>
        <Row label="envelope">{env ? <span className="font-mono">{env}</span> : null}</Row>
        <Row label="CMF">{cmf || null}</Row>
        <Row label="aesthetic">{brief.aesthetic}</Row>
        {brief.controls?.length ? <Row label="controls"><Tags items={brief.controls} /></Row> : null}
        {brief.keyFeatures?.length ? <Row label="key features"><Tags items={brief.keyFeatures} /></Row> : null}
        {brief.constraints?.length ? <Row label="ID constraints"><Tags items={brief.constraints} /></Row> : null}
        <Row label="rationale"><span className="italic text-muted-foreground">{brief.rationale}</span></Row>
      </div>
    </div>
  )
}
