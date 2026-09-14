/* eslint-disable @typescript-eslint/no-require-imports -- Standalone browser harness. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');
const origin = 'http://127.0.0.1:4510';
(async () => {
  const status = await fetch(`${origin}/api/ux-preview/status`);
  assert.equal(status.headers.get('x-ui-preview'), 'synthetic-only');
  assert.equal((await status.json()).preview, true);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-access-'));
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const checks = [], errors = [], untested = [];
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/compose`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Account', exact: true }).waitFor();
    const prompt = page.getByRole('textbox', { name: 'Describe your product or board', exact: true });
    await page.getByRole('button', { name: 'Conversation', exact: true }).click();
    await prompt.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Open conversation', exact: true }).click();
    await prompt.waitFor({ state: 'visible' });
    checks.push('Open conversation reveals collapsed desktop composer');
    // Desktop 200% layout approximation: CSS zoom, not physical-device acceptance.
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'zoom-200.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    checks.push('200% CSS zoom has no document horizontal overflow');
    await page.evaluate(() => { document.documentElement.style.zoom = ''; });
    const provider = page.getByRole('button', { name: 'AI provider settings', exact: true });
    if (await provider.count()) {
      await provider.click();
      await page.getByRole('button', { name: 'Close AI provider settings', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Close AI provider settings', exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await provider.evaluate(el => el === document.activeElement), true);
      checks.push('Provider Escape restores focus without entering credentials');
    } else untested.push('Provider settings component is not mounted in Compose; no browser focus claim');
    await page.goto(`${origin}/login`, { waitUntil: 'networkidle' });
    await page.getByLabel('Email', { exact: true }).fill('synthetic@example.invalid');
    await page.getByLabel('Password', { exact: true }).fill('synthetic-not-a-secret');
    let posts = 0;
    await page.route('**/api/auth/login', route => { posts++; return route.abort('failed'); });
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Could not connect'));
    assert.equal(await page.getByLabel('Email', { exact: true }).inputValue(), 'synthetic@example.invalid');
    assert.equal(await page.getByLabel('Password', { exact: true }).inputValue(), 'synthetic-not-a-secret');
    assert.equal(await page.getByRole('button', { name: 'Sign in', exact: true }).isEnabled(), true);
    assert.equal(posts, 1);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Could not connect'));
    assert.equal(posts, 2);
    checks.push('Rejected login releases busy state, retains input, and retries explicitly');
    await page.screenshot({ path: path.join(output, 'login-error.png') });
    assert.deepEqual(errors, []);
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ checks, errors, untested, browser: await browser.version() }, null, 2));
    console.log(JSON.stringify({ checks, errors, output }, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
