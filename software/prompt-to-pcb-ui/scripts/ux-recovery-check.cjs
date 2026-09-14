/* eslint-disable @typescript-eslint/no-require-imports -- Standalone browser harness using already-installed tooling. */
// Synthetic-only frozen local preview. Run explicitly; no servers or providers are launched here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');
const origin = 'http://127.0.0.1:4510';
const onshape = 'https://cad.onshape.com/documents/synthetic/w/preview/e/assembly';
const syntheticFile = { name: 'synthetic-board.kicad_pcb', mimeType: 'application/octet-stream', buffer: Buffer.from('SYNTHETIC UI FIXTURE\nHand-authored import demonstration, not a KiCad board.\n') };

(async () => {
  const probe = async endpoint => {
    const response = await fetch(origin + endpoint, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-ui-preview'), 'synthetic-only');
    return response.json();
  };
  const status = await probe('/api/ux-preview/status');
  assert.equal(status.preview, true);
  assert.equal(status.providers, false);
  assert.equal(status.tools, false);
  const snapshot = await probe('/api/ux-preview/snapshot');
  assert.equal(snapshot.frozen, true, 'Acceptance requires --frozen preview, not a watched snapshot');
  assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ux-recovery-'));
  const report = { snapshot, status, checks: [], failures: [], notes: [], errors: [], consoleErrors: [], consoleWarnings: [], blocked: [], requests: [], responses: [], output };
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    report.failures.push({ name: 'Suite deadline', message: 'Recovery acceptance exceeded five minutes.' });
    void browser.close();
  }, 300000);
  let page;
  let chunkFailure = null;
  let held = null;
  let importsRegistered = Promise.resolve();
  const knownIds = new Set(['ux-completed', 'ux-partial']);
  async function check(name, callback) {
    if (expired) return;
    try {
      if (chunkFailure) throw new Error(chunkFailure);
      await callback();
      if (chunkFailure) throw new Error(chunkFailure);
      report.checks.push(name);
    } catch (error) {
      report.failures.push({ name, message: error.message, url: page?.url(), body: page && !page.isClosed() ? (await page.locator('body').innerText().catch(() => '')).slice(0, 16000) : '' });
      if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, `failure-${report.failures.length}.png`), fullPage: true }).catch(() => {});
      if (chunkFailure) throw error;
    } finally {
      held?.release(); held = null;
    }
  }
  // Hold only an exact synthetic request. Never fabricate or replace its response.
  function holdRequest(predicate) {
    assert.equal(held, null);
    let release;
    let hit;
    const ready = new Promise(resolve => { hit = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    held = { predicate, release, hit, wait, used: false };
    return { release, ready: () => Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Synthetic request hold was not reached')), 12000); timer.unref(); })]) };
  }
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) { report.blocked.push(request.url()); return route.abort(); }
      if (url.pathname === '/api/pipeline/run') {
        const id = url.searchParams.get('runId');
        if (!/^run-[a-f0-9-]{36}$/.test(id || '')) { report.blocked.push(request.url()); return route.abort(); }
        knownIds.add(id); // Browser-generated UUID, submitted only to the synthetic fixture.
      }
      const artifactId = /^\/runs\/([^/]+)\//.exec(url.pathname)?.[1];
      const listedId = url.pathname === '/api/runs/files' ? url.searchParams.get('run') : null;
      if (artifactId || listedId) await importsRegistered;
      if ((artifactId && !knownIds.has(artifactId)) || (listedId && !knownIds.has(listedId))) { report.blocked.push(request.url()); return route.abort(); }
      if (url.pathname.startsWith('/api/') || artifactId) report.requests.push({ path: url.pathname, query: url.search, method: request.method(), body: request.postData(), at: Date.now() });
      const gate = held;
      if (gate && !gate.used && gate.predicate(url, request)) { gate.used = true; gate.hit(); await gate.wait; }
      return route.continue().catch(error => { if (!/closed|cancel|abort|Invalid InterceptionId/i.test(error.message)) throw error; });
    });
    await context.routeWebSocket('**/*', ws => {
      const url = new URL(ws.url());
      if (url.protocol === 'ws:' && url.host === '127.0.0.1:4510' && url.pathname === '/_next/webpack-hmr') ws.connectToServer();
      else { report.blocked.push(ws.url()); ws.close(); }
    });
    await context.addInitScript(() => {
      window.__uxStreams = [];
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(url, options) {
          super(url, options);
          this.observation = { url: String(url), messages: [], malformed: [], closes: 0, errors: 0 };
          window.__uxStreams.push(this.observation);
          this.addEventListener('message', event => {
            // Malformed payloads are intentional fixtures, not observer pageerrors.
            try { this.observation.messages.push(JSON.parse(event.data)); }
            catch { this.observation.malformed.push(event.data); }
          });
          this.addEventListener('error', () => this.observation.errors++);
        }
        close() { this.observation.closes++; super.close(); }
      };
    });
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    const observeChunkFailure = message => {
      if (/ChunkLoadError|Loading chunk .+ failed|Failed to fetch dynamically imported module/i.test(message) && !chunkFailure) {
        chunkFailure = message; void page.close().catch(() => {});
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
      if (new URL(request.url()).pathname.startsWith('/_next/static/chunks/')) observeChunkFailure(`ChunkLoadError: ${request.url()} ${request.failure()?.errorText}`);
    });
    // Observe import IDs before the application can request their artifacts.
    const registerImport = async response => {
      const url = new URL(response.url());
      if (['/api/pipeline/import', '/api/pipeline/import-onshape'].includes(url.pathname) && response.status() === 200) {
        const data = await response.json().catch(() => null);
        if (/^run-[a-f0-9-]{36}$/.test(data?.runId || '')) knownIds.add(data.runId);
      }
    };
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/runs/')) report.responses.push({ path: url.pathname, status: response.status() });
      if (['/api/pipeline/import', '/api/pipeline/import-onshape'].includes(url.pathname)) importsRegistered = importsRegistered.then(() => registerImport(response));
    });
    const button = name => page.getByRole('button', { name, exact: true });
    const screenshot = name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
    const streams = () => page.evaluate(() => window.__uxStreams);
    const selected = () => new URL(page.url()).searchParams.get('run');
    const go = async (scenario, run) => {
      await page.goto(`${origin}/compose?scenario=${scenario}${run ? `&run=${run}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await button('Account').waitFor();
      await page.waitForFunction(() => {
        const input = document.querySelector('textarea');
        return input && Object.keys(input).some(key => key.startsWith('__reactProps$'));
      });
    };
    const chooseRun = async name => {
      await button('Threads').click();
      await page.getByRole('button', { name: new RegExp(`^Synthetic ${name} board`) }).click();
      await page.waitForFunction(id => new URL(location.href).searchParams.get('run') === id, `ux-${name}`);
    };

    await check('Files tree renders markdown, text, JSON, CSV, image and honest binary fallback', async () => {
      await go('completed', 'ux-completed');
      await button('Files').click();
      await button('Preview README.md').click();
      await page.getByRole('heading', { name: 'Synthetic design ux-completed', exact: true }).waitFor();
      await button('Preview notes.txt').click();
      await page.getByText('Synthetic notes belonging only to ux-completed.', { exact: true }).waitFor();
      await button('Preview data/board.json').click();
      const board = JSON.parse(await page.locator('#workspace-preview pre').innerText());
      assert.equal(board.components, 8); assert.equal(board.source, 'SYNTHETIC-UI-FIXTURE.kicad_pcb');
      await button('Preview data/parts.csv').click();
      await page.getByRole('cell', { name: 'Synthetic sensor', exact: true }).waitFor();
      await button('Expand board').click();
      await button('Preview board/render-top.png').click();
      await page.getByRole('img', { name: 'render-top.png', exact: true }).waitFor();
      await page.waitForFunction(() => { const img = document.querySelector('img[alt="render-top.png"]'); return img?.complete && img.naturalWidth > 0 && getComputedStyle(img).visibility !== 'hidden'; });
      await screenshot('files-image');
      await button('Preview fabrication.zip').click();
      await page.getByText('Binary or unsupported file', { exact: false }).waitFor();
      assert.equal(await page.getByRole('link', { name: 'Download fabrication.zip', exact: true }).getAttribute('href'), '/runs/ux-completed/fabrication.zip');
      // Do not click downloads. This asserts an honest download-only affordance.
      assert.equal(report.requests.filter(request => request.path === '/runs/ux-completed/fabrication.zip').length, 0);
      await screenshot('files-binary');
      await button('Close fabrication.zip').click();
      await page.getByRole('img', { name: 'render-top.png', exact: true }).waitFor();
      for (const name of ['render-top.png', 'parts.csv', 'board.json', 'notes.txt', 'README.md']) await button(`Close ${name}`).click();
      assert.equal(await button('Back to stage').count(), 0);
      assert.equal(await page.getByRole('link', { name: /^Download / }).count(), 0);
    });

    await check('File documents close on A/B selection and delayed A work cannot populate B', async () => {
      await go('completed', 'ux-completed');
      await button('Files').click();
      await button('Preview notes.txt').click();
      await page.getByText('Synthetic notes belonging only to ux-completed.', { exact: true }).waitFor();
      const gate = holdRequest(url => url.pathname === '/runs/ux-completed/README.md');
      await button('Preview README.md').click();
      await gate.ready();
      await chooseRun('partial');
      assert.equal(await button('Close README.md').count(), 0);
      assert.equal(await button('Close notes.txt').count(), 0);
      await button('Files').click();
      await button('Preview README.md').click();
      await page.getByRole('heading', { name: 'Synthetic design ux-partial', exact: true }).waitFor();
      gate.release();
      await page.waitForTimeout(300);
      assert.equal(await page.getByRole('heading', { name: 'Synthetic design ux-completed', exact: true }).count(), 0);
      await button('Preview notes.txt').click();
      await page.getByText('Synthetic notes belonging only to ux-partial.', { exact: true }).waitFor();
      assert.equal(await page.getByText('Synthetic notes belonging only to ux-completed.', { exact: true }).count(), 0);
      await screenshot('files-b-isolated');
      report.notes.push('A request was held before dispatch, then released after selecting B; this checks loading/cancellation isolation, not a forced stale response fulfillment.');
    });

    for (const kind of ['file', 'onshape']) for (const scenario of ['import-success', 'import-error', 'import-malformed']) {
      await check(`${kind} ${scenario}: busy guard, retained input or valid synthetic selection`, async () => {
        await go(scenario);
        const name = page.getByRole('textbox', { name: 'Imported design name', exact: true });
        const urlInput = page.getByRole('textbox', { name: 'Onshape assembly URL', exact: true });
        await name.fill('Synthetic retained import name');
        await page.getByLabel('PCBA', { exact: true }).setInputFiles(syntheticFile);
        await urlInput.fill(onshape);
        const endpoint = kind === 'file' ? '/api/pipeline/import' : '/api/pipeline/import-onshape';
        const before = report.requests.filter(request => request.path === endpoint).length;
        const gate = holdRequest(url => url.pathname === endpoint);
        await button(kind === 'file' ? 'Import design' : 'Import from Onshape').click();
        await gate.ready();
        assert.equal(await page.getByRole('button', { name: 'Importing…', exact: true }).count(), 2);
        for (const importing of await page.getByRole('button', { name: 'Importing…', exact: true }).all()) assert.equal(await importing.isDisabled(), true);
        await button('New design').first().click();
        await page.getByText('Finish or stop the current operation before switching designs.', { exact: false }).waitFor();
        assert.equal(await name.inputValue(), 'Synthetic retained import name');
        assert.equal(selected(), null);
        assert.equal(await page.locator('textarea').evaluate(element => !!element.closest('[inert]')), true);
        assert.equal(report.requests.filter(request => request.path === endpoint).length, before + 1);
        const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === endpoint);
        gate.release();
        const response = await responsePromise;
        await registerImport(response);
        if (scenario === 'import-success') {
          const data = await response.json();
          assert.match(data.runId, /^run-[a-f0-9-]{36}$/);
          await page.waitForFunction(id => new URL(location.href).searchParams.get('run') === id, data.runId);
          await page.getByRole('combobox', { name: 'Preview stage', exact: true }).selectOption(kind === 'file' ? 'electronics' : 'mechanical');
          await page.getByRole('heading', { name: kind === 'file' ? 'Imported PCB' : 'Imported CAD assembly', exact: true }).waitFor();
          const download = page.getByRole('link', { name: kind === 'file' ? 'Download imported KiCad board' : 'STEP', exact: true });
          assert.equal(await download.getAttribute('href'), `/runs/${data.runId}/${kind === 'file' ? 'variant.kicad_pcb' : 'mechanical/enclosure.step'}`);
          assert.equal(await page.locator('[data-viewer]').count(), 0);
          assert.equal(report.requests.filter(request => request.path === '/api/board3d' && request.query.includes(data.runId)).length, 0, 'Opening an import must not invoke a native export');
          assert.doesNotMatch(await page.locator('#workspace-preview').innerText(), /saved artifact is invalid/i);
          await screenshot(`${kind}-import-retained-view`);
          await button('Files').click();
          await button('Preview README.md').click();
          await page.getByRole('heading', { name: `Synthetic design ${data.runId}`, exact: true }).waitFor();
          report.notes.push({ kind, scenario, runId: data.runId });
        } else {
          await page.getByText(scenario === 'import-error' ? 'Synthetic import rejected. Keep your input and retry.' : 'Import response did not include a valid run ID. Your inputs are unchanged.', { exact: true }).waitFor();
          assert.equal(selected(), null);
          assert.equal(await name.inputValue(), 'Synthetic retained import name');
          assert.equal(await urlInput.inputValue(), onshape);
          assert.equal(await page.getByLabel('PCBA', { exact: true }).evaluate(input => input.files?.[0]?.name), syntheticFile.name);
          assert.equal(await button('Import design').isEnabled(), true);
          assert.equal(await button('Import from Onshape').isEnabled(), true);
          assert.equal(await page.locator('textarea').evaluate(element => !!element.closest('[inert]')), false);
        }
        await screenshot(`${kind}-${scenario}`);
      });
    }

    await check('Busy interview rejects import without losing synthetic file or URL input', async () => {
      await go('import-success');
      await page.getByLabel('PCBA', { exact: true }).setInputFiles(syntheticFile);
      const urlInput = page.getByRole('textbox', { name: 'Onshape assembly URL', exact: true });
      await urlInput.fill(onshape);
      const gate = holdRequest(url => url.pathname === '/api/architect');
      await page.getByRole('textbox', { name: 'Describe your product or board', exact: true }).fill('Synthetic busy interview guard');
      await button('Send ↵').click();
      await gate.ready();
      const importsBefore = report.requests.filter(request => ['/api/pipeline/import', '/api/pipeline/import-onshape'].includes(request.path)).length;
      for (const label of ['Import design', 'Import from Onshape']) {
        await button(label).click();
        await page.getByText('Finish or stop the current conversation operation before importing.', { exact: true }).waitFor();
      }
      assert.equal(report.requests.filter(request => ['/api/pipeline/import', '/api/pipeline/import-onshape'].includes(request.path)).length, importsBefore);
      assert.equal(await urlInput.inputValue(), onshape);
      assert.equal(await page.getByLabel('PCBA', { exact: true }).evaluate(input => input.files?.[0]?.name), syntheticFile.name);
      gate.release();
      await page.waitForFunction(() => !document.querySelector('textarea').disabled);
      await screenshot('import-blocked-during-interview');
    });

    const start = async scenario => {
      await go(scenario);
      await button('New design').last().click();
      const input = page.getByRole('textbox', { name: 'Describe your product or board', exact: true });
      await input.fill(`Synthetic recovery ${scenario} sensor board`);
      await button('Send ↵').click();
      await page.getByText('Offline preview: reply finish to explicitly launch a synthetic build. No provider or tool will run.', { exact: false }).waitFor();
      await page.getByRole('textbox', { name: 'Answer the design question', exact: true }).fill('finish');
      await button('Send ↵').click();
      await page.waitForFunction(() => window.__uxStreams.length === 1 && window.__uxStreams[0].messages.some(event => event.id === 'placement'));
      return new URL((await streams())[0].url, origin).searchParams.get('runId');
    };
    for (const scenario of ['manual-disconnect', 'build-malformed', 'build-disconnect']) {
      await check(`${scenario}: observation ends honestly without claiming server failure or cancellation`, async () => {
        const id = await start(scenario === 'manual-disconnect' ? 'build-disconnect' : scenario);
        if (scenario === 'manual-disconnect') await button('Disconnect updates').click();
        await page.locator('#compose-chat-error').waitFor();
        const message = await page.locator('#compose-chat-error').innerText();
        assert.match(message, /server may still be working/i);
        if (scenario === 'manual-disconnect') assert.match(message, /does not cancel server execution/);
        if (scenario === 'build-malformed') assert.match(message, /Invalid build update/);
        if (scenario === 'build-disconnect') assert.match(message, /Connection lost before the build finished/);
        assert.equal(selected(), id);
        await page.getByRole('option', { name: 'Electronics · Outcome unknown', exact: true }).waitFor({ state: 'attached' });
        await page.getByText('Build outcome unknown', { exact: true }).first().waitFor();
        const placement = page.locator('span').filter({ hasText: /^Placement$/ }).locator('..');
        assert.match(await placement.innerText(), /Updates disconnected/);
        assert.doesNotMatch(await placement.innerText(), /Failed/);
        assert.equal(await placement.locator('.animate-spin').count(), 0);
        assert.equal(await button('Switch design conversation').isEnabled(), true);
        assert.equal(await button('Start a new build').isEnabled(), true);
        assert.equal(await page.locator('textarea').isEnabled(), true);
        const state = (await streams())[0];
        assert.equal(state.closes, 1);
        assert.equal(state.messages.some(event => ['done', 'error'].includes(event.type)), false);
        assert.equal(state.malformed.length, scenario === 'build-malformed' ? 1 : 0);
        if (scenario === 'build-disconnect') assert.ok(state.errors >= 1);
        await screenshot(scenario);
        report.notes.push({ scenario, runId: id, message, stream: state, serverOutcome: 'unknown; browser observation is not definitive server failure' });
      });
    }
    report.browser = await browser.version();
    await check('Frozen snapshot SHA remains unchanged', async () => {
      const finalSnapshot = await probe('/api/ux-preview/snapshot');
      assert.equal(finalSnapshot.frozen, true);
      assert.equal(finalSnapshot.sha256, snapshot.sha256);
    });
    await check('No uncaught browser errors', () => assert.deepEqual(report.errors, []));
    await check('No hydration or caught component errors', () => {
      assert.deepEqual([...report.consoleErrors, ...report.consoleWarnings].filter(entry => /hydrat|server rendered|did not match|error occurred|caught.*error|errorboundary|ChunkLoadError|Loading chunk/i.test(entry.text)), []);
    });
    await check('No cross-origin or unknown run requests attempted', () => assert.deepEqual(report.blocked, []));
  } finally {
    clearTimeout(deadline);
    held?.release();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
    console.log(JSON.stringify(report, null, 2));
    if (report.failures.length) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
