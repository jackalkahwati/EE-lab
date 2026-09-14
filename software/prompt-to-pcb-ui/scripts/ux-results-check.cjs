/* eslint-disable @typescript-eslint/no-require-imports -- Standalone installed-tooling browser harness. */
/* Actual Chrome, owned offline preview only. Legacy-artwork mode omits product-spec.json
 * explicitly to exercise the existing non-chipscale viewer; all other data comes from
 * the synthetic preview server. No GLB exists, so this does not test actual 3D. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');
const origin = 'http://127.0.0.1:4510';
(async () => {
  const probe = await fetch(`${origin}/api/ux-preview/status`, { redirect: 'error' });
  assert.equal(probe.headers.get('x-ui-preview'), 'synthetic-only');
  assert.equal((await probe.json()).preview, true);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ux-results-'));
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const errors = [], blocked = [], requests = [], checks = [], screenshots = [], observations = [], consoleErrors = [];
  let legacyArtwork = false;
  const check = (name, value) => { assert.equal(value, true, name); checks.push(name); };
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(60000);
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) { blocked.push(request.url()); return route.abort(); }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/runs/')) requests.push({ method: request.method(), path: url.pathname, scenario: request.headers()['x-ux-scenario'] });
      if (legacyArtwork && /^\/runs\/ux-(completed|partial)\/product-spec\.json$/.test(url.pathname)) return route.fulfill({ status: 404, contentType: 'application/json', headers: { 'x-ui-preview': 'synthetic-only' }, body: JSON.stringify({ error: 'Explicit legacy-artwork fixture: no product spec', preview: true }) });
      return route.continue();
    });
    await context.routeWebSocket('**/*', ws => {
      const url = new URL(ws.url());
      if (url.host === '127.0.0.1:4510' && url.pathname === '/_next/webpack-hmr') ws.connectToServer(); else ws.close();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.stack || error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 8000)); });
    const shot = async name => { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file, fullPage: true }); screenshots.push(file); };
    const visit = async scenario => {
      const response = await page.goto(`${origin}/compose?scenario=${scenario}&run=ux-${scenario}`, { waitUntil: 'domcontentloaded' });
      check(`${scenario} document is synthetic-only`, response.headers()['x-ui-preview'] === 'synthetic-only');
      // SSR content and networkidle are not hydration readiness signals.
      await page.getByText(`Synthetic ${scenario} board`, { exact: true }).first().waitFor();
      await page.waitForFunction(s => document.querySelector('select[aria-label="Preview scenario"]')?.value === s, scenario);
    };
    const selectRun = async scenario => {
      await page.getByRole('button', { name: 'Threads', exact: true }).click();
      await page.getByRole('button', { name: new RegExp(`^Synthetic ${scenario} board`) }).click();
      await page.getByRole('button', { name: 'Chat', exact: true }).click();
      await page.waitForFunction(id => new URL(location.href).searchParams.get('run') === id, `ux-${scenario}`);
    };
    const prompt = page.getByRole('textbox', { name: 'Describe a design revision', exact: true });
    await visit('completed');
    await page.getByText('Synthetic isolation board A', { exact: true }).waitFor();
    check('Saved completed deep link restores selected run without dropping scenario', new URL(page.url()).search === '?scenario=completed&run=ux-completed');
    check('Saved spec A visible', await page.getByText('Synthetic isolation board A', { exact: true }).isVisible());
    await prompt.fill('Synthetic draft A retained for completed board');
    await selectRun('partial');
    await page.getByText('Synthetic isolation board B', { exact: true }).waitFor();
    check('Selection B clears spec A', await page.getByText('Synthetic isolation board A', { exact: true }).count() === 0);
    check('Selection B has independent draft', await prompt.inputValue() === '');
    check('Partial failure preserves explicit diagnostic', await page.getByText('Synthetic downstream failure. Previously generated illustration remains available.', { exact: true }).isVisible());
    await prompt.fill('Synthetic draft B retained for partial board');
    await selectRun('completed');
    await page.getByText('Synthetic isolation board A', { exact: true }).waitFor();
    check('Returning to A restores its draft', await prompt.inputValue() === 'Synthetic draft A retained for completed board');
    check('Returning to A clears B spec', await page.getByText('Synthetic isolation board B', { exact: true }).count() === 0);
    await selectRun('completed');
    check('Reselecting A keeps saved evidence', await page.getByText('Synthetic isolation board A', { exact: true }).isVisible());
    check('Reselecting A keeps draft', await prompt.inputValue() === 'Synthetic draft A retained for completed board');
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    observations.push(`Saved details: ${(await page.getByRole('complementary', { name: 'Design details' }).innerText()).slice(0, 1500)}`);
    await shot('saved-spec-desktop');
    observations.push('Completed product-spec fixture has no chipscale-board.json, so its electronics stage correctly shows missing chip-scale artifact. Artwork checks explicitly omit product-spec.json to exercise the legacy viewer.');

    legacyArtwork = true;
    await visit('completed');
    await page.getByRole('button', { name: 'Layout', exact: true }).click();
    const copper = page.getByRole('img', { name: /^Real PCB copper:/ });
    await copper.waitFor();
    check('Legacy artwork uses selected run paths only', (await copper.locator('[style*="mask-image"]').evaluateAll(es => es.map(e => e.style.maskImage))).every(src => src.includes('/runs/ux-completed/board/')));
    // CSS masks are not <img> elements. Decode each exact synthetic mask URL
    // before capturing; networkidle can occur before a deferred React commit.
    await copper.evaluate(async element => {
      const urls = [...element.querySelectorAll('[style*="mask-image"]')].map(e => e.style.maskImage.match(/url\(["']?([^"')]+)/)?.[1]).filter(Boolean);
      await Promise.all(urls.map(src => new Promise((resolve, reject) => { const img = new Image(); img.onload = resolve; img.onerror = () => reject(new Error(`Mask unavailable: ${src}`)); img.src = src; })));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await shot('layers-desktop');
    await page.getByRole('button', { name: 'F.Cu', exact: true }).click();
    check('Copper visibility toggle switches off', await page.getByRole('button', { name: 'F.Cu', exact: true }).getAttribute('aria-pressed') === 'false');
    await page.getByRole('button', { name: 'F.Cu', exact: true }).click();
    check('Copper visibility toggle switches on', await page.getByRole('button', { name: 'F.Cu', exact: true }).getAttribute('aria-pressed') === 'true');
    await page.getByRole('button', { name: '3D', exact: true }).last().click();
    const image = page.getByRole('img', { name: 'KiCad raytraced render, top side', exact: true });
    await image.waitFor();
    await page.waitForFunction(() => { const e = document.querySelector('img[alt="KiCad raytraced render, top side"]'); return e?.complete && e.naturalWidth > 0; });
    check('Top synthetic image decodes from selected run', (await image.getAttribute('src')) === '/runs/ux-completed/board/render-top.png');
    check('Unavailable GLB is disclosed', await page.getByText(/3D model unavailable/).isVisible());
    await shot('top-desktop');
    await page.getByRole('button', { name: 'bottom', exact: true }).click();
    await page.waitForFunction(() => { const e = document.querySelector('img[alt="KiCad raytraced render, bottom side"]'); return e?.complete && e.naturalWidth > 0; });
    check('Bottom synthetic image decodes from selected run', await page.getByRole('img', { name: 'KiCad raytraced render, bottom side', exact: true }).getAttribute('src') === '/runs/ux-completed/board/render-bottom.png');
    await shot('bottom-desktop');
    for (const [width, height, name] of [[1024,768,'tablet-landscape'], [768,1024,'tablet-portrait'], [390,844,'mobile']]) {
      await page.setViewportSize({ width, height });
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      await page.waitForFunction(w => document.documentElement.clientWidth === w, width);
      check(`${name} no document horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      check(`${name} bottom image remains visible`, await page.getByRole('img', { name: 'KiCad raytraced render, bottom side', exact: true }).isVisible());
      await shot(`bottom-${name}`);
    }
    await page.setViewportSize({ width:1440, height:900 });
    legacyArtwork = false;
    await visit('missing');
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    const details = page.getByRole('complementary', { name: 'Design details' });
    await details.getByText('Loading overview artifacts…', { exact: true }).waitFor({ state: 'hidden' });
    observations.push(`Missing details: ${(await details.innerText()).slice(0, 1500)}`);
    check('Missing artifacts do not inherit prior saved product spec', await page.getByText('Synthetic isolation board A', { exact:true }).count() === 0 && await page.getByText('Synthetic isolation board B', { exact:true }).count() === 0);
    check('Missing artifacts do not display prior run images', await page.locator('img[src*="ux-completed"], img[src*="ux-partial"]').count() === 0);
    await shot('missing-artifacts-desktop');
    check('No caught React or hydration errors', consoleErrors.every(message => /^Failed to load resource:/.test(message)));
    check('No page errors', errors.length === 0);
    check('No external HTTP attempts', blocked.length === 0);
    check('No mutating API requests', !requests.some(r => !['GET','HEAD'].includes(r.method)));
    console.log(JSON.stringify({ assertionCount: checks.length, checks, observations, screenshots, errors, blocked, output }, null, 2));
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ assertionCount: checks.length, checks, observations, screenshots, errors, consoleErrors, blocked, requests }, null, 2));
    console.log('OUTPUT', output);
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
