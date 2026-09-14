/* eslint-disable @typescript-eslint/no-require-imports -- Installed local browser tooling. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');
const origin = 'http://127.0.0.1:4510';
const startupTimeout = 60000;
const modelBases = ['/runs/ux-model-a/board', '/runs/ux-model-b/board'];
const artifactNames = new Set([
  'timing.json', 'product-spec.json', 'electronics/chipscale-board.json', 'electronics/chipscale.svg',
  'mechanical/mechanical.json', 'mechanical/enclosure.glb', 'disciplines/id-brief.json',
  ...['simulation', 'firmware', 'manufacturing', 'supplyChain', 'validation'].map(name => `disciplines/${name}.json`),
  ...['board', 'last-run', 'drc', 'recovery-loop', 'recovery', 'advanced-routing-report', 'sourcing-report',
    'assembly-readiness', 'fl1-validation', 'constraints', 'mcu-selection', 'bom', 'ato'].map(name => `data/${name}.json`),
  'board/render-top.png', 'board/render-bottom.png',
]);
// GET is not intrinsically safe: permit only audited fixture reads and the two
// synthetic export bases. The production board3d route is never a valid target.
function allowedRead(raw, method) {
  const url = new URL(raw);
  if (url.origin !== origin || !['GET', 'HEAD'].includes(method)) return false;
  const run = url.searchParams.get('run');
  const exactRun = ['ux-model-a', 'ux-model-b'].includes(run);
  if (['/api/auth/me', '/api/admin/me', '/api/runs', '/api/ux-preview/status', '/api/ux-preview/snapshot', '/api/astra'].includes(url.pathname))
    return method === 'GET' && !url.search;
  if (['/api/products', '/api/runs/work-items'].includes(url.pathname))
    return method === 'GET' && exactRun && [...url.searchParams.keys()].join(',') === 'run';
  if (url.pathname === '/api/board3d')
    return method === 'GET' && modelBases.includes(url.searchParams.get('base')) && [...url.searchParams.keys()].join(',') === 'base';
  const artifact = /^\/runs\/(ux-model-a|ux-model-b)\/(.+)$/.exec(url.pathname);
  if (!artifact || !artifactNames.has(artifact[2])) return false;
  return !url.search || (artifact[2] === 'electronics/chipscale.svg'
    && [...url.searchParams.keys()].join(',') === 't' && url.searchParams.get('t') === artifact[1]);
}
async function previewJson(route) {
  const response = await fetch(`${origin}${route}`, { redirect: 'error', signal: AbortSignal.timeout(startupTimeout) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-ui-preview'), 'synthetic-only');
  return response.json();
}

(async () => {
  assert.deepEqual(await previewJson('/api/ux-preview/status'), { preview: true, scenario: 'empty', providers: false, tools: false });
  const snapshot = await previewJson('/api/ux-preview/snapshot');
  assert.equal(snapshot.frozen, true, '3D acceptance requires a frozen snapshot');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ux-model-'));
  const report = { snapshot, output, checks: [], failures: [], errors: [], console: [], blocked: [], requests: [], expectedBlockedDiagnostics: [], notes: [
    'Prior run brqt13kt6 failed: initial readiness exceeded 15 seconds during a 15.9-second artifact-route compilation; HEAD artifact reads were incorrectly classified as mutations. That failed evidence remains retained.',
    'Run compose-ux-model-Puoo67 retained 12 passes and two readiness failures: a legacy PCBA control preceded the loaded chip-scale header, and the header preceded saved-board settlement. Readiness now awaits the settled normal-product controls in order.',
    'Run compose-ux-model-xESpjx retained 13 passes and one scope failure for blocked POST /__nextjs_original-stack-frames. Installed Next stack-frame.js:66-79 sends this diagnostic after intercept-console-error.js:53-57 handles the exact injected Three WebGL context error. Requests remain blocked; only one strictly matched diagnostic during that test is classified separately. Its former banner-only fallback pass did not establish settled fallback content.',
    'This run permits 60 seconds for cold navigation and a separate shared 60-second normal-product readiness budget, then 15 seconds per interaction. It is not a loading-performance benchmark.',
  ] };
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    report.failures.push({ name: 'Suite deadline', error: 'Model acceptance exceeded five minutes. Remaining checks were not executed.' });
    void browser.close();
  }, 300000);
  // Bound evidence in memory too; overflow is a failure, never a silent truncation.
  const append = (field, value) => {
    if (expired) return;
    if (report[field].length >= 3000) {
      expired = true;
      report.failures.push({ name: 'Evidence budget', error: `${field} exceeded 3000 entries. Remaining checks were not executed.` });
      void browser.close();
      return;
    }
    report[field].push(value);
  };
  let page; let activeCheck = ''; let expectedWebglErrorAt = 0;
  const webglCheck = 'Unavailable WebGL shows an honest normal-product fallback';
  const expectedWebglError = 'THREE.WebGLRenderer: THREE.WebGLRenderer: Error creating WebGL context.';
  const check = async (name, fn) => {
    if (expired) return;
    activeCheck = name;
    try { await fn(); if (!expired) report.checks.push(name); }
    catch (e) { report.failures.push({ name, error: String(e.stack || e).slice(0, 16000), body: (await page?.locator('body').innerText({ timeout: 2000 }).catch(() => '') || '').slice(0, 24000) }); }
    finally { activeCheck = ''; }
  };
  const expectedDiagnostic = req => {
    const url = new URL(req.url());
    if (activeCheck !== webglCheck || !expectedWebglErrorAt || Date.now() - expectedWebglErrorAt > 5000
      || report.expectedBlockedDiagnostics.length !== 0 || req.method() !== 'POST'
      || url.origin !== origin || url.pathname !== '/__nextjs_original-stack-frames' || url.search) return null;
    const raw = req.postData();
    if (!raw || Buffer.byteLength(raw) > 16384) return null;
    try {
      const body = JSON.parse(raw);
      if (Object.keys(body).sort().join(',') !== 'frames,isAppDirectory,isEdgeServer,isServer'
        || body.isServer !== false || body.isEdgeServer !== false || body.isAppDirectory !== true
        || !Array.isArray(body.frames) || !body.frames.length || body.frames.length > 30) return null;
      const files = body.frames.map(frame => String(frame.file || ''));
      if (!files.some(file => /\/components\/board-3d\.tsx/.test(file))
        || !body.frames.some(frame => /WebGLRenderer/.test(String(frame.methodName || ''))
          && /three(?:\/|[._])/.test(String(frame.file || '')))) return null;
      return { provenance: 'Injected WebGL context failure → Three WebGLRenderer console.error → Next development stack-frame lookup',
        consoleText: expectedWebglError, frameCount: body.frames.length,
        frames: body.frames.filter(frame => /WebGLRenderer|board-3d/.test(`${frame.methodName} ${frame.file}`))
          .map(frame => ({ file: frame.file, methodName: frame.methodName })).slice(0, 8) };
    } catch { return null; }
  };
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
    await context.route('**/*', route => {
      const req = route.request(); const url = new URL(req.url());
      if (url.origin !== origin) { append('blocked',{ url: req.url(), method: req.method(), reason: 'off-origin' }); return route.abort(); }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/runs/')) {
        append('requests',{ url: req.url(), method: req.method() });
        if (!allowedRead(req.url(), req.method())) {
          append('blocked',{ url: req.url(), method: req.method(), reason: 'outside exact read allowlist' });
          return route.abort();
        }
      } else if (req.method() !== 'GET') {
        const diagnostic = expectedDiagnostic(req);
        const entry = { url: req.url(), method: req.method(), reason: 'non-read page request', check: activeCheck };
        append('blocked', diagnostic ? { ...entry, classification: 'expected-development-diagnostic' } : entry);
        if (diagnostic) report.expectedBlockedDiagnostics.push({ ...entry, ...diagnostic, disposition: 'aborted before server delivery' });
        return route.abort();
      }
      return route.continue();
    });
    await context.routeWebSocket('**/*', ws => {
      const url = new URL(ws.url());
      if (url.protocol === 'ws:' && url.host === '127.0.0.1:4510' && url.pathname === '/_next/webpack-hmr') ws.connectToServer();
      else { append('blocked',{ url: ws.url(), reason: 'non-HMR socket' }); ws.close(); }
    });
    const newPage = async () => {
      const next = await context.newPage(); next.setDefaultTimeout(15000); next.setDefaultNavigationTimeout(startupTimeout);
      next.on('pageerror', e => append('errors', String(e.stack || e.message).slice(0, 16000)));
      next.on('console', m => {
        if (activeCheck === webglCheck && m.type() === 'error' && m.text() === expectedWebglError
          && m.location().url.includes('/next-devtools/userspace/app/errors/intercept-console-error.js')) expectedWebglErrorAt = Date.now();
        if (['warning', 'error'].includes(m.type())) append('console', { text: m.text().slice(0, 16000), location: m.location(), check: activeCheck });
      });
      next.on('download', download => { append('blocked',{ url: download.url(), reason: 'unexpected download' }); void download.cancel(); });
      return next;
    };
    page = await newPage();
    const button = name => page.getByRole('button', { name, exact: true });
    const viewer = () => page.locator('[data-viewer="board"]');
    const screenshot = name => page.screenshot({ caret: 'initial', path: path.join(output, `${name}.png`), fullPage: true });
    const terminalFallback = async () => {
      await viewer().getByText('PCBA preview unavailable. Inspect the saved layout or board report instead.', { exact: true }).waitFor();
      assert.equal(await viewer().getByText('rendering the PCBA…', { exact: true }).count(), 0);
      await viewer().getByRole('button', { name: 'Open Layout', exact: true }).waitFor();
      await viewer().getByRole('button', { name: 'Open Report', exact: true }).waitFor();
    };
    const productReady = async id => {
      await page.waitForURL(url => url.searchParams.get('run') === id, { timeout: startupTimeout });
      // Legacy electronics can expose PCBA while metadata loads. First wait for
      // the real chip-scale header, then its settled saved-board action and tabs.
      // All three waits share one budget rather than granting a minute apiece.
      const deadlineAt = Date.now() + startupTimeout;
      const remaining = () => {
        const timeout = deadlineAt - Date.now();
        assert.ok(timeout > 0, 'Normal chip-scale product did not settle within 60 seconds');
        return timeout;
      };
      const header = page.getByText('electronics · bespoke chip-down board', { exact: true });
      await header.waitFor({ timeout: remaining() });
      const stage = header.locator('..').locator('..');
      await stage.getByRole('button', { name: 'Regenerate', exact: true }).waitFor({ timeout: remaining() });
      await stage.getByRole('button', { name: 'PCBA', exact: true }).waitFor({ timeout: remaining() });
      assert.equal(await stage.getByRole('button', { name: 'Regenerate', exact: true }).count(), 1);
      assert.equal(await stage.getByText('Loading saved board…', { exact: true }).count(), 0);
    };
    const ready = async id => {
      await productReady(id);
      await page.locator('[data-viewer="board"][data-viewer-phase="ready"]').waitFor({ timeout: startupTimeout });
      await button('Top side').waitFor();
      assert.equal(await viewer().count(), 1);
      const canvas = viewer().locator('canvas');
      assert.equal(await page.locator('canvas').count(), 1);
      const bounds = await canvas.boundingBox();
      assert.ok(bounds && bounds.width > 100 && bounds.height > 100);
      await page.waitForTimeout(350);
    };
    await check('Normal chip-scale product renders a real GLB', async () => {
      await page.goto(`${origin}/compose?scenario=model-a&run=ux-model-a`, { waitUntil: 'domcontentloaded' });
      await ready('ux-model-a');
      assert.ok(report.requests.some(r => new URL(r.url).pathname === '/api/board3d'
        && new URL(r.url).searchParams.get('base') === modelBases[0]));
      await screenshot('model-a-perspective');
    });
    await check('Top and bottom controls render distinct geometry views', async () => {
      await ready('ux-model-a');
      await button('Top side').click(); await page.waitForTimeout(500);
      const top = await viewer().locator('canvas').screenshot({ caret: 'initial', path: path.join(output, 'model-a-top.png') });
      await button('Bottom side').click(); await page.waitForTimeout(500);
      const bottom = await viewer().locator('canvas').screenshot({ caret: 'initial', path: path.join(output, 'model-a-bottom.png') });
      assert.notDeepEqual(top, bottom);
      report.notes.push('Top/bottom images must be visually inspected for the board, component and underside marker; distinct bytes alone are not a geometry pass.');
    });
    await check('Orbit, zoom, pan and reset remain interactive', async () => {
      await button('Reset view').click(); await page.waitForTimeout(300);
      const canvas = viewer().locator('canvas'); const rect = await canvas.boundingBox();
      const before = await canvas.screenshot({ caret: 'initial' });
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await page.mouse.down(); await page.mouse.move(rect.x + rect.width / 2 + 80, rect.y + rect.height / 2 + 35, { steps: 8 }); await page.mouse.up();
      await page.mouse.wheel(0, -200); await page.waitForTimeout(400);
      await page.mouse.down({ button: 'right' }); await page.mouse.move(rect.x + rect.width / 2 + 40, rect.y + rect.height / 2, { steps: 5 }); await page.mouse.up({ button: 'right' });
      await page.waitForTimeout(400); assert.notDeepEqual(before, await canvas.screenshot({ caret: 'initial' }));
      await button('Reset view').click(); await screenshot('model-a-reset');
    });
    await check('Responsive canvas resizes without duplicate renderers', async () => {
      for (const viewport of [{ width: 1024, height: 768 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        if (viewport.width < 760) await button('Preview').click();
        await ready('ux-model-a');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await screenshot(`model-${viewport.width}`);
      }
      await page.setViewportSize({ width: 1440, height: 960 });
    });
    await check('Switch A to B to A replaces the model and preserves one canvas', async () => {
      for (const id of ['ux-model-b', 'ux-model-a']) {
        await button('Threads').click();
        await page.getByRole('button', { name: new RegExp(`^Synthetic ${id.slice(3)} board`) }).click();
        await ready(id); await screenshot(id);
      }
    });
    const modelPattern = '**/api/board3d?*';
    await check('Delayed GLB completion after PCBA unmount cannot install a stale canvas', async () => {
      await ready('ux-model-a');
      await button('Layout').click();
      let release; let observed;
      const held = new Promise(resolve => { release = resolve; });
      const requested = new Promise(resolve => { observed = resolve; });
      const releaseTimer = setTimeout(() => { observed(new Error('No synthetic model request observed within 15 seconds')); release(); }, 15000);
      let handlerFinished;
      const finished = new Promise(resolve => { handlerFinished = resolve; });
      const handler = async route => {
        if (!allowedRead(route.request().url(), route.request().method())) return route.fallback();
        append('requests',{ url: route.request().url(), method: route.request().method() });
        try {
          const response = await route.fetch({ timeout: 15000, maxRedirects: 0 });
          assert.equal(response.status(), 200);
          assert.equal(response.headers()['x-ui-preview'], 'synthetic-only');
          observed();
          await held;
          // Cancellation may already have closed the intercepted request.
          await route.fulfill({ response }).catch(() => {});
        } catch (error) { observed(error); } finally { handlerFinished(); }
      };
      await context.route(modelPattern, handler);
      try {
        await button('PCBA').click();
        const requestError = await requested;
        if (requestError) throw requestError;
        assert.equal(await viewer().getAttribute('data-viewer-phase'), 'loading');
        await button('Layout').click();
        await page.getByAltText('chip-scale PCB layout', { exact: true }).waitFor();
        assert.equal(await viewer().count(), 0);
        release(); await finished; await page.waitForTimeout(500);
        assert.equal(await viewer().count(), 0);
        assert.equal(await page.locator('canvas').count(), 0);
        await screenshot('delayed-model-unmounted');
      } finally { clearTimeout(releaseTimer); release(); await context.unroute(modelPattern, handler); }
      await button('PCBA').click(); await ready('ux-model-a');
    });
    await check('Corrupt GLB shows bounded fallback after a normal-product model request', async () => {
      await ready('ux-model-a');
      await button('Layout').click();
      let corrupted = 0;
      const handler = route => {
        if (!allowedRead(route.request().url(), route.request().method())) return route.fallback();
        append('requests',{ url: route.request().url(), method: route.request().method() });
        corrupted++;
        return route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: 'invalid synthetic GLB' });
      };
      await context.route(modelPattern, handler);
      try {
        await button('PCBA').click();
        await productReady('ux-model-a');
        await page.locator('[data-viewer="board"][data-viewer-phase="error"]').waitFor();
        assert.equal(corrupted, 1);
        await viewer().getByText(/3D model unavailable/).waitFor();
        await terminalFallback();
        assert.equal(await button('Top side').count(), 0);
        assert.equal(await page.locator('canvas').count(), 0);
        await screenshot('corrupt-model-fallback');
      } finally { await context.unroute(modelPattern, handler); }
      await button('Layout').click(); await button('PCBA').click(); await ready('ux-model-a');
    });
    const mechanicalReady = async id => {
      await page.waitForURL(url => url.searchParams.get('run') === id);
      await page.getByText('Synthetic viewer geometry, not an enclosure design', { exact: true }).waitFor();
      for (const kind of ['cad', 'assembly']) {
        const surface = page.locator(`[data-viewer="${kind}"][data-viewer-phase="ready"]`);
        await surface.waitFor({ timeout: startupTimeout });
        assert.equal(await surface.locator('canvas').count(), 1);
        const bounds = await surface.locator('canvas').boundingBox();
        assert.ok(bounds && bounds.width > 100 && bounds.height > 100);
      }
      assert.equal(await page.locator('canvas').count(), 2);
      assert.equal(await page.getByRole('link', { name: 'STEP', exact: true }).count(), 0);
      assert.equal(await page.getByRole('link', { name: 'Open in Onshape', exact: true }).count(), 0);
    };
    const selectStage = value => page.getByRole('combobox', { name: 'Preview stage', exact: true }).selectOption(value);
    await check('Saved mechanical artifacts render actual CAD and assembly without generation', async () => {
      await selectStage('mechanical'); await mechanicalReady('ux-model-a');
      for (const kind of ['assembly', 'cad']) {
        const surface = page.locator(`[data-viewer="${kind}"]`);
        await surface.screenshot({ caret: 'initial', path: path.join(output, `mechanical-${kind}-a.png`) });
        const canvas = surface.locator('canvas');
        const before = await canvas.screenshot({ caret: 'initial' });
        await surface.getByRole('button', { name: 'zoom in', exact: true }).click();
        await page.waitForTimeout(350);
        assert.notDeepEqual(before, await canvas.screenshot({ caret: 'initial' }));
        await surface.getByRole('button', { name: 'zoom out', exact: true }).click();
        await surface.getByRole('button', { name: 'fit', exact: true }).click();
      }
      const cad = page.locator('[data-viewer="cad"]');
      await cad.getByRole('button', { name: 'cross-section', exact: true }).click();
      const slider = cad.getByRole('slider', { name: 'section depth', exact: true });
      await slider.waitFor(); await slider.focus(); await slider.press('ArrowRight');
      assert.ok(Number(await slider.inputValue()) > 0.5);
      await cad.getByRole('button', { name: 'X', exact: true }).click();
      await cad.screenshot({ caret: 'initial', path: path.join(output, 'mechanical-cad-section.png') });
      await cad.getByRole('button', { name: 'cross-section', exact: true }).click();
      assert.equal(await slider.count(), 0);
      report.notes.push('Mechanical screenshots depict explicitly synthetic board-shaped geometry in both viewers, not a genuine enclosure, fit verification, or native CAD export. Inspect both images visually.');
    });
    await check('Mechanical A to B switches both saved models with no stale canvases', async () => {
      await button('Threads').click();
      await page.getByRole('button', { name: /^Synthetic model-b board/ }).click();
      await selectStage('mechanical'); await mechanicalReady('ux-model-b');
      for (const kind of ['assembly', 'cad']) {
        await page.locator(`[data-viewer="${kind}"]`).screenshot({ caret: 'initial', path: path.join(output, `mechanical-${kind}-b.png`) });
      }
      await selectStage('electronics'); await ready('ux-model-b');
      assert.equal(await page.locator('[data-viewer="cad"], [data-viewer="assembly"]').count(), 0);
    });
    await check('Corrupt saved enclosure errors in both mechanical viewers rather than substituting a shell', async () => {
      let corrupted = 0;
      const enclosurePattern = '**/runs/ux-model-b/mechanical/enclosure.glb';
      const handler = route => {
        if (!allowedRead(route.request().url(), route.request().method())) return route.fallback();
        append('requests',{ url: route.request().url(), method: route.request().method() });
        corrupted++;
        return route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: 'invalid synthetic enclosure GLB' });
      };
      await context.route(enclosurePattern, handler);
      try {
        await selectStage('mechanical');
        await page.getByText('Synthetic viewer geometry, not an enclosure design', { exact: true }).waitFor();
        for (const kind of ['cad', 'assembly']) {
          await page.locator(`[data-viewer="${kind}"][data-viewer-phase="error"]`).waitFor();
        }
        assert.ok(corrupted >= 2, 'Both viewers must request the corrupt enclosure');
        assert.equal(await page.locator('[data-viewer-phase="ready"]').count(), 0);
        assert.equal(await page.locator('canvas').count(), 0);
        await screenshot('mechanical-corrupt-enclosure');
      } finally { await context.unroute(enclosurePattern, handler); }
      await selectStage('electronics'); await ready('ux-model-b');
      await selectStage('mechanical'); await mechanicalReady('ux-model-b');
    });
    await check('Unavailable WebGL shows an honest normal-product fallback', async () => {
      await page.close(); page = await newPage();
      await page.addInitScript(() => {
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          if (['webgl', 'webgl2', 'experimental-webgl'].includes(type)) return null;
          return getContext.call(this, type, ...args);
        };
      });
      await page.goto(`${origin}/compose?scenario=model-a&run=ux-model-a`, { waitUntil: 'domcontentloaded' });
      await productReady('ux-model-a');
      await page.locator('[data-viewer="board"][data-viewer-phase="error"]').waitFor();
      await viewer().getByText(/3D model unavailable .*WebGL context/i).waitFor();
      await terminalFallback();
      assert.equal(await button('Top side').count(), 0);
      assert.equal(await page.locator('canvas').count(), 0);
      await screenshot('webgl-unavailable');
      await viewer().getByRole('button', { name: 'Open Layout', exact: true }).click();
      const layout = page.getByAltText('chip-scale PCB layout', { exact: true });
      await layout.waitFor();
      await page.waitForFunction(() => {
        const image = document.querySelector('img[alt="chip-scale PCB layout"]');
        return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
      });
      assert.equal(await viewer().count(), 0);
      await screenshot('webgl-layout-recovery');
    });
    await check('No uncaught or hydration errors', () => {
      assert.deepEqual(report.errors, []);
      assert.deepEqual(report.console.filter(m => /hydrat|did not match|caught.*error|error occurred|ChunkLoadError/i.test(m.text)), []);
    });
    await check('No off-origin attempts or requests outside exact synthetic read scope', () => {
      assert.deepEqual(report.blocked.filter(entry => entry.classification !== 'expected-development-diagnostic'), []);
      assert.ok(report.expectedBlockedDiagnostics.length <= 1);
      assert.equal(report.blocked.filter(entry => entry.classification === 'expected-development-diagnostic').length, report.expectedBlockedDiagnostics.length);
      assert.deepEqual(report.requests.filter(r => !allowedRead(r.url, r.method)), []);
    });
    await check('Frozen source identity remains unchanged throughout acceptance', async () => {
      const after = await previewJson('/api/ux-preview/snapshot');
      assert.equal(after.frozen, true); assert.equal(after.sha256, snapshot.sha256);
    });
    report.browser = await browser.version();
  } finally {
    clearTimeout(deadline);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close(); console.log(JSON.stringify(report, null, 2));
    if (report.failures.length) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
