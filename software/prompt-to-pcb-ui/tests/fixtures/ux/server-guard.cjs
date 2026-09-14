// Preloaded into Next and its worker BEFORE it installs request handlers.
// Not a production proxy. Never forwards a request or imports application code.
const http = require('node:http');
const emit = http.Server.prototype.emit;
const origin = 'http://127.0.0.1:4510';
function permitted(request, upgrade) {
  if (request.headers.host !== '127.0.0.1:4510') return false;
  if (request.headers.origin && request.headers.origin !== origin) return false;
  let url;
  try { url = new URL(request.url, origin); } catch { return false; }
  if (url.origin !== origin || /%2f|%5c|%2e/i.test(url.pathname)) return false;
  if (upgrade) return url.pathname === '/_next/webpack-hmr';
  const p = url.pathname;
  return p === '/' || p === '/compose' || p === '/login' || p === '/start' ||
    /^\/enterprise(?:\/(activity|approvals|audit|budgets|catalog|iam|integrations|quotes|settings|validation))?$/.test(p) ||
    p === '/api' || p.startsWith('/api/') || p.startsWith('/runs/') ||
    p.startsWith('/_next/static/');
}
http.Server.prototype.emit = function(event, ...args) {
  if (event === 'request' || event === 'upgrade') {
    const [request, response] = args;
    if (!permitted(request, event === 'upgrade')) {
      if (event === 'upgrade') response.destroy();
      else {
        response.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-UI-Preview': 'synthetic-only' });
        response.end(JSON.stringify({ error: 'UI preview blocked this host, origin, or development endpoint', blocked: true }));
      }
      return true;
    }
  }
  return emit.call(this, event, ...args);
};
