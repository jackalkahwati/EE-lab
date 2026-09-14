/** Next normalizes loopback URLs to localhost. The incoming Host must still
 * identify the exact operator-configured numeric loopback endpoint. Forwarded
 * headers never grant access. Workspace and authentication checks remain separate.
 */
export function astraRequestOriginAllowed(req: Request, origin: string, requireHost = false): boolean {
  try {
    const expected = new URL(origin)
    if (expected.origin !== origin || expected.protocol !== 'http:' || expected.hostname !== '127.0.0.1'
      || !expected.port || Number(expected.port) < 1024 || Number(expected.port) > 65535) return false
    const actual = new URL(req.url)
    if (actual.username || actual.password || actual.protocol !== expected.protocol || actual.port !== expected.port) return false
    const host = req.headers.get('host')
    if ((requireHost && host === null) || (host !== null && host !== expected.host)) return false
    if (actual.origin !== origin && !(actual.hostname === 'localhost' && host === expected.host)) return false
    if (req.headers.has('origin') && req.headers.get('origin') !== origin) return false
    if (req.headers.get('sec-fetch-site') === 'cross-site') return false
    return true
  } catch { return false }
}
