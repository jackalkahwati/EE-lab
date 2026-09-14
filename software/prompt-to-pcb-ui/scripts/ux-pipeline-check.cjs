/* eslint-disable @typescript-eslint/no-require-imports -- Explicit local acceptance harness. */
// Fixed frozen synthetic preview only; no server startup, downloads or real providers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');
const origin = 'http://127.0.0.1:4510';
const ids = new Set(['ux-model-a', 'ux-model-b']);
const bridges = new Set(['/api/programs/sync', '/api/runs/work-items']);
const posts = new Set(['/api/electronics-cs', '/api/mechanical', '/api/simulate', '/api/runs/timing', '/api/runs/stage-hash', ...bridges]);
(async () => {
  const probe = async pathname => {
    const response = await fetch(origin + pathname, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200); assert.equal(response.headers.get('x-ui-preview'), 'synthetic-only');
    return response.json();
  };
  const status = await probe('/api/ux-preview/status');
  assert.equal(status.providers, false); assert.equal(status.tools, false);
  const snapshot = await probe('/api/ux-preview/snapshot');
  assert.equal(snapshot.frozen, true); assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ux-pipeline-'));
  const report = { output, snapshot: snapshot.sha256, checks: [], failures: [], errors: [], console: [], requests: [], responses: [], blocked: [], notes: ['Synthetic API success is not an engineering pass. Electronics remains unverified and simulation has a required solver gap.', 'Fresh preview process required: each scenario/run has at most 16 accepted POSTs.'] };
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  let expired = false, page, scenario = 'pipeline-success';
  const holds = new Set();
  const pendingCompletions = new Set();
  const deadline = setTimeout(() => { expired = true; report.failures.push({ name: 'Suite deadline', error: 'Five-minute limit' }); void browser.close(); }, 300000);
  const keep = (array, value) => { if (array.length >= 3000) throw new Error('Observation budget exceeded'); array.push(value); };
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', acceptDownloads: false, reducedMotion: 'reduce' });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      let allowed = url.origin === origin;
      const artifact = /^\/runs\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (artifact) allowed &&= ids.has(artifact[1]) && ['GET', 'HEAD'].includes(method);
      if (url.pathname.startsWith('/api/')) {
        if (method === 'POST') {
          let data; try { data = request.postDataJSON(); } catch {}
          allowed &&= posts.has(url.pathname) && !url.search && ids.has(data?.runId)
            && (!bridges.has(url.pathname) || (Object.keys(data).length === 1 && Object.hasOwn(data, 'runId')));
        } else if (method === 'GET') {
          const ordinary = ['/api/auth/me', '/api/admin/me', '/api/runs', '/api/account/llm-key', '/api/astra'];
          const readRun = ['/api/products', '/api/runs/work-items', '/api/runs/files', '/api/runs/product-state'];
          allowed &&= (url.pathname === '/api/runs/stage-hash' && url.searchParams.size === 2
            && url.searchParams.getAll('run').length === 1 && ids.has(url.searchParams.get('run'))
            && url.searchParams.getAll('stage').length === 1 && ['mechanical', 'simulation'].includes(url.searchParams.get('stage')))
            || (ordinary.includes(url.pathname) && !url.search)
            || (readRun.includes(url.pathname) && ids.has(url.searchParams.get('run')) && [...url.searchParams.keys()].every(key => key === 'run'))
            || (url.pathname === '/api/board3d' && ['/runs/ux-model-a/board', '/runs/ux-model-b/board'].includes(url.searchParams.get('base')) && [...url.searchParams.keys()].every(key => key === 'base'));
        } else allowed = false;
      } else if (!artifact) allowed &&= method === 'GET' && (url.pathname === '/compose' || url.pathname.startsWith('/_next/'));
      if (!allowed) { keep(report.blocked, { method, url: request.url() }); return route.abort(); }
      if (artifact || url.pathname.startsWith('/api/')) keep(report.requests, { method, path: url.pathname, query: url.search, scenario, at: Date.now() });
      const requestScenario = scenario;
      const gate = [...holds].find(candidate => !candidate.used && candidate.predicate(url, request));
      const headers = { ...request.headers(), 'x-ux-scenario': requestScenario };
      if (gate) {
        gate.used = true;
        if (gate.response) {
          try {
            // Capture only this exact read before any manual running marker is written.
            assert.equal(method, 'GET'); assert.equal(url.pathname, '/runs/ux-model-b/timing.json'); assert.equal(url.search, '');
            const response = await route.fetch({ headers, maxRedirects: 0, timeout: 15000 });
            assert.equal(response.headers()['x-ui-preview'], 'synthetic-only');
            assert.ok((await response.body()).byteLength <= 32768);
            gate.hit(); await gate.wait;
            await route.fulfill({ response });
          } catch (error) {
            report.failures.push({ name: 'Held history response', error: error.stack || error.message });
            gate.hit(); gate.release();
            await route.abort().catch(() => {});
          }
          return;
        }
        gate.hit(); await gate.wait;
      }
      return route.continue({ headers }).catch(error => { if (!/closed|cancel|abort|Invalid InterceptionId/i.test(error.message)) throw error; });
    });
    await context.routeWebSocket('**/*', ws => {
      const url = new URL(ws.url());
      if (url.protocol === 'ws:' && url.host === '127.0.0.1:4510' && url.pathname === '/_next/webpack-hmr') ws.connectToServer();
      else { keep(report.blocked, { url: ws.url(), method: 'WS' }); ws.close(); }
    });
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => keep(report.errors, error.stack || error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) keep(report.console, { text: message.text(), location: message.location() }); });
    page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/api/')) keep(report.responses, { url: response.url(), method: response.request().method(), status: response.status(), synthetic: response.headers()['x-ui-preview'] }); });
    page.on('download', download => { keep(report.blocked, { method: 'download', url: download.url() }); void download.cancel(); });
    const button = name => page.getByRole('button', { name, exact: true });
    const shot = name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
    const body = () => page.locator('body').innerText();
    const hold = (predicate, response = false) => {
      assert.ok(holds.size < 2, 'At most two explicit requests may be held');
      let hit, resume;
      const reached = new Promise(resolve => { hit = resolve; });
      const wait = new Promise(resolve => { resume = resolve; });
      const gate = { predicate, response, wait, hit, used: false, release: () => { holds.delete(gate); resume(); } };
      holds.add(gate);
      return { release: gate.release, reached: async () => {
        let timer;
        try { await Promise.race([reached, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected request not reached')), 15000); timer.unref(); })]); }
        finally { clearTimeout(timer); }
      } };
    };
    const visit = async (nextScenario, id) => {
      scenario = nextScenario;
      await page.goto(`${origin}/compose?scenario=${scenario}&run=${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await button('run full pipeline').waitFor({ timeout: 60000 });
      await page.waitForFunction(() => Array.from(document.querySelectorAll('textarea')).some(e => Object.keys(e).some(key => key.startsWith('__reactProps$'))));
    };
    const stage = async value => page.getByRole('combobox', { name: 'Preview stage', exact: true }).selectOption(value);
    const completionReplies = runId => {
      const replies = Promise.all([...bridges].map(pathname => page.waitForResponse(response =>
        new URL(response.url()).pathname === pathname && response.request().method() === 'POST'
        && response.request().postDataJSON().runId === runId))).then(value => ({ value }), error => ({ error }));
      const finish = async () => {
        pendingCompletions.delete(finish);
        const result = await replies;
        if (result.error) { expired = true; throw result.error; }
        for (const response of result.value) {
          assert.equal(response.status(), 200); assert.equal(response.headers()['x-ui-preview'], 'synthetic-only');
          const value = await response.json();
          if (new URL(response.url()).pathname === '/api/programs/sync') {
            assert.equal(value.synced, false); assert.match(value.reason, /Synthetic/);
            assert.equal(value.productId, undefined); assert.equal(value.boardId, undefined);
          } else assert.deepEqual(value, { runId, items: [] }); // Not a verification verdict.
        }
      };
      pendingCompletions.add(finish);
      return finish;
    };
    const check = async (name, action) => {
      if (expired) return;
      try { await action(); report.checks.push(name); }
      catch (error) { report.failures.push({ name, error: error.stack || error.message, body: await body().catch(() => '') }); await shot(`failure-${report.failures.length}`).catch(() => {}); }
      finally {
        for (const gate of holds) gate.release();
        for (const finish of pendingCompletions) {
          try { await finish(); }
          catch (error) { report.failures.push({ name: 'Completion replies before scenario change', error: error.stack || error.message }); expired = true; }
        }
      }
    };
    await check('Full downstream flow, Follow build and truthful non-green completion', async () => {
      await visit('pipeline-success', 'ux-model-a');
      const completed = completionReplies('ux-model-a');
      const gate = hold(url => url.pathname === '/api/mechanical');
      await button('run full pipeline').click(); await gate.reached();
      await button('Stop updates').waitFor();
      await button('Follow build').click();
      await page.getByRole('region', { name: 'Build progress' }).waitFor();
      await button('Back to preview').click();
      gate.release();
      await button('Stop updates').waitFor({ state: 'detached' });
      await page.getByText('Build needs attention', { exact: false }).first().waitFor();
      assert.match(await body(), /UNVERIFIED|not executed|could not run/i);
      assert.equal(await button('run full pipeline').isEnabled(), true);
      await completed();
      await shot('downstream-attention');
    });
    await check('Stop updates prevents subsequent simulation and leaves unknown outcome', async () => {
      await visit('pipeline-success', 'ux-model-b');
      const gate = hold(url => url.pathname === '/api/mechanical');
      const before = report.requests.length;
      await button('run full pipeline').click(); await gate.reached();
      await button('Stop updates').click(); gate.release();
      await button('Stop updates').waitFor({ state: 'detached' });
      await page.getByRole('option', { name: /Mechanical · Outcome unknown/ }).waitFor({ state: 'attached' });
      await page.waitForTimeout(800);
      assert.equal(report.requests.slice(before).filter(r => r.path === '/api/simulate').length, 0);
      assert.equal(await button('run full pipeline').isEnabled(), true);
      await shot('downstream-stopped-unknown');
    });
    await check('Downstream mechanical rejection stays failed, not completed', async () => {
      await visit('pipeline-error', 'ux-model-a');
      const completed = completionReplies('ux-model-a');
      await button('run full pipeline').click();
      await button('Stop updates').waitFor();
      await button('Stop updates').waitFor({ state: 'detached' });
      await page.getByRole('option', { name: /Mechanical · failed/ }).waitFor({ state: 'attached' });
      await page.getByText('Build needs attention', { exact: false }).first().waitFor();
      await completed();
      await shot('downstream-mechanical-failure');
    });
    await check('Late unavailable history cannot unlock manual generation across preview switches', async () => {
      const history = hold((url, request) => url.pathname === '/runs/ux-model-b/timing.json' && request.method() === 'GET', true);
      await visit('pipeline-error', 'ux-model-b'); await history.reached();
      await stage('mechanical');
      await page.getByText('Synthetic viewer geometry, not an enclosure design', { exact: false }).first().waitFor();
      const generation = hold(url => url.pathname === '/api/mechanical');
      await button('Regenerate').click(); await generation.reached();
      assert.equal(await button('run full pipeline').isDisabled(), true);
      const lateHistory = page.waitForResponse(response => new URL(response.url()).pathname === '/runs/ux-model-b/timing.json');
      history.release();
      const historyResponse = await lateHistory;
      assert.equal(historyResponse.status(), 404); // No invented historical attempt.
      await historyResponse.finished();
      await stage('electronics');
      await page.waitForTimeout(200);
      assert.equal(await button('run full pipeline').isDisabled(), true);
      const persistedFailure = page.waitForResponse(response => {
        if (new URL(response.url()).pathname !== '/api/runs/timing' || response.request().method() !== 'POST') return false;
        const timing = response.request().postDataJSON();
        return timing.runId === 'ux-model-b' && timing.stages.some(entry => entry.stage === 'mechanical' && entry.status === 'failed');
      });
      generation.release();
      assert.equal((await persistedFailure).status(), 200);
      await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'run full pipeline' && !b.disabled));
      await page.getByRole('option', { name: /Mechanical · failed/ }).waitFor({ state: 'attached' });
      await shot('manual-settled-after-history');
      const restoredHistory = page.waitForResponse(response => new URL(response.url()).pathname === '/runs/ux-model-b/timing.json');
      await visit('pipeline-error', 'ux-model-b');
      const restored = await restoredHistory;
      assert.equal(restored.status(), 200);
      assert.ok((await restored.json()).stages.some(entry => entry.stage === 'mechanical' && entry.status === 'failed'));
      await page.getByRole('option', { name: /Mechanical · failed/ }).waitFor({ state: 'attached' });
      assert.equal(await button('run full pipeline').isEnabled(), true);
      await shot('manual-failed-reloaded');
    });
    await check('No unauthorized traffic, hydration errors or hidden budget exhaustion', async () => {
      assert.deepEqual(report.blocked, []); assert.deepEqual(report.errors, []);
      assert.deepEqual(report.console.filter(e => /hydrat|server rendered|did not match|errorboundary|ChunkLoadError/i.test(e.text)), []);
      assert.equal(report.responses.filter(r => r.status === 429).length, 0);
      assert.ok(report.responses.filter(r => r.method === 'POST').every(r => r.synthetic === 'synthetic-only'));
      assert.equal((await probe('/api/ux-preview/snapshot')).sha256, snapshot.sha256);
    });
    report.browser = await browser.version();
  } finally {
    clearTimeout(deadline); for (const gate of holds) gate.release();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
    console.log(JSON.stringify({ output, checks: report.checks, failures: report.failures, snapshot: report.snapshot }, null, 2));
    if (report.failures.length) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
