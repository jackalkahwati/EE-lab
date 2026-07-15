/**
 * Product comments (Phase 5) — threads anchored to artifacts, stored per
 * product in data/comments/<productId>.json. Anchors are short strings the
 * UI standardizes ('rev:<runId>', 'bom:C3', 'mech:fitCheck', 'sim:thermal'),
 * so a comment stays attached to the thing it's about across revisions.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export type Comment = {
  id: string
  runId: string
  anchor: string
  author: string
  text: string
  createdAt: string
}

const DIR = path.join(process.cwd(), 'data', 'comments')

function fileFor(productId: string): string {
  return path.join(DIR, `${productId.replace(/[^A-Za-z0-9_-]/g, '')}.json`)
}

export function listComments(productId: string, runId?: string): Comment[] {
  try {
    const all: Comment[] = JSON.parse(fs.readFileSync(fileFor(productId), 'utf8'))
    return runId ? all.filter((c) => c.runId === runId) : all
  } catch {
    return []
  }
}

export function addComment(
  productId: string,
  c: { runId: string; anchor: string; author: string; text: string },
): Comment {
  const all = listComments(productId)
  const comment: Comment = {
    id: `c-${randomUUID().slice(0, 8)}`,
    runId: c.runId,
    anchor: c.anchor.slice(0, 60),
    author: c.author,
    text: c.text.slice(0, 2000),
    createdAt: new Date().toISOString(),
  }
  all.push(comment)
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(fileFor(productId), JSON.stringify(all, null, 1))
  return comment
}

export function deleteComment(productId: string, commentId: string, byEmail: string, isOwner: boolean): boolean {
  const all = listComments(productId)
  const idx = all.findIndex((c) => c.id === commentId)
  if (idx < 0) return false
  if (!isOwner && all[idx].author.toLowerCase() !== byEmail.toLowerCase()) return false
  all.splice(idx, 1)
  fs.writeFileSync(fileFor(productId), JSON.stringify(all, null, 1))
  return true
}
