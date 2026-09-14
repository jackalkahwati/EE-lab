/* eslint-disable @typescript-eslint/no-require-imports -- Installed local browser tooling. */
// Explicit synthetic-only acceptance. Does not start servers or install browsers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');
const origin = 'http://127.0.0.1:4510';
const startupMs = 60000;
const maxEvents = 2000;
const reads = new Set(['/api/auth/me', '/api/admin/me', '/api/runs', '/api/account/llm-key', '/api/astra']);
async function probe(endpoint) {
  const response = await fetch(origin + endpoint, { redirect: 'error', signal: AbortSignal.timeout(startupMs) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-ui-preview'), 'synthetic-only');
  return response.json();
}
function allowed(url, method) {
  if (url.origin !== origin || method !== 'GET') return false;
  if (reads.has(url.pathname)) return !url.search;
  if (url.pathname === '/compose') return [...url.searchParams.keys()].every(key => ['scenario', '_rsc'].includes(key))
    && (!url.searchParams.has('scenario') || url.searchParams.get('scenario') === 'empty');
  return url.pathname.startsWith('/_next/static/') || url.pathname === '/favicon.ico';
}

(async () => {
  assert.deepEqual(await probe('/api/ux-preview/status'), { preview: true, scenario: 'empty', providers: false, tools: false });
  const snapshot = await probe('/api/ux-preview/snapshot');
  assert.equal(snapshot.frozen, true, 'Acceptance requires --frozen preview');
  assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ux-accessibility-'));
  const report = { output, snapshot: { sha256: snapshot.sha256, frozen: true }, checks: [], failures: [], errors: [], console: [], requests: [], blocked: [], intentionalDenials: [], httpFailures: [], contrast: [], storageDiagnostics: [], notes: [
    'Chrome desktop with viewport emulation, not physical mobile or non-Chrome engine coverage.',
    'Real browser zoom: NOT TESTED. No CSS zoom or CDP page-scale substitution is reported as browser zoom. Viewport reflow below is separate evidence.',
    'Contrast samples use computed CSS colors converted by Canvas to sRGB and alpha-composited over solid ancestor backgrounds. Gradients, images, filters, blending, group opacity and text shadow are explicitly unmeasured. Ratios rounded from 8-bit sRGB; not a WCAG certification.',
    'Storage denial uses throwing Window localStorage/sessionStorage getters in a fresh context. No existing profile, key or storage is read or modified.',
  ] };
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  let expired = false;
  let page;
  const deadline = setTimeout(() => {
    expired = true;
    report.failures.push({ name: 'Suite deadline', stack: 'Accessibility acceptance exceeded five minutes' });
    void browser.close();
  }, 300000);
  function record(array, value) {
    if (array.length >= maxEvents) {
      expired = true;
      void browser.close();
      throw new Error('Bounded browser observation limit exceeded');
    }
    array.push(value);
  }
  const check = async (name, run) => {
    if (expired) return;
    try { await run(); report.checks.push(name); }
    catch (error) {
      report.failures.push({ name, stack: error.stack || error.message, url: page?.url(), body: await page?.locator('body').innerText({ timeout: 2000 }).catch(() => '') });
      await storageDiagnostics(name);
      await page?.screenshot({ path: path.join(output, `failure-${report.failures.length}.png`), fullPage: true, timeout: 5000 }).catch(() => {});
    }
  };
  async function context(storageDenied = false) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
    await ctx.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      record(report.requests, { url: request.url(), method: request.method(), storageDenied });
      if (!allowed(url, request.method())) {
        record(report.blocked, { url: request.url(), method: request.method(), reason: 'outside exact synthetic read allowlist' });
        return route.abort();
      }
      return route.continue();
    });
    await ctx.routeWebSocket('**/*', ws => {
      const url = new URL(ws.url());
      if (url.protocol === 'ws:' && url.host === '127.0.0.1:4510' && url.pathname === '/_next/webpack-hmr') ws.connectToServer();
      else { record(report.blocked, { url: ws.url(), reason: 'non-HMR socket' }); ws.close(); }
    });
    if (storageDenied) await ctx.addInitScript(() => {
      window.__uxStorageDenials = { localStorage: 0, sessionStorage: 0 };
      window.__uxStorageDenialStacks = [];
      window.__uxStorageDenialStacksDropped = 0;
      for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, {
        configurable: false,
        get() {
          window.__uxStorageDenials[name]++;
          // DOMException can lose its stack in pageerror serialization. Capture at
          // the actual throw site without allowing any storage access to succeed.
          const stack = new Error(`Synthetic storage denial: ${name}`).stack;
          if (window.__uxStorageDenialStacks.length < 100) window.__uxStorageDenialStacks.push({ storage: name, stack });
          else window.__uxStorageDenialStacksDropped++;
          const error = new DOMException('Synthetic storage denial', 'SecurityError');
          Object.defineProperty(error, 'stack', { value: stack });
          throw error;
        },
      });
    });
    return ctx;
  }
  async function storageDiagnostics(phase) {
    if (!page || page.isClosed()) return;
    try {
      const evidence = await page.evaluate(() => window.__uxStorageDenials ? {
        counts: window.__uxStorageDenials,
        stacks: window.__uxStorageDenialStacks,
        dropped: window.__uxStorageDenialStacksDropped,
      } : null);
      if (evidence) record(report.storageDiagnostics, { phase, url: page.url(), ...evidence });
    } catch (error) {
      record(report.storageDiagnostics, { phase, unavailable: error.message });
    }
  }
  async function open(ctx) {
    const next = await ctx.newPage();
    page = next; // Setup failures must report this page, not a closed prior context.
    next.setDefaultTimeout(12000); next.setDefaultNavigationTimeout(startupMs);
    next.on('pageerror', error => record(report.errors, error.stack || error.message));
    next.on('console', message => {
      if (['warning', 'error'].includes(message.type())) record(report.console, { text: message.text(), location: message.location() });
    });
    next.on('response', response => {
      if (response.status() < 400) return;
      const entry = { url: response.url(), status: response.status(), synthetic: response.headers()['x-ui-preview'] };
      const url = new URL(response.url());
      if (url.pathname === '/api/admin/me' && response.status() === 403 && entry.synthetic === 'synthetic-only') record(report.intentionalDenials, entry);
      else record(report.httpFailures, entry);
    });
    next.on('requestfailed', request => {
      if (new URL(request.url()).pathname.startsWith('/_next/static/')) record(report.errors, `Static chunk request failed: ${request.url()} ${request.failure()?.errorText}`);
    });
    next.on('download', download => { record(report.blocked, { url: download.url(), reason: 'unexpected download' }); void download.cancel(); });
    await next.goto(`${origin}/compose?scenario=empty`, { waitUntil: 'domcontentloaded' });
    await next.getByRole('textbox', { name: 'Describe your product or board', exact: true }).waitFor({ timeout: startupMs });
    await next.waitForFunction(() => {
      const input = document.querySelector('textarea');
      return input && Object.keys(input).some(key => key.startsWith('__reactProps$'));
    });
    return next;
  }
  const focused = locator => locator.evaluate(element => element === document.activeElement);
  const button = name => page.getByRole('button', { name, exact: true });
  const shot = name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  const composer = () => page.getByRole('textbox', { name: 'Describe your product or board', exact: true });
  const surfaces = () => page.getByRole('navigation', { name: 'Workspace surfaces', exact: true });
  async function safeTab(count) {
    const observations = [];
    for (let i = 0; i < count; i++) {
      await page.keyboard.press('Tab');
      const state = await page.evaluate(() => {
        const element = document.activeElement;
        return { tag: element?.tagName, label: element?.getAttribute('aria-label') || element?.textContent?.trim().slice(0, 100), inactive: !!element?.closest('[hidden],[inert],[aria-hidden="true"]'), visible: !!element?.getClientRects().length };
      });
      assert.equal(state.inactive, false, JSON.stringify(state));
      assert.equal(state.visible, true, JSON.stringify(state));
      observations.push(state);
    }
    return observations;
  }
  async function contrast(label, locator) {
    const sample = await locator.evaluate(element => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const rgba = color => {
        context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data].map((value, index) => index === 3 ? value / 255 : value);
      };
      const over = (foreground, background) => {
        const alpha = foreground[3] + background[3] * (1 - foreground[3]);
        return [...foreground.slice(0, 3).map((value, index) => alpha ? (value * foreground[3] + background[index] * background[3] * (1 - foreground[3])) / alpha : 0), alpha];
      };
      const ancestors = [];
      for (let node = element; node; node = node.parentElement) ancestors.unshift(node);
      let background = [255, 255, 255, 1];
      const layers = [];
      for (const node of ancestors) {
        const style = getComputedStyle(node);
        if (style.backgroundImage !== 'none' || Number(style.opacity) !== 1 || style.filter !== 'none' || style.backdropFilter !== 'none' || style.mixBlendMode !== 'normal') return { measured: false, reason: 'Non-solid background, group opacity, filter or blend on ancestor', tag: node.tagName };
        layers.push(style.backgroundColor);
        background = over(rgba(style.backgroundColor), background);
      }
      const style = getComputedStyle(element);
      if (style.textShadow !== 'none') return { measured: false, reason: 'Text shadow requires pixel-level review' };
      const foreground = over(rgba(style.color), background);
      const luminance = color => color.slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const a = luminance(foreground), b = luminance(background);
      const fontSize = parseFloat(style.fontSize), weight = parseInt(style.fontWeight, 10);
      return { measured: true, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), threshold: fontSize >= 24 || (fontSize >= 18.6667 && weight >= 700) ? 3 : 4.5, fontSize, weight, color: style.color, layers, foreground, background, text: element.textContent?.trim().slice(0, 100) };
    });
    report.contrast.push({ label, ...sample });
    if (sample.measured) assert.ok(sample.ratio >= sample.threshold, `${label}: contrast ${sample.ratio.toFixed(2)} below ${sample.threshold}`);
  }
  try {
    const normal = await context();
    page = await open(normal);
    await check('Provider settings opens by keyboard and Escape restores trigger focus', async () => {
      const trigger = button('AI provider settings');
      await trigger.focus(); await page.keyboard.press('Enter');
      await page.getByLabel('Provider', { exact: true }).waitFor();
      await button('Close AI provider settings').waitFor();
      await safeTab(3);
      await page.keyboard.press('Escape');
      await page.getByLabel('Provider', { exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await focused(trigger), true);
      await shot('provider-keyboard-closed');
    });
    await check('Command palette keyboard navigation and Escape restore composer focus', async () => {
      await composer().focus(); await page.keyboard.press('Control+k');
      const search = page.getByRole('combobox', { name: 'Search workspace', exact: true });
      await search.waitFor(); assert.equal(await focused(search), true);
      const first = await search.getAttribute('aria-activedescendant');
      await page.keyboard.press('ArrowDown');
      const second = await search.getAttribute('aria-activedescendant');
      assert.ok(first && second && first !== second);
      assert.equal(await page.locator(`[id=${JSON.stringify(second)}]`).getAttribute('aria-selected'), 'true');
      await search.fill('synthetic-no-match-sentinel');
      await page.getByText('No matches.', { exact: true }).waitFor();
      await page.keyboard.press('Escape'); await search.waitFor({ state: 'hidden' });
      assert.equal(await focused(composer()), true);
      await shot('command-keyboard-restored');
    });
    await check('Responsive surfaces preserve draft and remove inactive controls from keyboard flow', async () => {
      const draft = 'Synthetic unsent accessibility draft';
      await composer().fill(draft);
      for (const [width, height] of [[1440, 960], [1024, 768], [768, 1024], [390, 844]]) {
        await page.setViewportSize({ width, height });
        await page.waitForFunction(expected => document.querySelector('.workspace-panes')?.getAttribute('data-mode') === expected, width < 760 ? 'mobile' : width < 1200 ? 'tablet' : 'desktop');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        if (width < 1200) {
          // Tablet also hides Conversation when Preview is selected. A role
          // locator excluding hidden controls must not be used to read its draft.
          await surfaces().getByRole('button', { name: 'Preview', exact: true }).focus(); await page.keyboard.press('Enter');
          await composer().waitFor({ state: 'hidden' });
          const inactiveConversation = page.getByRole('complementary', { name: 'Design conversation', includeHidden: true });
          assert.equal(await inactiveConversation.getAttribute('hidden'), '');
          assert.equal(await composer().count(), 0);
          assert.equal(await inactiveConversation.getByRole('textbox', { name: 'Describe your product or board', exact: true, includeHidden: true }).inputValue(), draft);
          report.notes.push({ width, tabOrder: await safeTab(10) });
          await shot(`reflow-${width}-preview`);
          await surfaces().getByRole('button', { name: 'Conversation', exact: true }).focus(); await page.keyboard.press('Enter');
          await composer().waitFor();
        }
        assert.equal(await composer().inputValue(), draft);
        await shot(`reflow-${width}`);
      }
    });
    await check('Reduced-motion preference reaches the page without active long CSS animation', async () => {
      assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
      const animations = await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').map(animation => ({ duration: animation.effect?.getComputedTiming().duration, iterations: animation.effect?.getComputedTiming().iterations })));
      report.notes.push({ reducedMotionActiveAnimations: animations });
      assert.equal(animations.filter(animation => animation.duration > 100 || animation.iterations === Infinity).length, 0);
    });
    await check('Representative solid-background text contrast meets recorded thresholds', async () => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await button('AI provider settings').click(); await page.getByLabel('Provider', { exact: true }).waitFor();
      await contrast('Provider Save button', button('Save'));
      await contrast('Provider label', page.locator('label').filter({ hasText: /^Provider$/ }));
      await contrast('Provider explanatory text', page.getByText(/^Browser scope: the key stays/));
      await contrast('Provider title', page.getByText('AI provider', { exact: true }));
      assert.ok(report.contrast.filter(sample => sample.measured).length >= 3, 'At least three supported composited samples required');
      await shot('contrast-provider'); await page.keyboard.press('Escape');
    });
    await normal.close();
    const denied = await context(true);
    await check('Denied storage keeps the workspace usable and provider input without false save', async () => {
      page = await open(denied);
      await composer().fill('Synthetic storage-denied unsent draft');
      await button('AI provider settings').click();
      await page.getByLabel('Provider', { exact: true }).waitFor();
      await page.getByLabel('This browser only', { exact: true }).check();
      const key = page.getByLabel('API key', { exact: true });
      await key.fill('ux-synthetic-provider-key-0000');
      await button('Save').click();
      await page.getByRole('alert').filter({ hasText: /Browser key save could not be confirmed/ }).waitFor();
      assert.equal(await key.inputValue(), 'ux-synthetic-provider-key-0000');
      assert.equal(await button('Saved').count(), 0);
      const counts = await page.evaluate(() => window.__uxStorageDenials);
      assert.ok(counts.localStorage > 0); assert.ok(counts.sessionStorage > 0);
      report.notes.push({ storageDenials: counts });
      await shot('storage-denied-provider'); await page.keyboard.press('Escape');
      assert.equal(await composer().inputValue(), 'Synthetic storage-denied unsent draft');
      await page.setViewportSize({ width: 390, height: 844 });
      await surfaces().getByRole('button', { name: 'Preview', exact: true }).click();
      await surfaces().getByRole('button', { name: 'Conversation', exact: true }).click();
      assert.equal(await composer().inputValue(), 'Synthetic storage-denied unsent draft');
      await shot('storage-denied-mobile');
    });
    await storageDiagnostics('Denied context complete');
    await denied.close();
    await check('Frozen hash remains unchanged and no unexpected requests or runtime errors occur', async () => {
      const after = await probe('/api/ux-preview/snapshot');
      assert.equal(after.frozen, true); assert.equal(after.sha256, snapshot.sha256);
      assert.deepEqual(report.blocked, []); assert.deepEqual(report.errors, []); assert.deepEqual(report.httpFailures, []);
      assert.deepEqual(report.console.filter(entry => /hydrat|server rendered|did not match|error occurred|caught.*error|errorboundary|ChunkLoadError|Loading chunk/i.test(entry.text)), []);
      assert.ok(report.requests.every(request => request.method === 'GET'));
    });
    report.browser = await browser.version();
  } finally {
    clearTimeout(deadline);
    await browser.close();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (report.failures.length) process.exitCode = 1;
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
