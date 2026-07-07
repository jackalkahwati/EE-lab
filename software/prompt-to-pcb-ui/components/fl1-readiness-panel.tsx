'use client'

/**
 * FL-1 Instrument Readiness — the honest planning view for the FL-1 internal
 * instrument board family. Reads the fl1-* reports: board readiness ranking,
 * instrument bus, pattern readiness, RF/scope/stimulus/logic/FPGA status, and
 * manufacturing capability. Never fakes a capability — scope-lite shows
 * unsupported, RF shows estimate-only, DDR/PCIe/MIPI/BGA show unsupported.
 */

import { useEffect, useState } from 'react'
import { Cpu, Download, AlertTriangle } from 'lucide-react'

const R_STYLE: Record<string, string> = {
  ready_to_attempt: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  pattern_backed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  buildable_with_review: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  partial: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  needs_reference: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  needs_simulation: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  needs_specialist_fab: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  needs_external_instrument: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  unsupported: 'border-destructive/40 bg-destructive/10 text-destructive',
}

export function FL1ReadinessPanel({ runId }: { runId: string | null }) {
  const [d, setD] = useState<Record<string, any> | null | undefined>(undefined)

  useEffect(() => {
    if (!runId) {
      setD(null)
      return
    }
    let off = false
    const files = [
      'fl1-board-family-architecture', 'fl1-instrument-bus-v1',
      'fl1-reference-pattern-readiness', 'fl1-rf-50ohm-interface-report',
      'fl1-scope-lite-starter-report', 'fl1-stimulus-starter-report',
      'fl1-logic-capture-starter-report', 'fl1-fpga-module-carrier-report',
      'fl1-manufacturing-capability-report', 'cal-board-attempt', 'shared-bus-report',
      'fine-pitch-escape-model', 'fl1-build-readiness-dashboard', 'combined-signoff-report',
      'fl1-curated-reference-library', 'fl1-validation-readiness-dashboard', 'demo-validation-runs',
      'fl1-instrument-core-v1', 'phase15-board-readiness-dashboard',
      'role-completeness-report', 'phase15-first-article-review-v2',
      'fl1-batch1-serial-plan', 'phase16-demo-runs', 'phase16-held-board-status',
      'calibration-board-finegrid-result', 'via-in-pad-feasibility-report',
      'batch1-stability-report', 'fl1-first-article-review-pack',
      'fl1-final-first-article-review-v3', 'fl1-board-id-addressing-strategy',
      'fl1-manufacturing-readiness-pack', 'fl1-held-board-architecture-search',
      'pcm1-measurement-claim-model', 'pcm1-safety-protection-model', 'pcm1-compose-report',
      'fl1-system-architecture', 'fl1-backplane-v1-compose-report', 'fl1-slot-standard-v1',
      'fl1-i2c-pullup-checker-report', 'fl1-connector-orientation-checker-report',
      'fl1-system-revb-recommendations',
      'fl1-pinout-compatibility-report', 'fl1-system-risk-register', 'fl1-monolithic-costdown-roadmap',
      'full16-monolithic-architecture-comparison', 'full16-monolithic-treatment-classification',
      'full16-monolithic-final-recommendation', 'rp2040-qfn56-fanout-feasibility',
      'fl1-recommended-next-board-roadmap',
    ]
    Promise.all(
      files.map((f) =>
        fetch(`/runs/${runId}/data/${f}.json`, { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => [f, j] as const)
          .catch(() => [f, null] as const),
      ),
    ).then((p) => !off && setD(Object.fromEntries(p)))
    return () => {
      off = true
    }
  }, [runId])

  if (!runId || d === null)
    return <div className="p-4 text-xs text-muted-foreground">No FL-1 readiness reports for this run.</div>
  if (d === undefined) return <div className="p-4 text-xs text-muted-foreground">Loading…</div>

  const fam = d['fl1-board-family-architecture']
  if (!fam)
    return <div className="p-4 text-xs text-muted-foreground">No FL-1 readiness reports for this run.</div>

  const starters = [
    ['RF / 50Ω interface', d['fl1-rf-50ohm-interface-report']],
    ['Scope-lite starter', d['fl1-scope-lite-starter-report']],
    ['Stimulus starter', d['fl1-stimulus-starter-report']],
    ['Logic capture starter', d['fl1-logic-capture-starter-report']],
    ['FPGA/module carrier', d['fl1-fpga-module-carrier-report']],
  ] as const

  return (
    <div className="space-y-4 overflow-y-auto p-4 text-xs">
      <div className="flex items-center gap-2">
        <Cpu className="size-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">FL-1 Instrument Readiness</span>
        <a
          href={`/runs/${runId}/data/fl1-board-family-architecture.json`}
          download
          className="ml-auto inline-flex items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20"
        >
          <Download className="size-3" /> architecture JSON
        </a>
      </div>

      {/* real cal-board attempt (Phase 12 fix) — distinguishes the REAL cal board
          from the ADS1115 measurement front-end; honest outcome + exact blocker */}
      {d['cal-board-attempt'] && (
        <div
          className={`rounded-md border p-3 ${
            d['cal-board-attempt'].outcome === 'A_pass'
              ? 'border-emerald-500/40 bg-emerald-500/5'
              : 'border-amber-500/40 bg-amber-500/5'
          }`}
        >
          <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-amber-500">
            <AlertTriangle className="size-3.5" /> {d['cal-board-attempt'].board} —{' '}
            {d['cal-board-attempt'].outcome === 'A_pass' ? 'passed' : 'honest fail (Outcome B)'}
          </p>
          <p className="text-muted-foreground">{d['cal-board-attempt'].note}</p>
          <div className="mt-1 font-mono text-[10px] text-muted-foreground">
            required parts:{' '}
            {Object.entries(d['cal-board-attempt'].required_parts_present ?? {})
              .map(([k, v]) => `${k}=${v ? '✓' : '✗'}`)
              .join(' ')}{' '}
            · divider={d['cal-board-attempt'].divider_present ? '✓' : '✗'} · nodes{' '}
            {(d['cal-board-attempt'].reference_nodes ?? []).join('/')} · routed{' '}
            {d['cal-board-attempt'].routed} · DRC {d['cal-board-attempt'].drc_violations}
          </div>
          {d['cal-board-attempt'].blocker && (
            <p className="mt-1 text-[10px] text-destructive">
              blocker: {d['cal-board-attempt'].blocker}
            </p>
          )}
        </div>
      )}

      {/* Phase 19: System / Mechanical — the modular machine */}
      {d['fl1-system-architecture'] && (
        <div className="rounded-md border border-border p-3">
          <p className="mb-1 text-[11px] font-semibold text-foreground">
            System / Mechanical — modular six-card machine (engineering concept, not
            production-ready)
          </p>
          {d['fl1-backplane-v1-compose-report'] && (
            <p className="text-[10px] text-emerald-500">
              Passive backplane v1: {d['fl1-backplane-v1-compose-report'].routing} nets, DRC{' '}
              {d['fl1-backplane-v1-compose-report'].drc_violations} —{' '}
              {d['fl1-backplane-v1-compose-report'].status} ·{' '}
              {d['fl1-backplane-v1-compose-report'].order}
            </p>
          )}
          <div className="mt-1 flex flex-wrap gap-1">
            {d['fl1-system-architecture'].modules?.map((m: any, i: number) => (
              <span
                key={i}
                className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[8px] text-muted-foreground"
              >
                S{m.slot}: {m.module} @ {m.i2c_identity}
              </span>
            ))}
          </div>
          {d['fl1-pinout-compatibility-report'] && (
            <div className="mt-1 space-y-0.5">
              {d['fl1-pinout-compatibility-report'].findings
                .filter((f: any) => f.status !== 'CONSISTENT')
                .map((f: any, i: number) => (
                  <p key={i} className="text-[9px] text-amber-500">
                    {f.item}: {f.status} — {f.detail}
                  </p>
                ))}
            </div>
          )}
          {d['fl1-monolithic-costdown-roadmap'] && (
            <p className="mt-1 text-[9px] text-muted-foreground">
              cost-down: {d['fl1-monolithic-costdown-roadmap'].rule}
            </p>
          )}
          {d['fl1-i2c-pullup-checker-report'] && (
            <div className="mt-1 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1">
              <p className="text-[9px] text-destructive">
                I2C as-built:{' '}
                {d['fl1-i2c-pullup-checker-report'].scenarios.system_all_populated_AS_BUILT.classification}{' '}
                ({d['fl1-i2c-pullup-checker-report'].scenarios.system_all_populated_AS_BUILT.effective_ohm}
                Ω, {d['fl1-i2c-pullup-checker-report'].scenarios.system_all_populated_AS_BUILT.estimated_sink_ma_at_VOL}
                mA &gt; 3mA spec) — Rev B backplane-owner config:{' '}
                {d['fl1-i2c-pullup-checker-report'].scenarios.system_revb_backplane_owner.classification}{' '}
                ({d['fl1-i2c-pullup-checker-report'].scenarios.system_revb_backplane_owner.effective_ohm}Ω)
              </p>
              <p className="text-[8px] text-muted-foreground">
                {d['fl1-i2c-pullup-checker-report'].physical_compliance}
              </p>
            </div>
          )}
          {d['fl1-connector-orientation-checker-report'] && (
            <p className="mt-1 text-[9px] text-amber-500">
              connectors:{' '}
              {d['fl1-connector-orientation-checker-report'].connectors.filter(
                (c: any) => c.classification === 'unkeyed_review_required',
              ).length}{' '}
              unkeyed_review_required — first-article mitigation: pin-1 silk + checklist +
              inspection; Rev B: keyed shrouded headers
            </p>
          )}
          <a
            href={`/runs/${runId}/data/fl1-system-layout.svg`}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block text-[9px] text-primary underline"
          >
            system layout map (SVG)
          </a>
        </div>
      )}

      {/* Phase 18.8: Full-16 monolithic STRESS TEST — visibly a stress test */}
      {d['full16-monolithic-architecture-comparison'] && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="mb-1 text-[11px] font-semibold text-amber-500">
            STRESS TEST — Full-16 monolithic / no-Pico integration (not a product decision)
          </p>
          <div className="space-y-1">
            {d['full16-monolithic-architecture-comparison'].candidates.map(
              (c: any, i: number) => (
                <div key={i} className="rounded-md border border-border px-3 py-1">
                  <div className="flex items-center gap-2 text-[10px]">
                    <span className="font-mono text-primary">{c.id}</span>
                    <span className="text-foreground">{c.name}</span>
                    <span
                      className={`ml-auto rounded-sm border px-1.5 py-0.5 font-mono text-[8px] ${
                        c.hard_blockers?.length
                          ? 'border-destructive/40 bg-destructive/10 text-destructive'
                          : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                      }`}
                    >
                      {c.status}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[8px] text-muted-foreground">{c.evidence}</p>
                  {c.exact_blocker && (
                    <p className="mt-0.5 text-[8px] text-destructive">
                      blocker: {c.exact_blocker}
                    </p>
                  )}
                </div>
              ),
            )}
          </div>
          {d['full16-monolithic-treatment-classification'] && (
            <p className="mt-1 text-[9px] text-muted-foreground">
              16-function treatments:{' '}
              {Object.entries(d['full16-monolithic-treatment-classification'].counts)
                .filter(([, v]: [string, any]) => v > 0)
                .map(([k, v]: [string, any]) => `${k}: ${v}`)
                .join(' · ')}
            </p>
          )}
          {d['full16-monolithic-final-recommendation'] && (
            <p className="mt-1 text-[9px] text-emerald-500">
              recommendation: {d['full16-monolithic-final-recommendation'].recommendation} —{' '}
              {d['full16-monolithic-final-recommendation'].stress_test_verdict}
            </p>
          )}
          <p className="mt-1 text-[9px] text-muted-foreground">
            The six modular plugin boards remain valid, review-required, and not ordered.
          </p>
        </div>
      )}

      {/* Phase 18.6: PCM-1 — monitor-only claims, calibration dependency */}
      {d['pcm1-compose-report'] && (
        <div className="rounded-md border border-border p-3">
          <p className="mb-1 text-[11px] font-semibold text-foreground">
            PCM-1 Power/Current Monitor — {d['pcm1-compose-report'].verdict} (
            {d['pcm1-compose-report'].routing}, DRC {d['pcm1-compose-report'].drc_violations})
          </p>
          <p className="text-[10px] text-amber-500">
            MONITOR-ONLY · UNCALIBRATED until COTS or cal-board verification · not a DMM ·
            not a power supply · 0-24V / 0-500mA labeled limits
          </p>
          {d['pcm1-measurement-claim-model'] && (
            <p className="mt-1 text-[9px] text-muted-foreground">
              voltage: {d['pcm1-measurement-claim-model'].voltage.claims_before_calibration} ·
              current: {d['pcm1-measurement-claim-model'].current.claims_before_calibration}
            </p>
          )}
          <p className="mt-1 text-[9px] text-muted-foreground">
            {d['pcm1-compose-report'].mcu} · {d['pcm1-compose-report'].order}
          </p>
        </div>
      )}

      {/* Phase 18: architecture search — what to design NEXT */}
      {d['fl1-recommended-next-board-roadmap']?.after_batch1 && (
        <div className="rounded-md border border-border p-3">
          <p className="mb-1 text-[11px] font-semibold text-foreground">
            Architecture search — recommended next boards (after Batch 1)
          </p>
          <div className="space-y-0.5">
            {d['fl1-recommended-next-board-roadmap'].after_batch1.map((r: any, i: number) => (
              <p key={i} className="text-[10px] text-muted-foreground">
                <span className="font-mono text-primary">#{r.rank}</span>{' '}
                <span className="text-foreground">{r.board}</span> — {r.why}
                {r.needs !== 'nothing new — compose-ready' && (
                  <span className="text-amber-500"> · needs: {r.needs}</span>
                )}
              </p>
            ))}
          </div>
          {d['fl1-held-board-architecture-search']?.searches && (
            <div className="mt-1 flex flex-wrap gap-1">
              {Object.entries(d['fl1-held-board-architecture-search'].searches).map(
                ([t, s]: [string, any], i: number) => (
                  <span
                    key={i}
                    title={`recommended: ${s.recommended} · rejected: ${s.rejected.join(',') || 'none'}`}
                    className={`rounded-sm border px-1.5 py-0.5 font-mono text-[8px] ${
                      s.rejected.length
                        ? 'border-destructive/40 bg-destructive/10 text-destructive'
                        : 'border-border text-muted-foreground'
                    }`}
                  >
                    {t}: {s.recommended}
                    {s.rejected.length ? ` (✗${s.rejected.join(',')})` : ''}
                  </span>
                ),
              )}
            </div>
          )}
          <p className="mt-1 text-[9px] text-muted-foreground">
            hard blockers dominate scores · stays external COTS:{' '}
            {(d['fl1-recommended-next-board-roadmap'].stay_external_cots ?? []).join(', ')} · no
            precision/RF/scope claims without evidence
          </p>
        </div>
      )}

      {/* Phase 17: manufacturing readiness — quote-ready, human-gated */}
      {d['fl1-manufacturing-readiness-pack'] && (
        <div className="rounded-md border border-border p-3">
          <p className="mb-1 text-[11px] font-semibold text-foreground">
            Manufacturing readiness (Batch 1) — quote-ready, human approval pending
          </p>
          <div className="flex flex-wrap gap-1">
            {d['fl1-manufacturing-readiness-pack'].order_records?.records?.map(
              (o: any, i: number) => (
                <span
                  key={i}
                  title={`${o.board_name} qty ${o.quantity} — ${o.order_status}`}
                  className="rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] text-amber-500"
                >
                  {o.order_id}: {o.order_status}
                </span>
              ),
            )}
          </div>
          <p className="mt-1 text-[9px] text-muted-foreground">
            {d['fl1-manufacturing-readiness-pack'].risk_register?.length} risks registered ·
            substitution policy: no silent subs for reference/ADC/EEPROM/relays/connectors ·{' '}
            {d['fl1-manufacturing-readiness-pack'].honesty}
          </p>
        </div>
      )}

      {/* Phase 16.7: FA review v3 — addressing resolved, four-board decision */}
      {d['fl1-final-first-article-review-v3']?.boards?.length > 0 && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3">
          <p className="mb-1 text-[11px] font-semibold text-emerald-500">
            First-Article Review v3 — {d['fl1-final-first-article-review-v3'].batch_decision}
          </p>
          <div className="space-y-1">
            {d['fl1-final-first-article-review-v3'].boards.map((r: any, i: number) => (
              <div key={i} className="rounded-md border border-border px-3 py-1">
                <div className="flex items-center gap-2 text-[10px]">
                  <span className="text-foreground">{r.board_class}</span>
                  <span
                    className={`rounded-sm border px-1.5 py-0.5 text-[9px] ${
                      r.recommendation === 'order_3_pcba'
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                        : 'border-amber-500/40 bg-amber-500/10 text-amber-500'
                    }`}
                  >
                    {r.recommendation}
                  </span>
                  <span className="ml-auto font-mono text-[8px] text-muted-foreground">
                    {r.routing} · DRC {r.drc} · {r.role_completeness} · ID {r.eeprom_address}
                  </span>
                </div>
                <p className="mt-0.5 text-[8px] text-muted-foreground">{r.history}</p>
              </div>
            ))}
          </div>
          {d['fl1-board-id-addressing-strategy'] && (
            <p className="mt-1 text-[9px] text-muted-foreground">
              board-ID strategy: {d['fl1-board-id-addressing-strategy'].selected} —{' '}
              {d['fl1-board-id-addressing-strategy'].address_map} (
              {d['fl1-board-id-addressing-strategy'].limitation})
            </p>
          )}
          <p className="mt-1 text-[9px] text-muted-foreground">
            Human approval pending — Compose never orders or spends money.
          </p>
        </div>
      )}

      {/* Phase 16.6: final first-article review pack — the human decision artifact */}
      {d['fl1-first-article-review-pack']?.order_quantity_recommendation && (
        <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
          <p className="mb-1 text-[11px] font-semibold text-primary">
            Final First-Article Review — Batch 1 (human decision pending)
          </p>
          <div className="space-y-1">
            {d['fl1-first-article-review-pack'].order_quantity_recommendation.boards.map(
              (r: any, i: number) => (
                <div key={i} className="flex items-center gap-2 text-[10px]">
                  <span className="text-foreground">{r.board}</span>
                  <span
                    className={`rounded-sm border px-1.5 py-0.5 text-[9px] ${
                      r.recommendation === 'order_3_pcba'
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                        : 'border-amber-500/40 bg-amber-500/10 text-amber-500'
                    }`}
                  >
                    {r.recommendation}
                  </span>
                  <span className="ml-auto font-mono text-[8px] text-muted-foreground">
                    qty {r.quantity}
                  </span>
                </div>
              ),
            )}
          </div>
          {d['fl1-first-article-review-pack'].integration_review?.findings
            ?.filter((f: any) => f.status.includes('FLAG') || f.status.includes('CONFLICT'))
            .map((f: any, i: number) => (
              <p key={i} className="mt-1 text-[9px] text-amber-500">
                ⚠ {f.item}: {f.detail.slice(0, 110)}…
              </p>
            ))}
          <p className="mt-1 text-[9px] text-muted-foreground">
            Approval is a HUMAN fabrication decision — Compose provides evidence and
            recommendations but never spends money or submits orders automatically.
          </p>
        </div>
      )}

      {/* Phase 16.5: fine-grid fanout result — the cal board's physical verdict */}
      {d['calibration-board-finegrid-result'] && (
        <div
          className={`rounded-md border p-3 ${
            d['calibration-board-finegrid-result'].outcome === 'A_physical_pass'
              ? 'border-emerald-500/40 bg-emerald-500/5'
              : 'border-destructive/40 bg-destructive/5'
          }`}
        >
          <p className="mb-1 text-[11px] font-semibold text-foreground">
            Fine-grid fanout: {d['calibration-board-finegrid-result'].board} —{' '}
            <span
              className={
                d['calibration-board-finegrid-result'].outcome === 'A_physical_pass'
                  ? 'text-emerald-500'
                  : 'text-destructive'
              }
            >
              {d['calibration-board-finegrid-result'].outcome}
            </span>
          </p>
          <p className="font-mono text-[10px] text-muted-foreground">
            {d['calibration-board-finegrid-result'].routing} nets ·{' '}
            {d['calibration-board-finegrid-result'].drc_violations} DRC ·{' '}
            {d['calibration-board-finegrid-result'].unconnected} unconn · escape{' '}
            {d['calibration-board-finegrid-result'].ads1115_escape}
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {d['calibration-board-finegrid-result'].previous_blocker} →{' '}
            {d['calibration-board-finegrid-result'].previous_blocker_status} · build:{' '}
            <span className="text-amber-500">
              {d['calibration-board-finegrid-result'].build_recommendation}
            </span>{' '}
            · order: {d['calibration-board-finegrid-result'].order_recommendation}
          </p>
          {d['via-in-pad-feasibility-report'] && (
            <p className="mt-1 text-[9px] text-muted-foreground">
              via-in-pad: {d['via-in-pad-feasibility-report'].status} —{' '}
              {d['via-in-pad-feasibility-report'].reason}
            </p>
          )}
          {d['batch1-stability-report'] && (
            <p className="mt-0.5 text-[9px] text-muted-foreground">
              Batch 1 v2 stability: {d['batch1-stability-report'].all_stable ? 'unchanged, still review-required, not ordered' : 'CHANGED — inspect'}
            </p>
          )}
        </div>
      )}

      {/* Phase 16: traceability — serials, lifecycle, calibration state, evidence */}
      {d['fl1-batch1-serial-plan']?.serials?.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Batch 1 traceability ({d['fl1-batch1-serial-plan'].serials.length} serials ·{' '}
            {d['fl1-batch1-serial-plan'].batch_id})
          </p>
          <div className="flex flex-wrap gap-1">
            {d['fl1-batch1-serial-plan'].serials.map((s: any, i: number) => (
              <span
                key={i}
                title={`${s.board_name} — ${s.current_lifecycle_state} — cal: ${s.board_id_eeprom_fields?.cal_state}`}
                className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground"
              >
                {s.serial_number} · {s.board_id_eeprom_fields?.cal_state}
              </span>
            ))}
          </div>
          <p className="mt-1 text-[9px] text-muted-foreground">
            lifecycle: first_article_review_required · all channels uncalibrated (no physical
            calibration exists until real evidence exists)
          </p>
        </div>
      )}

      {/* Phase 16: demo evidence (all simulated) + redesign loop */}
      {d['phase16-demo-runs']?.demos?.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Traceability demos ({d['phase16-demo-runs'].demo_count} · all simulated)
          </p>
          <div className="space-y-1">
            {d['phase16-demo-runs'].demos.map((dm: any, i: number) => (
              <div key={i} className="flex items-center gap-2 rounded-md border border-border px-3 py-1">
                <span className="text-[10px] text-foreground">{dm.demo}</span>
                <span
                  className={`rounded-sm border px-1.5 py-0.5 text-[9px] ${
                    dm.final_verdict === 'do_not_calibrate_physical'
                      ? 'border-destructive/50 bg-destructive/15 font-semibold text-destructive'
                      : dm.final_verdict === 'simulated_fail'
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-500'
                        : 'border-sky-500/40 bg-sky-500/10 text-sky-400'
                  }`}
                >
                  {dm.final_verdict}
                </span>
                {dm.redesign_recommendation && (
                  <span className="ml-auto font-mono text-[9px] text-amber-500">
                    → {dm.redesign_recommendation.recommendation_type} (human review)
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Phase 16: held boards stay visibly held */}
      {d['phase16-held-board-status']?.boards?.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Held boards ({d['phase16-held-board-status'].boards.length})
          </p>
          <div className="space-y-0.5">
            {d['phase16-held-board-status'].boards.map((h: any, i: number) => (
              <p key={i} className="text-[9px] text-muted-foreground">
                <span className="text-destructive">{h.board}</span>: {h.why_held} — needs{' '}
                {h.missing_capability}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* role completeness (Phase 15.6) — DRC-clean is not enough */}
      {d['role-completeness-report'] && (
        <div
          className={`rounded-md border p-3 ${
            d['role-completeness-report'].status === 'role_incomplete'
              ? 'border-destructive/40 bg-destructive/5'
              : 'border-emerald-500/40 bg-emerald-500/5'
          }`}
        >
          <p className="mb-1 text-[11px] font-semibold text-foreground">
            Role completeness: {d['role-completeness-report'].role} —{' '}
            <span
              className={
                d['role-completeness-report'].status === 'role_incomplete'
                  ? 'text-destructive'
                  : 'text-emerald-500'
              }
            >
              {d['role-completeness-report'].status}
            </span>{' '}
            ({d['role-completeness-report'].requirements_met}/
            {d['role-completeness-report'].requirements_checked})
          </p>
          {d['role-completeness-report'].missing?.length > 0 && (
            <p className="text-[10px] text-destructive">
              missing: {d['role-completeness-report'].missing.join('; ')}
            </p>
          )}
          {d['role-completeness-report'].caveats?.length > 0 && (
            <p className="text-[10px] text-amber-500">
              caveats: {d['role-completeness-report'].caveats.join('; ')}
            </p>
          )}
          <p className="mt-1 text-[9px] text-muted-foreground">
            A DRC-clean but role-incomplete board is rejected for order.
          </p>
        </div>
      )}

      {/* first-article review v2 (regenerated batch) */}
      {d['phase15-first-article-review-v2']?.boards?.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            First-article review v2 — {d['phase15-first-article-review-v2'].batch_decision}
          </p>
          <div className="space-y-1">
            {d['phase15-first-article-review-v2'].boards.map((b: any, i: number) => (
              <div key={i} className="rounded-md border border-border px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-foreground">{b.board_class}</span>
                  <span
                    className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${
                      b.recommendation?.startsWith('order')
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                        : 'border-amber-500/40 bg-amber-500/10 text-amber-500'
                    }`}
                  >
                    {b.recommendation}
                  </span>
                  <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                    {b.routing} · DRC {b.drc_violations} · {b.role_completeness}
                  </span>
                </div>
                {b.known_limitations?.length > 0 && (
                  <p className="mt-0.5 text-[9px] text-muted-foreground">
                    limits: {b.known_limitations.join('; ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Phase 15 build/order decisions — order-ready vs held, review flags */}
      {d['phase15-board-readiness-dashboard']?.boards?.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Phase 15 build batch ({d['phase15-board-readiness-dashboard'].board_count})
          </p>
          <div className="space-y-1">
            {d['phase15-board-readiness-dashboard'].boards.map((b: any, i: number) => (
              <div key={i} className="rounded-md border border-border px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-foreground">{b.board_class ?? b.board}</span>
                  <span
                    className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${
                      b.order_recommendation === 'do_not_order' || b.order_recommendation === 'unsupported'
                        ? 'border-destructive/50 bg-destructive/15 font-semibold text-destructive'
                        : b.package_type === 'order_ready_pcba_package'
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                          : 'border-amber-500/40 bg-amber-500/10 text-amber-500'
                    }`}
                  >
                    {b.order_recommendation}
                  </span>
                  {b.human_review_required && (
                    <span className="rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-500">
                      review
                    </span>
                  )}
                  {b.first_article_review && (
                    <span className="rounded-sm border border-amber-500/50 bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-amber-500">
                      FA: {b.first_article_review}
                    </span>
                  )}
                  <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                    {b.package_type?.replace(/_package$/, '')}
                    {b.order_pack_valid ? ' · pack ✓' : ''}
                  </span>
                </div>
                {b.review_note && (
                  <p className="mt-0.5 text-[10px] text-amber-500">{b.review_note}</p>
                )}
                {b.held_reason && (
                  <p className="mt-0.5 text-[10px] text-destructive">held: {b.held_reason}</p>
                )}
              </div>
            ))}
          </div>
          <p className="mt-1 text-[9px] text-muted-foreground">
            green = order-ready PCBA (with first-article review) · amber = design-attempt/architecture
            only · red = do_not_order / unsupported. Only evidence-safe boards get an order package.
          </p>
        </div>
      )}

      {/* FL-1 Instrument Core v1 (Phase 15) — the buildable core */}
      {d['fl1-instrument-core-v1']?.boards?.length > 0 && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3">
          <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-emerald-500">
            <Cpu className="size-3.5" /> FL-1 Instrument Core v1 —{' '}
            {d['fl1-instrument-core-v1'].core_status} ({d['fl1-instrument-core-v1'].board_count} boards)
          </p>
          <div className="space-y-1">
            {d['fl1-instrument-core-v1'].boards.map((b: any, i: number) => (
              <div key={i} className="flex items-center gap-2 text-[10px]">
                <span className="text-foreground">{b.name}</span>
                <span className="rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-500">
                  {b.build_result.build_recommendation}
                </span>
                <span className="font-mono text-[9px] text-muted-foreground">
                  {b.build_result.routed} · {b.build_result.drc_violations} DRC · {b.role}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[9px] text-muted-foreground">
            All core boards route clean (0 DRC) and are ready to fabricate. Adapters are
            future_internal_board (mock-validatable now, physical after fab).
          </p>
          {d['fl1-instrument-core-v1'].excluded_from_core?.length > 0 && (
            <p className="mt-1 text-[10px] text-destructive">
              excluded: {d['fl1-instrument-core-v1'].excluded_from_core[0].board} —{' '}
              {d['fl1-instrument-core-v1'].excluded_from_core[0].reason}
            </p>
          )}
        </div>
      )}

      {/* validation readiness (Phase 14) — mock vs COTS vs internal, physical-blocked */}
      {d['fl1-validation-readiness-dashboard']?.boards?.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Validation readiness ({d['fl1-validation-readiness-dashboard'].board_count})
          </p>
          <div className="space-y-1">
            {d['fl1-validation-readiness-dashboard'].boards.map((b: any, i: number) => (
              <div key={i} className="rounded-md border border-border px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-foreground">{b.board_class ?? b.board}</span>
                  <span
                    className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${
                      b.validation_readiness_status === 'unsupported'
                        ? 'border-destructive/50 bg-destructive/15 font-semibold text-destructive'
                        : b.physical_validation_blocked
                          ? 'border-amber-500/40 bg-amber-500/10 text-amber-500'
                          : b.validation_readiness_status?.includes('cots')
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                            : 'border-sky-500/40 bg-sky-500/10 text-sky-400'
                    }`}
                  >
                    {b.validation_readiness_status}
                  </span>
                  {b.physical_validation_blocked && (
                    <span className="rounded-sm border border-destructive/50 bg-destructive/15 px-1.5 py-0.5 text-[9px] font-semibold text-destructive">
                      physical blocked
                    </span>
                  )}
                  <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                    build {b.build_recommendation}
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-[9px] text-muted-foreground">
                  adapters: mock{b.external_cots_alternatives?.length ? ' + cots' : ''}
                  {b.internal_board_future_adapter ? ' + internal(future)' : ''}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[9px] text-muted-foreground">
            amber = physical validation blocked (mock/simulated only) · sky = mock/logic only · green
            = COTS-validatable now. Simulated evidence is never physical evidence.
          </p>
        </div>
      )}

      {/* mock demo runs — simulated evidence must be visibly simulated */}
      {d['demo-validation-runs']?.runs?.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Mock validation demos ({d['demo-validation-runs'].run_count})
          </p>
          <div className="flex flex-wrap gap-1">
            {d['demo-validation-runs'].runs.map((r: any, i: number) => (
              <span
                key={i}
                title={`${r.workflow_name} — ${r.physical_validation}`}
                className="rounded-sm border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[9px] text-sky-400"
              >
                ◈sim {r.board_id}: {r.final_verdict}
              </span>
            ))}
          </div>
          <p className="mt-1 text-[9px] text-muted-foreground">
            ◈sim = simulated (mock) evidence only, never a physical pass.
          </p>
        </div>
      )}

      {/* build-readiness dashboard (Phase 13 D-F) — the honest per-board verdict */}
      {d['fl1-build-readiness-dashboard']?.boards?.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Build readiness ({d['fl1-build-readiness-dashboard'].board_count})
          </p>
          <div className="space-y-1">
            {d['fl1-build-readiness-dashboard'].boards.map((b: any, i: number) => (
              <div key={i} className="rounded-md border border-border px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-foreground">{b.board_class}</span>
                  <span
                    className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${
                      b.recommendation === 'do_not_build' || b.recommendation === 'unsupported'
                        ? 'border-destructive/50 bg-destructive/15 font-semibold text-destructive'
                        : b.recommendation?.startsWith('ready')
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                          : 'border-amber-500/40 bg-amber-500/10 text-amber-500'
                    }`}
                  >
                    {b.recommendation}
                  </span>
                  <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                    bench {b.benchmark_status}
                    {b.fine_pitch_escape !== 'n/a' ? ` · fp ${b.fine_pitch_escape}` : ''}
                  </span>
                </div>
                {b.exact_blockers?.length > 0 && (
                  <p className="mt-0.5 text-[10px] text-destructive">{b.exact_blockers[0]}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* curated reference library — trust / reuse must be obvious */}
      {d['fl1-curated-reference-library']?.references?.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Reference library ({d['fl1-curated-reference-library'].internal_count} internal ·{' '}
            {d['fl1-curated-reference-library'].external_count} external)
          </p>
          <div className="flex flex-wrap gap-1">
            {d['fl1-curated-reference-library'].references.map((r: any, i: number) => (
              <span
                key={i}
                title={`${r.name} — reuse=${r.direct_reuse} — ${r.status}`}
                className={`rounded-sm border px-1.5 py-0.5 font-mono text-[9px] ${
                  r.trust_classification === 'internal_firstlight'
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                    : r.trust_classification === 'open_source_needs_license_review'
                      ? 'border-destructive/40 bg-destructive/10 text-destructive'
                      : r.trust_classification === 'idea_only'
                        ? 'border-destructive/40 bg-destructive/10 text-destructive'
                        : 'border-amber-500/40 bg-amber-500/10 text-amber-500'
                }`}
              >
                {r.trust_classification === 'internal_firstlight' ? '✓reuse' : '⌀no-reuse'} {r.name}
              </span>
            ))}
          </div>
          <p className="mt-1 text-[9px] text-muted-foreground">
            green = internal (reusable) · amber = manufacturer (reference-only) · red = open-source
            needs license review / idea-only. External references are never directly reused.
          </p>
        </div>
      )}

      {/* fine-pitch escape model (Phase 13) — the real physical gate */}
      {d['fine-pitch-escape-model']?.components?.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Fine-pitch escape ({d['fine-pitch-escape-model'].fine_pitch_component_count} · grid{' '}
            {d['fine-pitch-escape-model'].grid_pitch_mm}mm)
          </p>
          <div className="space-y-1">
            {d['fine-pitch-escape-model'].components.map((c: any, i: number) => (
              <div key={i} className="rounded-md border border-border px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-foreground">{c.mpn}</span>
                  <span className="rounded-sm border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {c.package} {c.pin_pitch_mm}mm
                  </span>
                  <span
                    className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${
                      c.expected_difficulty === 'unsupported_escape'
                        ? 'border-destructive/40 bg-destructive/10 text-destructive'
                        : c.expected_difficulty === 'dense_escape'
                          ? 'border-amber-500/40 bg-amber-500/10 text-amber-500'
                          : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                    }`}
                  >
                    {c.expected_difficulty}
                  </span>
                  <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                    {c.escape_count} escapes
                  </span>
                </div>
                {c.blocker && <p className="mt-0.5 text-[10px] text-destructive">{c.blocker}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* shared-bus status (Phase 12.5) — multi-drop I2C / SPI fanout model */}
      {d['shared-bus-report']?.buses?.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Shared buses ({d['shared-bus-report'].bus_count})
          </p>
          <div className="space-y-1">
            {d['shared-bus-report'].buses.map((bus: any, i: number) => (
              <div key={i} className="rounded-md border border-border px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-foreground">{bus.name}</span>
                  <span className="rounded-sm border border-border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                    {bus.type}
                  </span>
                  <span
                    className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${
                      bus.routing_status === 'connected'
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                        : bus.routing_status?.includes('warning')
                          ? 'border-amber-500/40 bg-amber-500/10 text-amber-500'
                          : 'border-border text-muted-foreground'
                    }`}
                  >
                    {bus.routing_status}
                  </span>
                  <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                    {bus.device_count} dev · fanout {bus.fanout_count}
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  source: {bus.source} · nets: {(bus.required_nets ?? []).join(', ')}
                  {bus.routed_connections
                    ? ' · routed: ' +
                      Object.entries(bus.routed_connections)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(' ')
                    : ''}
                </div>
                <div className="text-[9px] text-muted-foreground">{bus.topology}</div>
                {(bus.problems ?? [])
                  .filter((p: any) => p.severity === 'error')
                  .slice(0, 2)
                  .map((p: any, j: number) => (
                    <p key={j} className="mt-0.5 text-[10px] text-destructive">
                      {p.code}: {p.detail}
                    </p>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* board family readiness ranking */}
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
          Board family readiness ({fam.boards?.length ?? 0})
        </p>
        <div className="space-y-1">
          {(fam.boards ?? []).map((b: any, i: number) => (
            <div key={i} className="rounded-md border border-border px-3 py-1.5">
              <div className="flex items-center gap-2">
                <span className="text-foreground">{b.name}</span>
                <span
                  className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${
                    R_STYLE[b.readiness] ?? 'border-border text-muted-foreground'
                  }`}
                >
                  {b.readiness}
                </span>
                <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                  {b.manufacturing}
                </span>
              </div>
              {b.blockers?.length > 0 && (
                <div className="mt-0.5 flex items-start gap-1 text-[10px] text-muted-foreground">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0 text-amber-500" />
                  {b.blockers.join('; ')}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* starter statuses (honesty front and center) */}
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
          Starter capability status
        </p>
        <div className="space-y-1">
          {starters.map(([name, rep]) =>
            rep ? (
              <div key={name} className="rounded-md border border-border px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-foreground">{name}</span>
                  <span
                    className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${
                      R_STYLE[rep.status] ?? 'border-border text-muted-foreground'
                    }`}
                  >
                    {rep.status}
                  </span>
                </div>
                {rep.honesty && (
                  <div className="mt-0.5 text-[10px] text-amber-500">
                    {Object.values(rep.honesty).join(' · ')}
                  </div>
                )}
                {rep.unsupported && (
                  <div className="mt-0.5 font-mono text-[9px] text-destructive">
                    {Object.keys(rep.unsupported).filter((k) => rep.unsupported[k]).join(', ')}
                  </div>
                )}
              </div>
            ) : null,
          )}
        </div>
      </div>

      {/* pattern readiness summary */}
      {d['fl1-reference-pattern-readiness'] && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Reference pattern readiness
          </p>
          <div className="flex flex-wrap gap-1 font-mono text-[10px]">
            {Object.entries(d['fl1-reference-pattern-readiness'].summary ?? {}).map(([k, v]) => (
              <span key={k} className="rounded-sm border border-border px-1.5 py-0.5 text-muted-foreground">
                {k}: {String(v)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* instrument bus */}
      {d['fl1-instrument-bus-v1'] && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            FL-1 instrument bus ({d['fl1-instrument-bus-v1'].version})
          </p>
          <div className="font-mono text-[10px] text-muted-foreground">
            rails: {(d['fl1-instrument-bus-v1'].power_rails ?? []).join(', ')} · protected:{' '}
            {(d['fl1-instrument-bus-v1'].protected_rails ?? []).join(', ')} · control:{' '}
            {(d['fl1-instrument-bus-v1'].control_bus_options ?? []).join('/')}
          </div>
        </div>
      )}
    </div>
  )
}
