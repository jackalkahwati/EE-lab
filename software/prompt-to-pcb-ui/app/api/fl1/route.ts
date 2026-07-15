/**
 * FL-1 closed-loop demo: simulate a machine run against the board's own
 * fl1-testplan.json, then diagnose the measurements and propose the ECO.
 *
 * POST {runId, scenario} →
 *   1. simulate: per-testplan-measurement values. 'pass' = nominal with bench
 *      noise; failure scenarios inject a realistic defect signature.
 *   2. diagnose: LLM (grounded in the test plan, measurements, and BOM) writes
 *      the verdict, root-cause hypothesis, and a change-request ECO the
 *      /api/revise flow can turn into Rev B.
 *
 * This is the loop contract: when the physical FL-1 exists it replaces step 1
 * with real probe data, nothing downstream changes. Until then the demo runs
 * on simulated measurements, clearly labeled as such.
 */
import fs from 'node:fs'
import path from 'node:path'
import { callLLMText, overrideFromHeaders } from '@/lib/llm'
import { isValidRunId, runAccess } from '@/lib/auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 180

const SCENARIOS: Record<string, string> = {
  pass: 'all measurements nominal',
  fail_3v3_sag: '+3V3 rail sags to ~2.3V under load (regulator/overload signature)',
  fail_rail_short: 'pre-power screen finds +3V3 near-short to GND (~2Ω)',
  fail_dead_bus: 'rails good but SPI clock shows no activity (firmware/strapping signature)',
}

interface Measurement {
  point: string
  net: string
  type: string
  expected: string
  measured: string
  pass: boolean
}

function simulate(plan: Record<string, unknown>, scenario: string): Measurement[] {
  const out: Measurement[] = []
  const noise = () => (Math.random() - 0.5) * 0.04

  for (const pre of (plan.pre_power as Record<string, unknown>[]) ?? []) {
    const between = pre.between as string[]
    const shorted = scenario === 'fail_rail_short' && between?.[0] === '+3V3'
    const val = shorted ? 2.1 : 47000 + Math.random() * 30000
    out.push({
      point: 'pre-power',
      net: between?.join(' ↔ ') ?? '?',
      type: 'resistance',
      expected: `≥ ${pre.min_ohm} Ω`,
      measured: val >= 1000 ? `${(val / 1000).toFixed(1)} kΩ` : `${val.toFixed(1)} Ω`,
      pass: val >= Number(pre.min_ohm ?? 10),
    })
  }
  // a hard pre-power fail halts the sequence, the machine never powers the DUT
  if (out.some((m) => !m.pass)) return out

  for (const m of (plan.measurements as Record<string, unknown>[]) ?? []) {
    const net = String(m.net ?? '')
    const type = String(m.type ?? '')
    if (type === 'dc_voltage') {
      const nominal = Number(m.expect_v ?? ((Number(m.min_v ?? 0) + Number(m.max_v ?? 3.3)) / 2))
      let v = nominal + noise()
      if (scenario === 'fail_3v3_sag' && net === '+3V3') v = 2.31 + noise()
      // a sagging 3V3 drags every 3V3-idled control line down with it
      if (scenario === 'fail_3v3_sag' && (net.endsWith('_NSS') || net.endsWith('_RST'))) v = 2.28 + noise()
      const lo = m.min_v !== undefined ? Number(m.min_v) : nominal - 0.3
      const hi = m.max_v !== undefined ? Number(m.max_v) : nominal + 0.3
      out.push({
        point: String(m.point), net, type,
        expected: `${lo.toFixed(2)}-${hi.toFixed(2)} V`,
        measured: `${v.toFixed(2)} V`,
        pass: v >= lo && v <= hi,
      })
    } else if (type === 'continuity') {
      out.push({
        point: String(m.point), net, type,
        expected: `≤ ${m.max_ohm} Ω to ${m.to}`,
        measured: `${(0.1 + Math.random() * 0.3).toFixed(2)} Ω`,
        pass: true,
      })
    } else if (type === 'digital_activity') {
      const dead =
        (scenario === 'fail_dead_bus' && net === 'SPI_SCK') ||
        (scenario === 'fail_3v3_sag' && net.startsWith('SPI'))
      out.push({
        point: String(m.point), net, type,
        expected: String(m.expect ?? 'toggling'),
        measured: dead ? 'stuck low, no edges in 500 ms window' : 'toggling (edges detected)',
        pass: !dead,
      })
    }
  }
  return out
}

