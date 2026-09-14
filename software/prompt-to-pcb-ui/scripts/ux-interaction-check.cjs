/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS browser harness using installed tooling. */
/* Actual browser checks against the owned, synthetic-only preview. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');
const origin = 'http://127.0.0.1:4510';
(async () => {
  const probe = await fetch(`${origin}/api/ux-preview/status`);
  assert.equal(probe.headers.get('x-ui-preview'), 'synthetic-only');
  assert.equal((await probe.json()).preview, true);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ux-interactions-'));
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const errors = [], blocked = [], checks = [];
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) { blocked.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await context.routeWebSocket('**/*', ws => {
      const url = new URL(ws.url());
      if (url.host === '127.0.0.1:4510' && url.pathname === '/_next/webpack-hmr') ws.connectToServer(); else ws.close();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const visit = async suffix => { await page.goto(`${origin}${suffix}`, { waitUntil: 'networkidle' }); await page.getByRole('button', { name: 'Account', exact: true }).waitFor(); };
    await visit('/compose');
    const prompt = page.getByRole('textbox', { name: 'Describe your product or board', exact: true });
    await prompt.fill('Synthetic retained draft: 3.3V temperature logger');
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    assert.equal(await prompt.inputValue(), 'Synthetic retained draft: 3.3V temperature logger');
    await page.getByRole('button', { name: 'Threads', exact: true }).click();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    assert.match(await prompt.inputValue(), /retained draft/);
    checks.push('Draft survives Files and Threads');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Conversation', exact: true }).click();
    assert.match(await prompt.inputValue(), /retained draft/);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await prompt.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Conversation', exact: true }).click();
    assert.match(await prompt.inputValue(), /retained draft/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    checks.push('Mobile surface switching preserves draft without horizontal overflow');
    await page.setViewportSize({ width: 1440, height: 900 });
    const search = page.getByRole('button', { name: /^Search/ });
    await search.click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await search.evaluate(el => el === document.activeElement), true);
    checks.push('Search Escape restores trigger focus');
    const account = page.getByRole('button', { name: 'Account', exact: true });
    await account.click();
    await page.keyboard.press('Escape');
    assert.equal(await account.evaluate(el => el === document.activeElement), true);
    checks.push('Account Escape restores trigger focus');
    const separator = page.getByRole('separator', { name: 'Resize conversation pane' });
    const before = Number(await separator.getAttribute('aria-valuenow'));
    await separator.focus(); await page.keyboard.press('ArrowRight');
    assert.equal(Number(await separator.getAttribute('aria-valuenow')), before + 20);
    checks.push('Pane separator resizes with keyboard');
    await page.getByRole('button', { name: 'Send ↵', exact: true }).click();
    await page.getByText(/What supply voltage should/).waitFor();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    assert.equal(await page.getByText(/What supply voltage should/).isVisible(), true);
    checks.push('Interview question survives utility-panel switch');
    await page.screenshot({ path: path.join(output, 'interview.png') });
    // Saved-run artifacts are exercised separately by ux-results-check.cjs.
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ checks, errors, blocked, browser: await browser.version() }, null, 2));
    console.log(JSON.stringify({ checks, errors, output }, null, 2));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
