/* eslint-disable @typescript-eslint/no-require-imports -- Standalone browser harness using already-installed tooling. */
// Actual Compose components, synthetic-only local preview. No providers or real run data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');
const origin = 'http://127.0.0.1:4510';

(async () => {
  const probe = await fetch(`${origin}/api/ux-preview/status`, { redirect: 'error' });
  assert.equal(probe.status, 200);
  assert.equal(probe.headers.get('x-ui-preview'), 'synthetic-only');
  const status = await probe.json();
  assert.equal(status.preview, true);
  assert.equal(status.providers, false);
  assert.equal(status.tools, false);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ux-build-'));
  const report = { checks: [], failures: [], notes: [], errors: [], consoleErrors: [], consoleWarnings: [], blocked: [], requests: [], responses: [], output };
  let chunkFailure = null;
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  let page;
  async function check(name, callback) {
    try { if (chunkFailure) throw new Error(chunkFailure); await callback(); if (chunkFailure) throw new Error(chunkFailure); report.checks.push(name); }
    catch (error) {
      report.failures.push({ name, message: error.message, url: page?.url(), body: page && !page.isClosed() ? (await page.locator('body').innerText().catch(() => '')).slice(0, 16000) : '' });
      if (chunkFailure) throw error;
    }
  }
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) { report.blocked.push(request.url()); return route.abort(); }
      if (url.pathname.startsWith('/api/')) report.requests.push({ path: url.pathname, query: url.search, method: request.method(), body: request.postData(), at: Date.now() });
      return route.continue();
    });
    await context.routeWebSocket('**/*', ws => {
      const url = new URL(ws.url());
      if (url.protocol === 'ws:' && url.host === '127.0.0.1:4510' && url.pathname === '/_next/webpack-hmr') ws.connectToServer();
      else { report.blocked.push(ws.url()); ws.close(); }
    });
    // Observe native EventSource lifecycle without changing or fulfilling responses.
    await context.addInitScript(() => {
      window.__uxStreams = [];
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(url, options) {
          super(url, options);
          this.observation = { url: String(url), messages: [], closes: 0, errors: 0 };
          window.__uxStreams.push(this.observation);
          this.addEventListener('message', event => this.observation.messages.push(JSON.parse(event.data)));
          this.addEventListener('error', () => this.observation.errors++);
        }
        close() { this.observation.closes++; super.close(); }
      };
    });
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    const observeChunkFailure = message => {
      if (/ChunkLoadError|Loading chunk .+ failed|Failed to fetch dynamically imported module/i.test(message) && !chunkFailure) {
        chunkFailure = message;
        void page.close().catch(() => {});
      }
    };
    page.on('pageerror', error => { report.errors.push(error.stack || error.message); observeChunkFailure(error.message); });
    page.on('console', message => {
      const entry = { text: message.text(), location: message.location() };
      if (message.type() === 'error') report.consoleErrors.push(entry);
      if (message.type() === 'warning') report.consoleWarnings.push(entry);
      observeChunkFailure(message.text());
    });
    page.on('requestfailed', request => {
      if (new URL(request.url()).pathname.startsWith('/_next/static/chunks/')) {
        observeChunkFailure(`ChunkLoadError: ${request.url()} ${request.failure()?.errorText}`);
      }
    });
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/runs/')) report.responses.push({ path: url.pathname, status: response.status() });
    });
    const button = name => page.getByRole('button', { name, exact: true });
    const streamState = () => page.evaluate(() => window.__uxStreams);
    const screenshot = name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
    const start = async scenario => {
      await page.goto(`${origin}/compose?scenario=${scenario}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await button('Account').waitFor();
      await page.waitForFunction(() => { const input = document.querySelector('textarea'); return input && Object.keys(input).some(key => key.startsWith('__reactProps$')); });
      await button('New design').last().click();
      await page.waitForTimeout(150);
      const input = page.getByRole('textbox', { name: 'Describe your product or board', exact: true });
      await input.fill(`Synthetic browser ${scenario} sensor board`);
      await button('Send ↵').click();
      await page.getByText('Offline preview: reply finish to explicitly launch a synthetic build. No provider or tool will run.', { exact: false }).waitFor();
      await page.getByRole('textbox', { name: 'Answer the design question', exact: true }).fill('finish');
      await page.evaluate(() => { window.__uxComposer = document.querySelector('textarea'); });
      await button('Send ↵').click();
      await page.waitForFunction(() => window.__uxStreams.length === 1 && window.__uxStreams[0].messages.length > 0);
      const streams = await streamState();
      return new URL(streams[0].url).searchParams.get('runId');
    };

    for (const scenario of ['build-error', 'build-success']) {
      await check(`${scenario}: actual interview starts one synthetic SSE build`, async () => {
        const id = await start(scenario);
        assert.match(id, /^run-[a-f0-9-]{36}$/);
        assert.equal(new URL(page.url()).searchParams.get('run'), id);
        assert.equal(await page.evaluate(() => window.__uxComposer === document.querySelector('textarea')), true);
        report.notes.push({ scenario, runId: id });
        await check(`${scenario}: initial SSE is shown as electronics running without invented passes`, async () => {
          await page.getByRole('option', { name: 'Electronics · running', exact: true }).waitFor({ state: 'attached' });
          const body = await page.locator('body').innerText();
          assert.match(body, /Build in progress/);
          assert.match(body, /0 passed/);
          assert.match(body, /Initial board build in progress; discipline pipeline has not started/);
          assert.equal(await page.getByText('Build not started', { exact: true }).count(), 0);
        });
        await check(`${scenario}: busy chat disables switching, new conversation and input`, async () => {
          assert.equal(await button('Switch design conversation').isDisabled(), true);
          assert.equal(await button('New').isDisabled(), true);
          assert.equal(await page.locator('textarea').isDisabled(), true);
        });
        await button('Threads').click();
        await check(`${scenario}: promoted draft no longer appears as unsaved`, async () => {
          assert.equal(await page.getByRole('button', { name: /^Unsaved draft/ }).count(), 1);
          // The untouched initial draft remains; the submitted second draft is promoted.
          assert.equal(await page.getByRole('button', { name: 'Unsaved draft 2', exact: true }).count(), 0);
        });
        await page.getByRole('button', { name: /^Synthetic completed board/ }).click();
        await check(`${scenario}: thread selection is rejected while build is busy`, async () => {
          await page.getByText('Finish or stop the current operation before switching designs. You can still browse stages, files and details.', { exact: true }).waitFor();
          assert.equal(new URL(page.url()).searchParams.get('run'), id);
        });
        await button('New design').first().click();
        await check(`${scenario}: new design is rejected while build is busy`, async () => {
          assert.equal(new URL(page.url()).searchParams.get('run'), id);
        });
        await button('Files').click();
        await check(`${scenario}: Files utility preserves active stream`, async () => {
          assert.equal(await page.evaluate(() => window.__uxComposer.isConnected), true);
          assert.equal(await page.locator('textarea').isVisible(), false);
          const before = (await streamState())[0].messages.length;
          await page.waitForFunction(count => window.__uxStreams[0].messages.length > count, before);
          const streams = await streamState();
          assert.equal(streams.length, 1);
          assert.equal(streams[0].closes, 0);
          assert.equal(streams[0].errors, 0);
          report.notes.push({ scenario, filesPanel: (await page.locator('body').innerText()).includes('Could not list files:') ? 'Fixture does not serve file-list API; panel error visible. No file-tree browsing claimed.' : 'File-list surface available' });
        });
        await screenshot(`${scenario}-files-streaming`);
        await button('Chat').click();
        await check(`${scenario}: returning to chat retains conversation and stream`, async () => {
          assert.equal(await page.evaluate(() => window.__uxComposer === document.querySelector('textarea')), true);
          assert.equal(await page.getByText('finish', { exact: true }).isVisible(), true);
          await page.getByText('ato: Synthetic stream. No tools or providers execute.', { exact: true }).waitFor();
          assert.equal((await streamState()).length, 1);
        });
        await page.waitForFunction(() => window.__uxStreams[0].messages.some(event => event.type === 'done' || event.type === 'error'));
        if (scenario === 'build-error') {
          await check('Explicit SSE error reaches visible chat alert and preserved run', async () => {
            await page.locator('#compose-chat-error').waitFor();
            assert.match(await page.locator('#compose-chat-error').innerText(), /Synthetic build failure for callback and recovery testing/);
            assert.equal(new URL(page.url()).searchParams.get('run'), id);
            assert.equal(await button('Start a new build').isEnabled(), true);
            assert.equal(await button('Switch design conversation').isEnabled(), true);
          });
          await check('Explicit SSE error settles Placement and workspace shows blocked electronics', async () => {
            const placement = page.locator('span').filter({ hasText: /^Placement$/ }).locator('..');
            assert.equal(await placement.count(), 1);
            assert.equal(await placement.locator('.animate-spin').count(), 0);
            assert.match(await placement.innerText(), /Failed/);
            await page.getByRole('option', { name: 'Electronics · blocked', exact: true }).waitFor({ state: 'attached' });
            const body = await page.locator('body').innerText();
            assert.match(body, /Build needs attention/);
            assert.match(body, /0 passed/);
            assert.match(body, /1 blocked/);
            assert.match(body, /Initial board build needs attention before the discipline pipeline can start/);
            assert.equal(await page.getByRole('option', { name: 'Electronics · not started', exact: true }).count(), 0);
            assert.equal(await page.getByText('Build not started', { exact: true }).count(), 0);
          });
          await screenshot(`${scenario}-finished`);
          await check('Build retry preserves edited composer input and uses a new run ID', async () => {
            const retained = 'Synthetic retained edit after failed build';
            await page.locator('textarea').fill(retained);
            await button('Start a new build').click();
            await page.waitForFunction(() => window.__uxStreams.length === 2 && window.__uxStreams[1].messages.length > 0);
            assert.equal(await page.locator('textarea').inputValue(), retained);
            const streams = await streamState();
            assert.notEqual(new URL(streams[1].url).searchParams.get('runId'), id);
            assert.equal(new URL(streams[1].url).searchParams.get('prompt'), new URL(streams[0].url).searchParams.get('prompt'));
            await page.waitForFunction(() => window.__uxStreams[1].messages.some(event => event.type === 'error'));
            assert.equal(await page.locator('textarea').inputValue(), retained);
          });
        } else {
          await check('Successful SSE completion preserves session and records artifact retrieval', async () => {
            await page.waitForFunction(() => window.__uxStreams[0].closes === 1);
            assert.equal((await streamState())[0].messages.at(-1).type, 'done');
            assert.equal(new URL(page.url()).searchParams.get('run'), id);
            assert.equal(await page.evaluate(() => window.__uxComposer === document.querySelector('textarea')), true);
            await page.waitForFunction(() => !document.querySelector('textarea').disabled);
            await page.getByText('This is an offline interview fixture. What supply voltage should this demonstration board use?', { exact: true }).waitFor();
            const body = await page.locator('body').innerText();
            assert.match(body, /UI preview blocked POST \/api\/electronics-cs/);
            assert.match(body, /Synthetic live passed board/);
            assert.equal(report.responses.some(response => response.path === `/runs/${id}/data/board.json` && response.status === 200), true);
            assert.match(body, /ato: Synthetic stream\. No tools or providers execute\./);
            const placement = page.locator('span').filter({ hasText: /^Placement$/ }).locator('..');
            assert.equal(await placement.locator('.animate-spin').count(), 0);
            assert.match(await placement.innerText(), /Result not reported/);
            report.notes.push({ scenario, finalBody: body.slice(0, 14000), explanation: 'Downstream electronics-cs 403 is intentional fixture behavior.' });
          });
          await check('Accepted Architect turns remain display-only history across Industrial Design handoff', async () => {
            const history = page.getByRole('region', { name: 'Product Architect conversation', exact: true });
            await history.waitFor();
            assert.equal(await history.getByText('finish', { exact: true }).isVisible(), true);
            assert.match(await history.innerText(), /Offline preview: reply finish to explicitly launch a synthetic build/);
            assert.equal(await history.locator('textarea, input, button').count(), 0);
            const idRequests = report.requests.filter(request => request.path === '/api/industrial-design' && JSON.parse(request.body || '{}').runId === id);
            assert.equal(idRequests.length, 1);
            assert.deepEqual(JSON.parse(idRequests[0].body).answers, []);
            assert.equal(await page.evaluate(() => window.__uxComposer === document.querySelector('textarea')), true);
          });
          await screenshot(`${scenario}-finished`);
        }
        report.notes.push({ scenario, streams: await streamState() });
      });
    }
    await check('Failed interview retry retains exact submitted input', async () => {
      await page.goto(`${origin}/compose?scenario=network-error`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await button('Account').waitFor();
      await page.waitForFunction(() => { const input = document.querySelector('textarea'); return input && Object.keys(input).some(key => key.startsWith('__reactProps$')); });
      await button('New design').last().click();
      await page.waitForTimeout(150);
      const input = page.getByRole('textbox', { name: 'Describe your product or board', exact: true });
      const retained = 'Synthetic retained 3.3 V sensor request';
      await input.fill(retained);
      await button('Send ↵').click();
      await page.locator('#compose-chat-error').waitFor();
      assert.match(await page.locator('#compose-chat-error').innerText(), /Synthetic network failure/);
      assert.equal(await input.inputValue(), retained);
      await button('Retry this interview step').click();
      await page.locator('#compose-chat-error').waitFor();
      assert.equal(await input.inputValue(), retained);
      const posts = report.requests.filter(request => request.path === '/api/architect').slice(-2);
      assert.equal(posts.length, 2);
      assert.equal(posts[0].body, posts[1].body);
      await screenshot('interview-retry-input');
    });
    report.browser = await browser.version();
    await check('No uncaught browser errors', () => assert.deepEqual(report.errors, []));
    await check('No hydration or caught component errors in browser console', () => {
      const issues = [...report.consoleErrors, ...report.consoleWarnings].filter(entry => /hydrat|server rendered|did not match|error occurred|caught.*error|errorboundary|ChunkLoadError|Loading chunk/i.test(entry.text));
      assert.deepEqual(issues, []);
    });
    await check('No cross-origin requests attempted', () => assert.deepEqual(report.blocked, []));
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
    console.log(JSON.stringify(report, null, 2));
    if (report.failures.length) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