const SYSTEM = `detailed thinking off.
You are the FL-1 autonomous bring-up machine's diagnosis engine. You are given a
board's test plan, the measurements just taken, and its BOM. Determine what
failed and why, reasoning ONLY from the given data.

Output ONLY one minified JSON object:
{"verdict":"PASS"|"FAIL",
 "failed_points":["TPx",...],
 "diagnosis":"<what the measurements show, 2-3 sentences, cite values>",
 "root_cause":"<most likely physical cause, one sentence>",
 "eco":"<one-sentence design change request suitable for a revision, or empty string if no design change is warranted>"}`

function extractJson(raw: string): string {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  let idx = text.indexOf('{')
  let n = 0
  while (idx >= 0 && n < 40) {
    let depth = 0, inStr = false, esc = false
    for (let i = idx; i < text.length; i++) {
      const ch = text[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
      } else if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          const cand = text.slice(idx, i + 1)
          try {
            const o = JSON.parse(cand)
            if (o && typeof o === 'object' && 'verdict' in o) return cand
          } catch { /* next */ }
          break
        }
      }
    }
    idx = text.indexOf('{', idx + 1)
    n++
  }
  throw new Error('no valid diagnosis JSON in model reply')
}

export async function POST(req: Request) {
  let body: { runId?: string; scenario?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const id = String(body.runId ?? '')
  const scenario = SCENARIOS[body.scenario ?? ''] ? String(body.scenario) : 'pass'
  if (!isValidRunId(id)) {
    return Response.json({ error: 'valid runId required' }, { status: 400 })
  }
  const auth = runAccess(req, id)
  if (auth.access === 'unauthenticated') {
    return Response.json({ error: 'sign in required' }, { status: 401 })
  }
  if (auth.access === 'forbidden') {
    return Response.json({ error: 'not your board' }, { status: 403 })
  }

  const dataDir = path.join(process.cwd(), 'public/runs', id, 'data')
  let plan: Record<string, unknown>
  try {
    plan = JSON.parse(fs.readFileSync(path.join(dataDir, 'fl1-testplan.json'), 'utf8'))
  } catch {
    return Response.json(
      { error: 'this run has no FL-1 test plan (generated on PASSED compose runs)' },
      { status: 404 },
    )
  }

  const measurements = simulate(plan, scenario)
  const anyFail = measurements.some((m) => !m.pass)

  let bom = ''
  try {
    bom = fs.readFileSync(path.join(dataDir, 'bom.json'), 'utf8')
  } catch { /* optional */ }

  const userMsg =
    `TEST PLAN (probe map + limits):\n${JSON.stringify(plan)}\n\n` +
    `MEASUREMENTS (simulated FL-1 run):\n${JSON.stringify(measurements)}\n\nBOM:\n${bom}`

  try {
    const override = overrideFromHeaders(req.headers)
    let parsed: string | null = null
    let lastFail = ''
    for (let attempt = 0; attempt < 2 && parsed === null; attempt++) {
      try {
        const r = await callLLMText(SYSTEM, userMsg, { model: 'claude-sonnet-5', ...override })
        parsed = extractJson(r.text)
      } catch (e) {
        lastFail = String(e)
      }
    }
    if (parsed === null) throw new Error(lastFail || 'no valid diagnosis')
    const diag = JSON.parse(parsed)
    return Response.json({
      scenario,
      scenarioLabel: SCENARIOS[scenario],
      simulated: true,
      measurements,
      anyFail,
      ...diag,
    })
  } catch (err) {
    return Response.json({ error: `diagnosis failed: ${String(err)}` }, { status: 500 })
  }
}
