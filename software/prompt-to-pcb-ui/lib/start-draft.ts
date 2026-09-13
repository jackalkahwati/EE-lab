/** Browser-only draft handoff. No prompt belongs in a request URL or cookie. */
export const START_DRAFT_KEY = 'firstlight.start-draft.v1'
export const START_DRAFT_TTL_MS = 30 * 60 * 1000
export const START_PROMPT_MAX_LENGTH = 4000

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type StartDraft = { version: 1; id: string; prompt: string; createdAt: number }

export function sessionDraftStorage(): DraftStorage | null {
  try { return window.sessionStorage } catch { return null }
}

export function promptFromFragment(fragment: string): string | null {
  if (!fragment.startsWith('#') || fragment.length > START_PROMPT_MAX_LENGTH * 12 + 20) return null
  // URLSearchParams silently replaces broken escapes/UTF-8; reject them instead.
  try { decodeURIComponent(fragment.slice(1)) } catch { return null }
  const params = new URLSearchParams(fragment.slice(1))
  const values = params.getAll('prompt')
  if (values.length !== 1) return null
  const prompt = values[0].trim()
  return prompt && prompt.length <= START_PROMPT_MAX_LENGTH ? prompt : null
}

export function readStartDraft(storage: DraftStorage | null, now = Date.now()): StartDraft | null {
  try {
    const raw = storage?.getItem(START_DRAFT_KEY)
    if (!raw) return null
    if (raw.length > START_PROMPT_MAX_LENGTH * 6 + 256) throw new Error('Oversized draft')
    const d = JSON.parse(raw) as StartDraft
    if (d?.version !== 1 || typeof d.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(d.id)
      || typeof d.prompt !== 'string' || !d.prompt.trim() || d.prompt.length > START_PROMPT_MAX_LENGTH
      || !Number.isSafeInteger(d.createdAt) || d.createdAt > now || now - d.createdAt >= START_DRAFT_TTL_MS) {
      throw new Error('Invalid or expired draft')
    }
    return d
  } catch {
    try { storage?.removeItem(START_DRAFT_KEY) } catch { /* storage is unavailable */ }
    return null
  }
}

export function saveStartDraft(storage: DraftStorage | null, draft: StartDraft): boolean {
  if (!storage) return false
  try {
    const raw = JSON.stringify(draft)
    storage.setItem(START_DRAFT_KEY, raw)
    return storage.getItem(START_DRAFT_KEY) === raw
  } catch { return false }
}

/** Acknowledge only after the composer has accepted the text. Never delete a newer draft. */
export function acknowledgeStartDraft(storage: DraftStorage | null, id: string): boolean {
  try {
    if (readStartDraft(storage)?.id !== id) return false
    storage!.removeItem(START_DRAFT_KEY)
    return storage!.getItem(START_DRAFT_KEY) === null
  } catch { return false }
}

/** Reject ambiguous paths before URL normalization (including encoded backslashes). */
export function safeLoginNext(next: string | null, hasPendingDraft: boolean): string {
  const fallback = hasPendingDraft ? '/compose' : '/'
  if (!next || !next.startsWith('/') || next.startsWith('//') || /[\\\x00-\x20\x7f]/.test(next)) return fallback
  try {
    const decoded = decodeURIComponent(next)
    if (decoded.startsWith('//') || /[\\\x00-\x20\x7f]/.test(decoded)) return fallback
    const url = new URL(next, 'https://firstlight.invalid')
    if (url.origin !== 'https://firstlight.invalid' || url.pathname.startsWith('//')) return fallback
    return url.pathname + url.search + url.hash
  } catch { return fallback }
}

export function isStartPath(pathname: string): boolean {
  return pathname === '/start' || pathname === '/start/'
}

// Runs in the document head, before hydration or any analytics. The temporary
// value stays in this document only; StartPage deletes it as soon as it reads it.
export const START_SCRUB_SCRIPT = `if(location.pathname==='/start'||location.pathname==='/start/'){window.__firstlightStartFragment=location.hash;try{history.replaceState(history.state,'','/start')}catch{window.__firstlightStartScrubFailed=true}}`
