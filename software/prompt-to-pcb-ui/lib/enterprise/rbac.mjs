/**
 * E5 — Roles, permissions, audit (stub at E1; full matrix lands in E5).
 * Default dev flow: the 'dev-admin' actor carries Org Admin so local/dev
 * usage keeps working. Unknown actors get Viewer (read-only).
 */

export function checkAction(_db, actor, _action, _params) {
  // E1 stub: allow dev-admin everything; deny mutations for anonymous
  if (actor && actor !== 'anonymous') return { ok: true }
  return { ok: false, reason: 'anonymous actors cannot mutate' }
}
