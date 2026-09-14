/* eslint-disable @typescript-eslint/no-require-imports -- Installed local browser tooling. */
// Synthetic-only acceptance. Does not start servers, install browsers, or run models.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const origin = 'http://127.0.0.1:4510';
const reads = new Set(['/api/auth/me', '/api/admin/me', '/api/runs', '/api/account/llm-key', '/api/astra']);
const scenarios = new Set(['empty', 'astra-blocked', 'astra-status-error']);
const blocker = 'Synthetic preflight blocker: native footprint/model verification is unavailable. No inference was called.';
const startupMs = 60000;
const maxEvents = 2000;

function allowed(raw, method) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (url.origin !== origin || url.username || url.password || method !== 'GET') return false;
  if (reads.has(url.pathname)) return !url.search;
  if (url.pathname === '/compose') {
    const keys = [...url.searchParams.keys()];
    return keys.every(key => key === 'scenario' || key === '_rsc')
      && keys.length === new Set(keys).size
      && (!url.searchParams.has('scenario') || scenarios.has(url.searchParams.get('scenario')))
      && (!url.searchParams.has('_rsc') || /^[a-zA-Z0-9_-]{1,128}$/.test(url.searchParams.get('_rsc')));
  }
  return url.pathname.startsWith('/_next/static/') || (!url.search && ['/favicon.ico', '/icon.svg'].includes(url.pathname));
}

