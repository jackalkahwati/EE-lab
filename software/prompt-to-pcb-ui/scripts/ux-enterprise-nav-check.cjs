/* eslint-disable @typescript-eslint/no-require-imports -- Standalone installed-browser diagnostic. */
// Read-only synthetic Home → Approvals → Quotes diagnostic. Never retries a click.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');
const origin = 'http://127.0.0.1:4510';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const routes = ['/enterprise', '/enterprise/approvals', '/enterprise/quotes'];
const apiReads = ['/api/ux-preview/status', '/api/ux-preview/snapshot', '/api/enterprise', '/api/auth/me'];

(async () => {
  const started = Date.now();
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ux-enterprise-nav-'));
  const report = { output, startedAt: new Date(started).toISOString(), events: [], states: [], failures: [], blocked: [], errors: [], consoleIssues: [], notes: [
    'Read-only fixed-loopback synthetic diagnostic; genuine single clicks, no navigation fallback or provider/account actions.',
    'React property observations are diagnostic only, not readiness evidence. No request/response bodies or credentials captured.',
  ] };
  let browser;
  let page;
  let expired = false;
  let capped = false;
  const keep = (array, value) => {
    if (array.length >= 1500) {
      if (!capped) { capped = true; report.failures.push({ message: 'Bounded observation limit exceeded' }); void browser?.close(); }
      return;
    }
    array.push({ elapsedMs: Date.now() - started, ...value });
  };
  const deadline = setTimeout(() => {
    expired = true;
    report.failures.push({ message: 'Diagnostic exceeded 90-second deadline' });
    void browser?.close();
  }, 90000);
  const fixtureRead = async (pathname) => {
    const response = await fetch(`${origin}${pathname}`, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'x-ux-scenario': 'enterprise-populated' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-ui-preview'), 'synthetic-only');
    return response.json();
  };
  const state = async label => {
    if (!page || page.isClosed()) return;
    const value = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Enterprise sections"]');
      return {
        url: location.href, readyState: document.readyState,
        heading: Array.from(document.querySelectorAll('h1')).map(node => node.textContent),
        links: Array.from(nav?.querySelectorAll('a') || []).map(link => {
          const box = link.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return { label: link.getAttribute('aria-label'), href: link.getAttribute('href'), current: link.getAttribute('aria-current'),
            rect: { x: box.x, y: box.y, width: box.width, height: box.height },
            hit: hit ? { tag: hit.tagName, label: hit.getAttribute('aria-label'), nearestHref: hit.closest('a')?.getAttribute('href') } : null,
            hasReactProps: Object.keys(link).some(key => key.startsWith('__reactProps$')) };
        }),
        toggle: nav?.querySelector('button')?.getAttribute('aria-expanded'),
      };
    });
    keep(report.states, { label, ...value });
  };
  try {
    const status = await fixtureRead('/api/ux-preview/status');
    assert.equal(status.preview, true); assert.equal(status.providers, false); assert.equal(status.tools, false);
    const snapshot = await fixtureRead('/api/ux-preview/snapshot');
    assert.equal(snapshot.frozen, true); assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
    report.snapshot = { frozen: snapshot.frozen, sha256: snapshot.sha256 };
    const db = await fixtureRead('/api/enterprise');
    assert.equal(db.organizations?.[0]?.org_id, 'ux-org');
    assert.equal(db.organizations[0].security_settings.demo, true);
    assert.ok(fs.existsSync(chrome));
    if (expired) throw new Error('Deadline reached before browser launch');
    browser = await chromium.launch({ executablePath: chrome, headless: true, timeout: 15000 });
    report.browser = await browser.version();
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      const queryAllowed = [...url.searchParams.keys()].every(key => key === '_rsc' || (key === 'scenario' && url.searchParams.get(key) === 'enterprise-populated'));
      const allowed = url.origin === origin && ['GET', 'HEAD'].includes(request.method()) && (
        (routes.includes(url.pathname) && queryAllowed) ||
        (apiReads.includes(url.pathname) && !url.search) ||
        url.pathname.startsWith('/_next/static/') || ['/favicon.ico', '/icon.svg'].includes(url.pathname)
      );
      if (!allowed) { keep(report.blocked, { url: request.url(), method: request.method() }); return route.abort(); }
      const headers = { ...request.headers() };
      if (url.pathname === '/api/enterprise') headers['x-ux-scenario'] = 'enterprise-populated';
      return route.continue({ headers });
    });
    await context.routeWebSocket('**/*', ws => {
      const url = new URL(ws.url());
      if (url.protocol === 'ws:' && url.host === '127.0.0.1:4510' && url.pathname === '/_next/webpack-hmr') ws.connectToServer();
      else { keep(report.blocked, { url: ws.url(), kind: 'websocket' }); ws.close(); }
    });
    await context.exposeBinding('__uxNavClick', (_source, value) => keep(report.events, { kind: 'click', ...value }));
    await context.addInitScript(() => {
      document.addEventListener('click', event => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target?.closest('nav[aria-label="Enterprise sections"]')) return;
        const describe = node => node instanceof Element ? { tag: node.tagName, id: node.id, label: node.getAttribute('aria-label'), href: node.getAttribute('href') } : { tag: node === window ? 'window' : 'document' };
        const value = { url: location.href, target: describe(target), path: event.composedPath().slice(0, 12).map(describe),
          trusted: event.isTrusted, button: event.button, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey };
        queueMicrotask(() => { void window.__uxNavClick({ ...value, defaultPrevented: event.defaultPrevented }); });
      }, true);
    });
    page = await context.newPage();
    page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(60000);
    const ids = new WeakMap(); let sequence = 0;
    const interesting = request => {
      const url = new URL(request.url());
      return routes.includes(url.pathname) || url.pathname.startsWith('/api/') || url.pathname.startsWith('/_next/static/chunks/');
    };
    page.on('request', request => {
      if (!interesting(request)) return;
      ids.set(request, ++sequence);
      keep(report.events, { kind: 'request', id: sequence, url: request.url(), method: request.method(), resourceType: request.resourceType(), navigation: request.isNavigationRequest(), rsc: request.headers().rsc === '1' });
    });
    page.on('response', response => {
      const request = response.request(); if (!interesting(request)) return;
      keep(report.events, { kind: 'response', id: ids.get(request), url: response.url(), status: response.status(), contentType: response.headers()['content-type'], fixture: response.headers()['x-ui-preview'] });
    });
    page.on('requestfinished', request => {
      if (interesting(request)) keep(report.events, { kind: 'finished', id: ids.get(request), url: request.url(), timing: request.timing() });
    });
    page.on('requestfailed', request => {
      keep(report.events, { kind: 'requestfailed', id: ids.get(request), url: request.url(), error: request.failure()?.errorText, timing: request.timing() });
    });
    page.on('framenavigated', frame => keep(report.events, { kind: 'framenavigated', mainFrame: frame === page.mainFrame(), url: frame.url() }));
    page.on('pageerror', error => keep(report.errors, { message: error.message, stack: error.stack }));
    page.on('console', message => {
      if (['warning', 'error'].includes(message.type())) keep(report.consoleIssues, { type: message.type(), message: message.text(), location: message.location() });
    });
    page.on('download', download => { keep(report.blocked, { kind: 'download', name: download.suggestedFilename() }); void download.cancel(); });
    await page.goto(`${origin}/enterprise?scenario=enterprise-populated`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.getByRole('heading', { name: 'Enterprise Programs', exact: true }).waitFor();
    await page.getByText('Synthetic Sensor Program', { exact: true }).filter({ visible: true }).first().waitFor();
    const nav = page.getByRole('navigation', { name: 'Enterprise sections' });
    await state('initial');
    await nav.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
    await nav.getByRole('button', { name: 'Collapse sidebar', exact: true }).waitFor();
    await state('expanded');
    for (const [label, route, heading] of [
      ['Home', '/enterprise', 'Enterprise Programs'],
      ['Approvals', '/enterprise/approvals', 'Approvals'],
      ['Quotes', '/enterprise/quotes', 'Quotes & procurement'],
    ]) {
      await state(`before-${label}`);
      const link = nav.getByRole('link', { name: label, exact: true });
      assert.equal(await link.getAttribute('href'), route);
      keep(report.events, { kind: 'click-start', label });
      try {
        await Promise.all([
          page.waitForURL(url => url.pathname === route, { waitUntil: 'domcontentloaded', timeout: label === 'Quotes' ? 60000 : 15000 }),
          link.click(),
        ]);
        keep(report.events, { kind: 'navigation-resolved', label });
        await page.getByRole('heading', { name: heading, exact: true }).waitFor();
        assert.equal(await link.getAttribute('aria-current'), 'page');
      } finally {
        await state(`after-${label}`).catch(error => keep(report.events, { kind: 'state-error', message: error.message }));
      }
      await page.screenshot({ path: path.join(output, `${label.toLowerCase()}.png`), fullPage: true, timeout: 3000 });
    }
    assert.deepEqual(report.blocked, []);
    assert.deepEqual(report.errors, []);
  } catch (error) {
    report.failures.push({ message: error.message, stack: error.stack, url: page?.url() });
    if (page && !page.isClosed()) {
      await state('failure').catch(() => {});
      await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 3000 }).catch(() => {});
    }
  } finally {
    if (!expired && report.snapshot) {
      try {
        const snapshot = await fixtureRead('/api/ux-preview/snapshot');
        assert.equal(snapshot.frozen, true); assert.equal(snapshot.sha256, report.snapshot.sha256);
        report.snapshotUnchanged = true;
      } catch (error) { report.failures.push({ message: error.message, stage: 'final-snapshot' }); }
    }
    await browser?.close();
    clearTimeout(deadline);
    report.durationMs = Date.now() - started;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, failures: report.failures, durationMs: report.durationMs }, null, 2));
    if (report.failures.length) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
