/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS browser harness using installed tooling. */
/* Local fixture preview only. Never point this at a deployed service. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');

(async () => {
  const origin = new URL(process.argv[2] || 'http://127.0.0.1:4510');
  if (origin.origin !== 'http://127.0.0.1:4510' || origin.pathname !== '/') {
    throw new Error('This check only accepts the owned loopback preview on port 4510');
  }
  const status = await fetch(`${origin.origin}/api/ux-preview/status`);
  if (status.headers.get('x-ui-preview') !== 'synthetic-only' || !(await status.json()).preview) {
    throw new Error('The owned synthetic preview is not listening on this port');
  }
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ux-browser-'));
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const errors = [], consoleErrors = [], blocked = [], requests = [];
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin.origin) {
        blocked.push(`${request.method()} ${url.origin}${url.pathname}`);
        return route.abort();
      }
      requests.push({ method: request.method(), path: url.pathname });
      return route.continue();
    });
    await context.routeWebSocket('**/*', ws => {
      const url = new URL(ws.url());
      if (url.host === origin.host && url.pathname === '/_next/webpack-hmr') ws.connectToServer();
      else ws.close();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push({ text: message.text(), location: message.location() });
    });
    for (const [width, height] of [[1440, 900], [1024, 768], [768, 1024], [390, 844]]) {
      await page.setViewportSize({ width, height });
      const response = await page.goto(`${origin.origin}/compose`, { waitUntil: 'networkidle', timeout: 120000 });
      if (response.status() !== 200) throw new Error(`Compose responded ${response.status()}`);
      const text = await page.locator('body').innerText();
      if (!/synthetic data/i.test(text)) throw new Error('Missing synthetic-preview banner');
      await page.screenshot({ path: path.join(output, `compose-${width}.png`), fullPage: true });
      const dimensions = await page.evaluate(() => ({
        viewport: innerWidth, document: document.documentElement.scrollWidth,
        main: document.querySelector('main')?.getBoundingClientRect().toJSON(),
      }));
      console.log(JSON.stringify({ width, height, dimensions }));
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({
      browser: await browser.version(), origin: origin.origin,
      errors, consoleErrors, blocked, requests,
    }, null, 2));
    console.log(`Screenshots and report: ${output}`);
    const hydrationErrors = consoleErrors.filter(error => /hydration|hydrated|server rendered HTML/i.test(error.text));
    if (errors.length || hydrationErrors.length) { console.error([...errors, ...hydrationErrors]); process.exitCode = 1; }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
