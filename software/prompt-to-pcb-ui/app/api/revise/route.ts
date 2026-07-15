/**
 * Spec-level board revision, "swap the RP2040 for an STM32", "add a pressure
 * sensor", "drop the GNSS".
 *
 * POST {runId, request} → loads the parent run's compose spec, has the LLM
 * apply the change AT THE SPEC LEVEL (block list, not copper), and returns the
 * revised spec + a one-line revision note. The client then launches a normal
 * pipeline run with parent lineage, the whole board regenerates
 * deterministically from the new spec, and the diff vs the parent's BOM shows
 * exactly what moved. This is the scoped, honest version of interactive
 * editing: covers block swaps/adds/drops today; copper-level edits stay in
 * KiCad round-trip.
 */
import fs from 'node:fs'
import path from 'node:path'
import { callLLMText, overrideFromHeaders } from '@/lib/llm'
import { isValidRunId, runAccess } from '@/lib/auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const SYSTEM = `detailed thinking off.
You are a hardware architect revising a PCB design spec. A board is defined by
its BLOCK LIST (plain-language functional blocks) and a short board_class name.
Apply the user's change request to the block list:
- keep every block the user did not ask to change, verbatim
- add / remove / replace only what the request requires
- blocks are plain language ("pressure sensor", "usb-c power", "stm32 mcu")
- if the request is unclear or impossible at block level, say so in "note"
  and return the original blocks unchanged

Output ONLY one minified JSON object:
{"blocks":["..."],"board_class":"<short name>","note":"<one sentence: what changed and why>","changed":true|false}`

function extractJson(raw: string): string {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  let idx = text.indexOf('{')
  let attempts = 0
  while (idx >= 0 && attempts < 40) {
    let depth = 0
    let inStr = false
    let esc = false
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
            if (o && typeof o === 'object' && 'blocks' in o) return cand
          } catch {
            /* next */
          }
          break
        }
      }
    }
    idx = text.indexOf('{', idx + 1)
    attempts++
  }
  throw new Error('no valid revision JSON in model reply')
}

export async function POST(req: Request) {
  let body: { runId?: string; request?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const id = String(body.runId ?? '')
  const request = String(body.request ?? '').trim()
  if (!isValidRunId(id) || !request) {
    return Response.json({ error: 'runId and request required' }, { status: 400 })
  }
  const auth = runAccess(req, id)
  if (auth.access === 'unauthenticated') {
    return Response.json({ error: 'sign in required' }, { status: 401 })
  }
  if (auth.access === 'forbidden') {
    return Response.json({ error: 'not your board' }, { status: 403 })
  }

  const lastRunPath = path.join(process.cwd(), 'public/runs', id, 'data/last-run.json')
  let parent: { prompt?: string; composeSpec?: { blocks?: string[]; boardClass?: string } }
  try {
    parent = JSON.parse(fs.readFileSync(lastRunPath, 'utf8'))
  } catch {
    return Response.json(
      { error: 'parent run has no revisable spec (compose runs only)' },
      { status: 404 },
    )
  }
  const blocks = parent.composeSpec?.blocks
  if (!Array.isArray(blocks) || !blocks.length) {
    return Response.json(
      { error: 'parent run has no compose block list to revise' },
      { status: 422 },
    )
  }

  const userMsg =
    `CURRENT DESIGN\nboard_class: ${parent.composeSpec?.boardClass ?? 'custom board'}\n` +
    `blocks: ${JSON.stringify(blocks)}\noriginal prompt: ${parent.prompt ?? ''}\n\n` +
    `CHANGE REQUEST\n${request}`

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
    if (parsed === null) throw new Error(lastFail || 'no valid revision')
    const rev = JSON.parse(parsed) as {
      blocks: string[]
      board_class?: string
      note?: string
      changed?: boolean
    }
    return Response.json({
      parentId: id,
      blocks: rev.blocks,
      boardClass: rev.board_class ?? parent.composeSpec?.boardClass ?? 'custom board',
      note: rev.note ?? request,
      changed: rev.changed !== false,
      prompt: `${parent.prompt ?? 'board'}, rev: ${request}`,
    })
  } catch (err) {
    return Response.json({ error: `revision failed: ${String(err)}` }, { status: 500 })
  }
}
