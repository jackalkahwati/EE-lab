/* Preview-only guard, installed before client hydration. CSP is the primary
   network boundary; these guards additionally reject cross-origin navigation. */
(() => {
  const origin = location.origin;
  const allowed = (input) => {
    try { return new URL(input instanceof Request ? input.url : String(input), origin).origin === origin; }
    catch { return false; }
  };
  const blocked = () => new Error('UI preview blocks external connections');
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (!allowed(input)) return Promise.reject(blocked());
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('x-ux-scenario', new URLSearchParams(location.search).get('scenario') || 'empty');
    return realFetch(input, { ...init, headers, credentials: 'omit' });
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    if (!allowed(url)) throw blocked();
    return open.call(this, method, url, ...args);
  };
  const ES = window.EventSource;
  window.EventSource = class extends ES {
    constructor(url, options) {
      if (!allowed(url)) throw blocked();
      const target = new URL(url, origin);
      if (target.pathname === '/api/pipeline/run') target.searchParams.set('uxScenario', new URLSearchParams(location.search).get('scenario') || 'empty');
      super(target.href, options);
    }
  };
  const WS = window.WebSocket;
  window.WebSocket = class extends WS {
    constructor(url, protocols) {
      const u = new URL(url, origin);
      if (u.protocol !== 'ws:' || u.host !== location.host || u.pathname !== '/_next/webpack-hmr') throw blocked();
      super(url, protocols);
    }
  };
  navigator.sendBeacon = () => false;
  window.open = () => null;
  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a') : null;
    if (link && !allowed(link.href)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('submit', (event) => event.preventDefault(), true);
  // Never accept pasted real provider keys in the preview's persistent storage.
  try {
    for (const key of Object.keys(localStorage)) if (/key|token|secret|provider/i.test(key)) localStorage.removeItem(key);
  } catch { /* Storage may be disabled in an ordinary/private browser. */ }
})();
