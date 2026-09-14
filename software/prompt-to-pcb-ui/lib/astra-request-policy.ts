/** Local beta server boundary. Unknown APIs are denied, including mutation-bearing GETs. */
export function astraApiAllowed(pathname: string, method: string): boolean {
  const reads = new Set([
    '/api/astra', '/api/auth/me', '/api/admin/me', '/api/runs', '/api/runs/files',
    '/api/runs/work-items', '/api/runs/stage-hash',
  ])
  if (method === 'GET' && reads.has(pathname)) return true
  if (method === 'GET' && pathname === '/api/pipeline/run') return true
  return method === 'POST' && ['/api/astra', '/api/architect', '/api/electronics-cs', '/api/auth/login', '/api/auth/logout'].includes(pathname)
}