async function run() {
  const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ux-astra-'));
  const report = { output, checks: [], failures: [], requests: [], blocked: [], errors: [], console: [], hydration: [], httpFailures: [], intentionalDenials: [], responses: [], notes: [
    'Frozen synthetic preview only. No provider, account mutation, generation, real handler, or download is allowed.',
    'Installed Chrome with a Playwright-owned temporary profile and fresh isolated contexts; no existing profile or storage is read.',
    'Desktop and mobile viewport emulation, not physical mobile or other browser coverage. Interaction uses pointer/keyboard, never direct React handlers.',
    'All WebSockets and non-GET requests, including developer diagnostics, are denied. Status/snapshot probes are fixed read-only preconditions outside the page allowlist.',
  ] };
  let browser, page, expired = false, capped = false;
  const stop = () => { void browser?.close().catch(() => {}); };
  const deadline = setTimeout(() => {
    expired = true;
    report.failures.push({ name: 'Suite deadline', message: 'Astra acceptance exceeded five minutes' });
    stop();
  }, 300000);
  function record(array, value) {
    if (array.length >= maxEvents) {
      if (!capped) { capped = true; report.failures.push({ name: 'Observation cap', message: 'Bounded event limit exceeded' }); stop(); }
      return;
    }
    array.push(value);
  }
  async function probe(endpoint) {
    assert.ok(['/api/ux-preview/status', '/api/ux-preview/snapshot'].includes(endpoint));
    const response = await fetch(origin + endpoint, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-ui-preview'), 'synthetic-only');
    return response.json();
  }
  const composer = () => page.getByRole('textbox', { name: 'Describe your product or board', exact: true });
  const statusPanel = () => page.getByRole('region', { name: 'Astra beta status', exact: true });
  const retry = () => statusPanel().getByRole('button', { name: 'Check status again', exact: true });
  const generationRequests = () => report.requests.filter(request => {
    const pathname = new URL(request.url).pathname;
    return (request.method !== 'GET' && !pathname.startsWith('/__nextjs'))
      || pathname === '/api/pipeline/run' || pathname === '/api/astra/workflows';
  });
  async function check(name, action) {
    if (expired || capped) return;
    try { await action(); report.checks.push(name); }
    catch (error) {
      report.failures.push({ name, stack: error.stack || error.message, url: page?.url(), body: await page?.locator('body').innerText({ timeout: 2000 }).catch(() => '') });
      await page?.screenshot({ path: path.join(output, `failure-${report.failures.length}.png`), fullPage: true, timeout: 5000 }).catch(() => {});
    }
  }
  async function open(scenario, viewport) {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, reducedMotion: 'reduce', viewport });
    await context.route('**/*', route => {
      const request = route.request();
      const entry = { scenario, url: request.url(), method: request.method() };
      record(report.requests, entry);
      if (!allowed(request.url(), request.method())) {
        record(report.blocked, { ...entry, reason: 'outside exact synthetic GET allowlist' });
        return route.abort();
      }
      // The preview also derives scenario from the document. Pin it explicitly
      // so each fresh context has a single audited synthetic scenario.
      return route.continue({ headers: { ...request.headers(), 'x-ux-scenario': scenario } });
    });
    await context.routeWebSocket('**/*', socket => {
      record(report.blocked, { scenario, url: socket.url(), method: 'WEBSOCKET', reason: 'all sockets denied' });
      socket.close();
    });
    page = await context.newPage();
    page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(startupMs);
    page.on('pageerror', error => record(report.errors, { scenario, stack: error.stack || error.message }));
    page.on('console', message => {
      if (!['warning', 'error'].includes(message.type())) return;
      const entry = { scenario, type: message.type(), text: message.text(), location: message.location() };
      record(report.console, entry);
      if (/hydration|hydrating|did not match|server rendered HTML|Minified React error #(418|419|421|422|423|425)/i.test(entry.text)) record(report.hydration, entry);
    });
    page.on('response', response => {
      const pathname = new URL(response.url()).pathname;
      const entry = { scenario, url: response.url(), method: response.request().method(), status: response.status(), synthetic: response.headers()['x-ui-preview'] };
      if (pathname.startsWith('/api/')) record(report.responses, entry);
      if (response.status() < 400) return;
      const intentional = entry.synthetic === 'synthetic-only' && ((pathname === '/api/admin/me' && entry.status === 403)
        || (pathname === '/api/astra' && scenario === 'astra-status-error' && entry.status === 503));
      record(intentional ? report.intentionalDenials : report.httpFailures, entry);
    });
    page.on('requestfailed', request => {
      if (new URL(request.url()).pathname.startsWith('/_next/static/')) record(report.errors, { scenario, message: `Static request failed: ${request.url()} ${request.failure()?.errorText}` });
    });
    page.on('download', download => { record(report.blocked, { scenario, url: download.url(), reason: 'unexpected download' }); void download.cancel(); });
    page.on('popup', popup => { record(report.blocked, { scenario, url: popup.url(), reason: 'unexpected popup' }); void popup.close(); });
    const statusRead = page.waitForResponse(response => response.url() === origin + '/api/astra' && response.request().method() === 'GET', { timeout: startupMs });
    await page.goto(origin + '/compose' + (scenario === 'empty' ? '' : `?scenario=${scenario}`), { waitUntil: 'domcontentloaded' });
    const response = await statusRead;
    assert.equal(response.headers()['x-ui-preview'], 'synthetic-only');
    assert.equal(response.status(), scenario === 'astra-status-error' ? 503 : 200);
    await composer().waitFor({ timeout: startupMs });
    return context;
  }
  async function blockedInteraction(scenario) {
    const input = composer();
    const draft = `Synthetic unsent ${scenario} draft`;
    // Drafting may remain enabled; generation must not. Exercise native pointer
    // and keyboard semantics without bypassing the disabled submission button.
    if (await input.isEnabled()) {
      await input.click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace'); await page.keyboard.type(draft);
      const send = page.getByRole('button', { name: 'Send ↵', exact: true });
      assert.equal(await send.isDisabled(), true, 'Blocked status must disable Send while keeping drafts editable');
      // A real pointer click on the disabled button must not submit. mouse.click
      // intentionally does not bypass DOM disabled semantics like dispatchEvent.
      const box = await send.boundingBox();
      assert.ok(box, 'Send remains visibly discoverable');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await input.click(); await page.keyboard.press('Enter');
      assert.equal(await input.inputValue(), draft, 'Blocked submission must preserve the draft');
    } else {
      assert.equal(await page.getByRole('button', { name: 'Send ↵', exact: true }).isDisabled(), true);
    }
    // Bounded observation window for deferred fetches; no action is retried.
    await page.waitForTimeout(400);
    assert.deepEqual(generationRequests(), [], 'No generation or fallback-generation request may even be attempted');
  }
  try {
    assert.deepEqual(await probe('/api/ux-preview/status'), { preview: true, scenario: 'empty', providers: false, tools: false });
    const snapshot = await probe('/api/ux-preview/snapshot');
    assert.equal(snapshot.frozen, true, 'Acceptance requires --frozen preview');
    assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
    report.snapshot = { frozen: true, sha256: snapshot.sha256 };
    if (expired) throw new Error('Deadline reached before browser launch');
    browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, timeout: 15000 });
    report.browser = browser.version();
    for (const [size, viewport] of [['desktop', { width: 1440, height: 960 }], ['mobile', { width: 390, height: 844 }]]) {
      for (const scenario of scenarios) {
        await check(`${size}: ${scenario}`, async () => {
          let context;
          try {
            context = await open(scenario, viewport);
            if (scenario === 'empty') {
              await statusPanel().waitFor({ state: 'hidden' });
              assert.equal(await composer().isEnabled(), true, 'Disabled beta must preserve current Compose input');
              await composer().click(); await page.keyboard.type('Synthetic unsent current Compose draft');
              assert.equal(await composer().inputValue(), 'Synthetic unsent current Compose draft');
              assert.equal(await page.getByRole('button', { name: 'Send ↵', exact: true }).isEnabled(), true);
            } else {
              await retry().waitFor();
              if (scenario === 'astra-blocked') {
                await statusPanel().getByText('Astra beta · Bedrock', { exact: true }).waitFor();
                await statusPanel().getByText('Electronics-only. Other disciplines are not run.', { exact: true }).waitFor();
                await statusPanel().getByText('Generation blocked', { exact: true }).waitFor();
                await statusPanel().getByText(blocker, { exact: true }).waitFor();
              } else {
                await statusPanel().getByRole('alert').filter({ hasText: 'Generation mode could not be verified. Generation is blocked.' }).waitFor();
              }
              await blockedInteraction(scenario);
              const before = report.requests.filter(request => request.url === origin + '/api/astra').length;
              const read = page.waitForResponse(response => response.url() === origin + '/api/astra' && response.request().method() === 'GET');
              // Pointer on desktop, keyboard activation on mobile.
              if (size === 'desktop') await retry().click();
              else { await retry().focus(); await page.keyboard.press('Enter'); }
              const response = await read;
              assert.equal(response.status(), scenario === 'astra-status-error' ? 503 : 200);
              await retry().waitFor();
              assert.equal(report.requests.filter(request => request.url === origin + '/api/astra').length, before + 1, 'Retry performs exactly one status GET');
              await blockedInteraction(scenario);
            }
            assert.deepEqual(generationRequests(), []);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Viewport must not overflow horizontally');
            await page.screenshot({ path: path.join(output, `${size}-${scenario}.png`), fullPage: true });
          } finally { await context?.close(); }
        });
      }
    }
    await check('No unexpected errors, hydration failures, network paths, mutations, or snapshot drift', async () => {
      assert.deepEqual(report.errors, []);
      assert.deepEqual(report.hydration, []);
      assert.deepEqual(report.httpFailures, []);
      assert.deepEqual(generationRequests(), []);
      const unexpected = report.blocked.filter(entry => {
        const url = new URL(entry.url);
        return !(entry.method === 'WEBSOCKET' && url.origin === 'ws://127.0.0.1:4510' && url.pathname === '/_next/webpack-hmr' && !url.search)
          && !(url.origin === origin && url.pathname === '/__nextjs_original-stack-frames' && entry.method === 'POST' && !url.search);
      });
      assert.deepEqual(unexpected, [], 'Only blocked HMR and blocked stack diagnostics are expected');
      for (const request of report.requests.filter(request => request.method !== 'GET')) {
        assert.ok(report.blocked.some(entry => entry.url === request.url && entry.method === request.method), 'Every mutation must be denied');
      }
      const after = await probe('/api/ux-preview/snapshot');
      assert.equal(after.frozen, true); assert.equal(after.sha256, report.snapshot.sha256);
    });
  } catch (error) { report.failures.push({ name: 'Suite setup', stack: error.stack || error.message }); }
  finally {
    await browser?.close().catch(() => {});
    clearTimeout(deadline);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, checks: report.checks, failures: report.failures, errors: report.errors.length, hydration: report.hydration.length, blocked: report.blocked.length }, null, 2));
    if (report.failures.length || expired || capped) process.exitCode = 1;
  }
}

module.exports = { allowed };
if (require.main === module) void run();
