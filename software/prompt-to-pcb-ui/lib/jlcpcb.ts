/**
 * JLCPCB Open API client — REAL instant PCB quotes via the overseas OpenAPI
 * (https://open.jlcpcb.com). Server-side only (uses the secret key).
 *
 * Auth is HMAC-SHA256 over "METHOD\n<uri>\n<timestamp>\n<nonce>\n<body>\n",
 * carried in a `JOP ...` Authorization header — verified correct against the
 * live endpoint (the request authenticates; access is then gated by JLCPCB's
 * per-account IP allowlist). Credentials come from .env.local:
 *   JLCPCB_APP_ID / JLCPCB_ACCESS_KEY / JLCPCB_SECRET_KEY
 * Nothing is ordered — this only calls the price-calculate endpoint.
 */
import crypto from 'crypto'

const BASE = process.env.JLCPCB_ENDPOINT || 'https://open.jlcpcb.com'
const CALC_URI = '/overseas/openapi/pcb/calculate'
const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export type JlcParams = {
  layer: number; width: number; length: number; qty: number
  thickness?: number
  // optional passthroughs so we can tune craft without code changes
  pcbColor?: number; surfaceFinish?: number
}

export type JlcResult =
  | { ok: true; priceUsd: number | null; leadDays: number | null; currency: string; raw: any }
  | { ok: false; reason: 'unconfigured' | 'ip_not_allowed' | 'error'; message: string; httpStatus?: number }

export function jlcConfigured(): boolean {
  return Boolean(process.env.JLCPCB_APP_ID && process.env.JLCPCB_ACCESS_KEY && process.env.JLCPCB_SECRET_KEY)
}

function nonce(len = 32): string {
  let s = ''
  const bytes = crypto.randomBytes(len)
  for (let i = 0; i < len; i++) s += NONCE_CHARS[bytes[i] % NONCE_CHARS.length]
  return s
}

function authHeader(method: string, uri: string, body: string): string {
  const appId = process.env.JLCPCB_APP_ID as string
  const accessKey = process.env.JLCPCB_ACCESS_KEY as string
  const secretKey = process.env.JLCPCB_SECRET_KEY as string
  const ts = Math.floor(Date.now() / 1000)
  const n = nonce()
  const stringToSign = `${method.toUpperCase()}\n${uri}\n${ts}\n${n}\n${body}\n`
  const signature = crypto.createHmac('sha256', secretKey).update(stringToSign, 'utf8').digest('base64')
  return `JOP appid="${appId}",accesskey="${accessKey}",timestamp="${ts}",nonce="${n}",signature="${signature}"`
}

// pull a plausible total + lead time out of JLCPCB's price payload without
// assuming one exact shape (the calculate response nests differently by craft).
function extractPrice(data: any): { priceUsd: number | null; leadDays: number | null } {
  if (!data || typeof data !== 'object') return { priceUsd: null, leadDays: null }
  const priceKeys = ['totalPrice', 'total', 'productAmount', 'productPrice', 'pcbPrice', 'amount', 'orderPrice']
  let priceUsd: number | null = null
  for (const k of priceKeys) {
    const v = data[k]
    if (typeof v === 'number' && v > 0) { priceUsd = v; break }
    if (typeof v === 'string' && !isNaN(parseFloat(v))) { priceUsd = parseFloat(v); break }
  }
  const leadKeys = ['leadTime', 'leadDays', 'buildTime', 'productCycle', 'days']
  let leadDays: number | null = null
  for (const k of leadKeys) {
    const v = data[k]
    if (typeof v === 'number' && v > 0) { leadDays = Math.round(v); break }
  }
  return { priceUsd, leadDays }
}

export async function jlcCalculate(p: JlcParams): Promise<JlcResult> {
  if (!jlcConfigured()) return { ok: false, reason: 'unconfigured', message: 'JLCPCB_APP_ID / ACCESS_KEY / SECRET_KEY not set in .env.local' }

  const pcbParam: Record<string, any> = {
    layer: p.layer, width: p.width, length: p.length, qty: p.qty,
    thickness: p.thickness ?? 1.6,
  }
  if (p.pcbColor != null) pcbParam.pcbColor = p.pcbColor
  if (p.surfaceFinish != null) pcbParam.surfaceFinish = p.surfaceFinish

  // compact JSON (no spaces) — must be byte-identical to the signed body
  const body = JSON.stringify({ orderType: 1, pcbParam })
  let res: Response
  try {
    res = await fetch(BASE + CALC_URI, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: authHeader('POST', CALC_URI, body),
      },
      body,
    })
  } catch (e: any) {
    return { ok: false, reason: 'error', message: `network: ${String(e?.message ?? e).slice(0, 120)}` }
  }

  const text = await res.text()
  let j: any = null
  try { j = JSON.parse(text) } catch { /* non-JSON */ }

  if (res.status === 403 || j?.code === 403) {
    return { ok: false, reason: 'ip_not_allowed', httpStatus: 403,
      message: j?.message || 'JLCPCB rejected this server IP — add it to your JLCPCB API console allowlist.' }
  }
  if (!res.ok || j?.success === false) {
    return { ok: false, reason: 'error', httpStatus: res.status,
      message: (j?.message || text || `HTTP ${res.status}`).toString().slice(0, 200) }
  }

  const data = j?.data ?? j
  const { priceUsd, leadDays } = extractPrice(data)
  return { ok: true, priceUsd, leadDays, currency: 'USD', raw: data }
}
