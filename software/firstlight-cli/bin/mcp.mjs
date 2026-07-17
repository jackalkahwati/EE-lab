#!/usr/bin/env node
/**
 * firstlight-mcp — FirstLight Compose as MCP tools (stdio).
 *
 * Lets any MCP client (Claude Code, Cursor, Claude Desktop) drive the real
 * prompt-to-product pipeline: create a board build, poll its stages, and pull
 * the produced artifacts (gerber package, STEP, GLB, schematic, BOM, reports).
 *
 * Claude Code registration:
 *   claude mcp add firstlight -e FIRSTLIGHT_API_KEY=flk_live_… -- npx firstlight-mcp
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { FirstlightClient } from '../lib/client.mjs'

const client = new FirstlightClient({})

const server = new McpServer({ name: 'firstlight', version: '0.1.0' })

const jsonResult = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] })
const errResult = (e) => ({ content: [{ type: 'text', text: `error: ${e?.message ?? e}` }], isError: true })

server.tool(
  'create_board',
  'Start a FirstLight Compose build: a natural-language product prompt becomes a real routed PCBA (KiCad, DRC-gated), an enclosure (Onshape CAD), simulations (FEM/3D FEA), firmware and manufacturing docs. Returns a runId immediately; a full build takes ~7 minutes — poll board_status.',
  { prompt: z.string().min(8).max(2000).describe('what to build, e.g. "USB-C powered desk presence puck with a 60GHz radar module and an LED ring"') },
  async ({ prompt }) => {
    try { return jsonResult(await client.createBoard(prompt)) } catch (e) { return errResult(e) }
  },
)

server.tool(
  'import_design',
  'Start a FirstLight product from an EXISTING design instead of a prompt: upload a PCBA (.kicad_pcb) and/or a CAD assembly (.step) already on disk. The board is verified with real KiCad DRC on ingest (it wears no green until it passes against YOUR file); the assembly lands as geometry with its fit check pending. Returns the new run/product ids. Provide at least one of pcbPath / stepPath.',
  {
    pcbPath: z.string().optional().describe('local path to a .kicad_pcb PCBA file'),
    stepPath: z.string().optional().describe('local path to a .step CAD assembly file'),
    name: z.string().optional().describe('name for the imported product'),
  },
  async ({ pcbPath, stepPath, name }) => {
    try { return jsonResult(await client.importDesign({ pcbPath, stepPath, name })) } catch (e) { return errResult(e) }
  },
)

server.tool(
  'board_status',
  'Status of a build run: queued/running/complete/failed, per-stage progress (electronics, mechanical, simulation, firmware, manufacturing, supply chain, validation), the honest electronics verdict (DRC state), and timing.',
  { runId: z.string().describe('run id returned by create_board') },
  async ({ runId }) => {
    try { return jsonResult(await client.runStatus(runId)) } catch (e) { return errResult(e) }
  },
)

server.tool(
  'list_artifacts',
  'List the artifacts a run actually produced (only files that exist): spec, board, schematic, layout, pcb, fab-package (gerbers+assembly zip), step, glb, mechanical, firmware, bom, simulation, manufacturing, supply-chain, validation, id-brief, concept-render, timing.',
  { runId: z.string() },
  async ({ runId }) => {
    try { return jsonResult(await client.listArtifacts(runId)) } catch (e) { return errResult(e) }
  },
)

server.tool(
  'get_artifact',
  'Download one artifact to a local file (binary-safe). For small JSON/SVG artifacts omit outPath to get the content inline instead.',
  {
    runId: z.string(),
    kind: z.string().describe('artifact kind from list_artifacts, e.g. "step", "fab-package", "simulation"'),
    outPath: z.string().optional().describe('local file path to write; required for binary artifacts (zip/step/glb/images)'),
  },
  async ({ runId, kind, outPath }) => {
    try {
      if (outPath) return jsonResult(await client.downloadArtifact(runId, kind, outPath))
      const r = await fetch(`${client.baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(kind)}`, {
        headers: { authorization: `Bearer ${client.apiKey}` },
      })
      if (!r.ok) {
        const d = await r.json().catch(() => null)
        throw new Error(d?.error ?? `HTTP ${r.status}`)
      }
      const mime = r.headers.get('content-type') ?? ''
      if (!/json|svg|text|csv/.test(mime)) {
        throw new Error(`'${kind}' is binary (${mime}) — pass outPath to save it to a file`)
      }
      return { content: [{ type: 'text', text: await r.text() }] }
    } catch (e) { return errResult(e) }
  },
)

server.tool(
  'list_boards',
  'List the enterprise board portfolio visible to this API key.',
  {},
  async () => {
    try { return jsonResult(await client.listBoards()) } catch (e) { return errResult(e) }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
