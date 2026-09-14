/* eslint-disable @typescript-eslint/no-require-imports -- Standalone harness using installed Playwright and Chrome. */
// Run ONLY against the isolated synthetic preview. Does not start a server or download a browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');
const origin = 'http://127.0.0.1:4510';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const destinations = [
  ['Home', '/enterprise', 'Enterprise Programs', /Synthetic Sensor Program/, /No enterprise data|No workspace/],
  ['Approvals', '/enterprise/approvals', 'Approvals', /Synthetic Review Board/, /Nothing awaiting a decision/],
  ['Quotes', '/enterprise/quotes', 'Quotes & procurement', /Synthetic Review Board/, /No quote flows yet/],
  ['Validation', '/enterprise/validation', 'Validation console', /SYNTHETIC-FL1-0000/, /No sessions planned/],
  ['Catalog', '/enterprise/catalog', 'Catalog', /Synthetic QFN sensor/, /No capability|registry.*empty|No.*families|Capability registry not loaded/i],
  ['Budgets', '/enterprise/budgets', 'Budgets & alerts', /nearing limit/, /No tagged usage/],
  ['Activity', '/enterprise/activity', 'Activity', /DENIED:advance_quote/, /No recent activity/],
  ['Audit', '/enterprise/audit', 'Audit log', /DENIED:advance_quote/, /No matching audit entries/],
  ['IAM', '/enterprise/iam', 'IAM · identity & access', /preview@example.invalid/, /No users provisioned yet/],
  ['Integrations', '/enterprise/integrations', 'Integrations', /Synthetic KiCad connector/, /No active API keys/],
  ['Settings', '/enterprise/settings', 'Workspace settings', /preview@example.invalid/, /No members/],
];

(async () => {
  const { syntheticCredentials, catalogFixturePath } = await import(pathToFileURL(path.join(__dirname, '../tests/fixtures/ux/enterprise-fixtures.mjs')).href);
  // Fixed origin, no redirects, no configurable production URL, no credentials.
  const probe = await fetch(`${origin}/api/ux-preview/status`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.equal(probe.status, 200);
  assert.equal(probe.headers.get('x-ui-preview'), 'synthetic-only');
  const status = await probe.json();
  assert.equal(status.preview, true); assert.equal(status.providers, false); assert.equal(status.tools, false);
  const snapshotResponse = await fetch(`${origin}/api/ux-preview/snapshot`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.equal(snapshotResponse.status, 200);
  assert.equal(snapshotResponse.headers.get('x-ui-preview'), 'synthetic-only');
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshot.frozen, true, 'Acceptance harness requires launcher --frozen');
  assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
  const enterpriseProbe = await fetch(`${origin}/api/enterprise`, {
    redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'x-ux-scenario': 'enterprise-populated' },
  });
  assert.equal(enterpriseProbe.status, 200, 'Launcher must integrate enterprise fixtures before this harness runs');
  assert.equal(enterpriseProbe.headers.get('x-ui-preview'), 'synthetic-only');
  const fixture = await enterpriseProbe.json();
  assert.equal(fixture.organizations?.[0]?.org_id, 'ux-org');
  assert.equal(fixture.organizations[0].security_settings.demo, true);
  assert.ok(fs.existsSync(chrome), 'Installed Google Chrome required; never download a browser');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ux-enterprise-'));
  const report = { output, snapshot: { frozen: snapshot.frozen, sha256: snapshot.sha256 }, checks: [], failures: [], errors: [], consoleIssues: [], blocked: [], requests: [], responses: [], navigation: [], notes: [
    'Synthetic in-memory contracts only. No real membership, credentials, hardware, provider execution, webhook delivery, SSO enforcement, or downloads tested.',
    'Use a fresh preview process for repeatable action state. Retry is explicitly controlled by x-ux-retry: 1, not request counts.',
  ] };
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    report.failures.push({ name: 'Suite deadline', message: 'Enterprise acceptance exceeded eight minutes.' });
    void browser.close();
  }, 480000);
  let page;
  let scenario = 'enterprise-populated';
  let retry = false;
  let chunkFailure = null;
  const keep = (array, value) => { if (array.length >= 4000) throw new Error('Bounded observation limit exceeded'); array.push(value); };
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) { keep(report.blocked, request.url()); return route.abort(); }
      if (url.pathname.startsWith('/api/enterprise/') || ['/api/evidence-upload', '/api/cad-export'].includes(url.pathname) || (url.pathname.startsWith('/runs/') && url.pathname !== catalogFixturePath)) {
        keep(report.blocked, request.url()); return route.abort();
      }
      const owned = ['/api/enterprise', '/api/account/llm-key', catalogFixturePath].includes(url.pathname);
      const headers = { ...request.headers() };
      if (owned) {
        headers['x-ux-scenario'] = scenario;
        if (retry) headers['x-ux-retry'] = '1'; else delete headers['x-ux-retry'];
      }
      // Observe only response contracts and exact synthetic form bodies. Never add
      // browser credentials, Authorization, cookies, or production provider headers.
      if (url.pathname.startsWith('/api/')) keep(report.requests, {
        path: url.pathname, method: request.method(), scenario: owned ? scenario : null,
        body: owned ? request.postData() : null, url: request.url(),
      });
      return route.continue({ headers });
    });
    await context.routeWebSocket('**/*', ws => {
      const url = new URL(ws.url());
      if (url.protocol === 'ws:' && url.host === '127.0.0.1:4510' && url.pathname === '/_next/webpack-hmr') ws.connectToServer();
      else { keep(report.blocked, ws.url()); ws.close(); }
    });
    const navigationStarted = Date.now();
    let navigationCapped = false;
    const navEvent = value => {
      if (report.navigation.length >= 1500) {
        if (!navigationCapped) {
          navigationCapped = true;
          report.failures.push({ name: 'Navigation observation limit', message: 'Navigation event budget exceeded.' });
          void browser.close();
        }
        return;
      }
      report.navigation.push({ elapsedMs: Date.now() - navigationStarted, ...value });
    };
    await context.exposeBinding('__uxEnterpriseNavClick', (_source, value) => navEvent({ kind: 'click', ...value }));
    await context.addInitScript(() => {
      document.addEventListener('click', event => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target?.closest('nav[aria-label="Enterprise sections"]')) return;
        const describe = node => node instanceof Element ? { tag: node.tagName, label: node.getAttribute('aria-label'), href: node.getAttribute('href') } : { tag: node === window ? 'window' : 'document' };
        const link = target.closest('a');
        const data = { url: location.href, target: describe(target), path: event.composedPath().slice(0, 10).map(describe), href: link?.getAttribute('href'), current: link?.getAttribute('aria-current'), trusted: event.isTrusted, button: event.button };
        queueMicrotask(() => { void window.__uxEnterpriseNavClick({ ...data, defaultPrevented: event.defaultPrevented }); });
      }, true);
    });
    page = await context.newPage();
    const navigationRequests = new WeakMap();
    let navigationSequence = 0;
    const enterpriseNavigation = request => {
      const url = new URL(request.url());
      return url.origin === origin && destinations.some(([, route]) => route === url.pathname)
        && (request.isNavigationRequest() || request.headers().rsc === '1');
    };
    page.on('request', request => {
      if (!enterpriseNavigation(request)) return;
      navigationRequests.set(request, ++navigationSequence);
      navEvent({ kind: 'request', id: navigationSequence, url: request.url(), method: request.method(), resourceType: request.resourceType(), rsc: request.headers().rsc === '1' });
    });
    page.on('response', response => {
      if (navigationRequests.has(response.request())) navEvent({ kind: 'response', id: navigationRequests.get(response.request()), url: response.url(), status: response.status(), contentType: response.headers()['content-type'] });
    });
    page.on('requestfinished', request => {
      if (navigationRequests.has(request)) navEvent({ kind: 'finished', id: navigationRequests.get(request), url: request.url(), timing: request.timing() });
    });
    page.on('requestfailed', request => {
      if (navigationRequests.has(request)) navEvent({ kind: 'failed', id: navigationRequests.get(request), url: request.url(), error: request.failure()?.errorText, timing: request.timing() });
    });
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) navEvent({ kind: 'main-frame', url: frame.url() });
    });
    page.setDefaultTimeout(12000);
    // Cold Next route compilation took 10.9s for Quotes and 21.6s for Login
    // in the retained failed run. Bound navigation separately from UI actions.
    page.setDefaultNavigationTimeout(60000);
    const observeChunk = message => {
      if (/ChunkLoadError|Loading chunk .+ failed|Failed to fetch dynamically imported module/i.test(message) && !chunkFailure) {
        chunkFailure = message; void page.close().catch(() => {});
      }
    };
    page.on('pageerror', error => { keep(report.errors, error.message); observeChunk(error.message); });
    page.on('console', message => {
      if (['error', 'warning'].includes(message.type()) && /hydrat|server rendered|did not match|error occurred|caught.*error|errorboundary|ChunkLoadError|Loading chunk/i.test(message.text())) keep(report.consoleIssues, message.text());
      observeChunk(message.text());
    });
    page.on('requestfailed', request => {
      if (new URL(request.url()).pathname.startsWith('/_next/static/chunks/')) observeChunk(`ChunkLoadError: ${request.url()} ${request.failure()?.errorText}`);
    });
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/') || url.pathname === catalogFixturePath) keep(report.responses, { path: url.pathname, status: response.status(), fixture: response.headers()['x-ui-preview'] });
    });
    page.on('download', download => { keep(report.blocked, `download:${download.suggestedFilename()}`); void download.cancel(); });
    const button = name => page.getByRole('button', { name, exact: true });
    // Playwright otherwise mutates every input/textarea with inline transparent
    // caret styles, which can race hydration while capturing an early failure.
    // Preserve the actual page styles; never hide/suppress hydration diagnostics.
    const shot = name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, caret: 'initial' });
    const body = () => page.locator('body').innerText();
    // Select actual rendered content, not hidden <option> labels. Next's empty
    // route announcer is also role=alert, but is never application error evidence.
    const text = pattern => page.getByText(pattern).filter({ visible: true }).first().waitFor();
    const appAlerts = () => page.locator('[role="alert"]:not(#__next-route-announcer__)');
    const visit = async (route, state) => {
      scenario = state; retry = false;
      await page.goto(`${origin}${route}?scenario=${state}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Each journey waits for its own resolved data/error content and verifies
      // actual interactions; private React properties do not establish readiness.
    };
    async function check(name, callback) {
      if (expired) return;
      try {
        if (chunkFailure) throw new Error(chunkFailure);
        await callback();
        if (chunkFailure) throw new Error(chunkFailure);
        report.checks.push(name);
      } catch (error) {
        report.failures.push({ name, message: error.message, stack: error.stack, url: page.url(), body: !page.isClosed() ? (await body().catch(() => '')).slice(0, 12000) : '' });
        if (!page.isClosed()) await shot(`failure-${report.failures.length}`).catch(() => {});
        if (chunkFailure) throw error;
      }
    }
    const actionResponse = async (name, interact, expectedStatus = 200) => {
      const responsePromise = page.waitForResponse(response => {
        if (new URL(response.url()).pathname !== '/api/enterprise' || response.request().method() !== 'POST') return false;
        try { return response.request().postDataJSON().action === name; } catch { return false; }
      });
      await interact();
      const response = await responsePromise;
      assert.equal(response.status(), expectedStatus);
      assert.equal(response.headers()['x-ui-preview'], 'synthetic-only');
      return response.json();
    };

    // Every enterprise destination is reached by the real shared navigation, not
    // replacement markup or browser response fulfillment.
    await visit('/enterprise', 'enterprise-populated');
    await page.getByRole('heading', { name: 'Enterprise Programs', exact: true }).waitFor();
    await text('Synthetic Sensor Program');
    for (const [label, route, heading, populated] of destinations) {
      await check(`${label}: real navigation and populated synthetic content`, async () => {
        const nav = page.getByRole('navigation', { name: 'Enterprise sections' });
        if (await button('Expand sidebar').isVisible()) await button('Expand sidebar').click();
        const link = nav.getByRole('link', { name: label, exact: true });
        assert.equal(await link.getAttribute('href'), route);
        navEvent({ kind: 'intended-click', label, href: await link.getAttribute('href'), current: await link.getAttribute('aria-current'), url: page.url() });
        await Promise.all([
          page.waitForURL(url => url.pathname === route, { waitUntil: 'domcontentloaded' }),
          link.click(),
        ]);
        navEvent({ kind: 'navigation-resolved', label, url: page.url() });
        await page.getByRole('heading', { name: heading, exact: true }).waitFor();
        await text(populated);
        await shot(`populated-${label.toLowerCase()}`);
      });
    }
    for (const [label, route, heading, , empty] of destinations) {
      await check(`${label}: explicit empty state`, async () => {
        await visit(route, 'enterprise-empty');
        await page.getByRole('heading', { name: heading, exact: true }).waitFor();
        await text(empty);
        assert.doesNotMatch(await body(), /Could not load|Your session expired/);
        await shot(`empty-${label.toLowerCase()}`);
      });
    }
    for (const [label, route] of destinations) {
      await check(`${label}: server failure is not an empty or membership state`, async () => {
        await visit(route, 'enterprise-error');
        await appAlerts().filter({ hasText: /could not|failed|unavailable/i }).waitFor();
        assert.match(await body(), /could not|failed|unavailable/i);
        assert.doesNotMatch(await body(), /No workspace yet|No enterprise data|Nothing awaiting a decision/);
        await button('Try again').waitFor();
        await shot(`error-${label.toLowerCase()}`);
      });
    }
    await check('Enterprise retry explicitly recovers through the real retry button', async () => {
      await visit('/enterprise', 'enterprise-retry');
      await button('Try again').waitFor();
      retry = true;
      await button('Try again').click();
      await text('Synthetic Sensor Program');
      assert.equal(await appAlerts().count(), 0);
      await shot('enterprise-retry-recovered');
    });
    await check('Membership denial offers Compose without a login redirect', async () => {
      await visit('/enterprise', 'enterprise-membership');
      await text('No workspace yet');
      const link = page.getByRole('link', { name: 'Go to the design workspace', exact: true });
      assert.equal(await link.getAttribute('href'), '/compose');
      await page.waitForTimeout(1100);
      assert.equal(new URL(page.url()).pathname, '/enterprise');
      await shot('enterprise-membership');
    });
    await check('Expired enterprise session preserves the destination at sign-in', async () => {
      await visit('/enterprise/approvals', 'enterprise-auth');
      await text('Your session expired');
      await shot('enterprise-auth');
      await page.waitForURL(url => url.pathname === '/login');
      await page.getByText('Sign in to your workspace.', { exact: true }).waitFor();
      const next = new URL(page.url()).searchParams.get('next');
      assert.equal(next, '/enterprise/approvals?scenario=enterprise-auth');
      assert.equal(new URL(next, origin).origin, origin);
    });
    await check('Settings tabs expose actual credits and synthetic security state', async () => {
      await visit('/enterprise/settings', 'enterprise-populated');
      await button('Billing & Usage').click();
      await text('Usage ledger'); await text('85 cr');
      await shot('settings-billing');
      await button('Security').click();
      await text('on (synthetic data)'); await text('verified · tamper-evident');
      await shot('settings-security');
    });
    await check('IAM roles and permission matrix render the full response catalog', async () => {
      await visit('/enterprise/iam', 'enterprise-populated');
      await button('Roles').click(); await text('read-only (no write permissions)');
      await button('Permissions').click(); await page.getByRole('table').waitFor();
      assert.match(await body(), /22 permissions × 10 roles/);
      await shot('iam-permissions');
    });
    await check('Audit search and denied-only filter are interactive', async () => {
      await visit('/enterprise/audit', 'enterprise-populated');
      await page.getByPlaceholder('search actor / action / scope…').fill('does-not-exist-synthetic');
      await text('No matching audit entries.');
      await page.getByPlaceholder('search actor / action / scope…').fill('');
      await page.getByRole('button', { name: /^DENIED only/ }).click();
      await text('DENIED:advance_quote');
      assert.equal(await page.getByText('request_approval', { exact: true }).count(), 0);
      await shot('audit-filtered');
    });
    await check('IAM add, role change and remove use actual action contract and refresh', async () => {
      await visit('/enterprise/iam', 'enterprise-actions');
      await page.getByPlaceholder('email', { exact: true }).fill('synthetic-member@example.invalid');
      const added = await actionResponse('set_member_role', () => button('Add').click());
      assert.equal(added.result.actor_name, 'synthetic-member@example.invalid');
      const memberRow = () => page.getByText('synthetic-member@example.invalid', { exact: true }).locator('..').locator('..');
      await memberRow().getByRole('combobox').waitFor();
      await actionResponse('set_member_role', () => memberRow().getByRole('combobox').selectOption('reviewer'));
      await page.waitForFunction(() => Array.from(document.querySelectorAll('select')).some(select => select.value === 'reviewer'));
      await shot('iam-member-updated');
      await actionResponse('remove_member', () => memberRow().getByTitle('remove member').click());
      await page.getByText('synthetic-member@example.invalid', { exact: true }).waitFor({ state: 'detached' });
    });
    await check('Approval decision persists in the decided queue', async () => {
      await visit('/enterprise/approvals', 'enterprise-actions');
      const result = await actionResponse('decide_approval', () => button('Approve').click());
      assert.equal(result.result.status, 'approved');
      await text('0 awaiting · 1 decided');
      assert.equal(await button('Approve').count(), 0);
      await shot('approval-decided');
    });
    await check('Permission-denied action remains visible without a false success', async () => {
      await visit('/enterprise/approvals', 'enterprise-action-error');
      await actionResponse('decide_approval', () => button('Approve').click(), 403);
      await text(/permission denied/);
      assert.equal(await button('Approve').isEnabled(), true);
      await text('1 awaiting · 0 decided');
      await shot('approval-denied');
    });
    await check('Quote approval is not inferred from a prepared packet', async () => {
      await visit('/enterprise/quotes', 'enterprise-actions');
      await actionResponse('advance_quote', () => page.getByRole('button', { name: /quote approval requested/ }).click());
      await page.getByRole('button', { name: /approved for quote/ }).waitFor();
      await actionResponse('advance_quote', () => page.getByRole('button', { name: /approved for quote/ }).click(), 422);
      await text(/requires an approved approved_for_quote approval record/);
      await shot('quote-gate');
    });
    await check('Validation completion cannot become accepted without reviewed evidence', async () => {
      await visit('/enterprise/validation', 'enterprise-actions');
      for (const name of ['ready', 'running', 'completed pending review']) {
        await actionResponse('advance_session', () => page.getByRole('button', { name: new RegExp(`^→ ${name}$`) }).click());
      }
      await actionResponse('advance_session', () => page.getByRole('button', { name: /^→ accepted$/ }).click(), 422);
      await text(/requires at least one REVIEWED/);
      await text('No physical evidence on file.');
      await shot('validation-gate');
    });
    await check('Integration key generate and revoke stay synthetic and in-memory', async () => {
      await visit('/enterprise/integrations', 'enterprise-actions');
      await page.getByPlaceholder('key name (e.g. ci-readonly)').fill('Synthetic preview key');
      const created = await actionResponse('create_api_key', () => button('Generate').click());
      assert.equal(created.result.plaintext, syntheticCredentials.apiKey);
      await text(syntheticCredentials.apiKey);
      await shot('integration-synthetic-key');
      await button('done').click();
      await actionResponse('revoke_api_key', () => button('Revoke').click());
      await text('No active API keys.');
    });

    const openProvider = async state => {
      await visit('/compose', state);
      // ModelSelector renders null on the server and first client render; this
      // actual control appears only after its mount effect resolves auth metadata.
      // Waiting for SSR-visible provider-trigger markup alone permits a click
      // before the controlled Base UI popover has attached its interactions.
      await page.getByRole('combobox', { name: 'Model', exact: true }).waitFor();
      navEvent({ kind: 'provider-compose-ready', scenario: state, url: page.url() });
      const trigger = button('AI provider settings');
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      const read = page.waitForResponse(response => new URL(response.url()).pathname === '/api/account/llm-key' && response.request().method() === 'GET');
      const [response] = await Promise.all([read, trigger.click()]);
      assert.equal(response.headers()['x-ui-preview'], 'synthetic-only');
      assert.equal(response.status(), state === 'provider-auth' ? 401 : ['provider-error', 'provider-retry'].includes(state) ? 503 : 200);
      navEvent({ kind: 'provider-open-read', scenario: state, status: response.status() });
      await page.getByLabel('Provider', { exact: true }).waitFor();
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    };
    await check('Provider browser scope saves only synthetic credentials, with no PUT', async () => {
      await openProvider('provider-empty');
      const before = report.requests.filter(r => r.path === '/api/account/llm-key' && r.method === 'PUT').length;
      await page.getByLabel('Provider', { exact: true }).selectOption('openai');
      await page.getByLabel('API key', { exact: true }).fill(syntheticCredentials.providerKey);
      await button('Save').click(); await button('Saved').waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('fl-llm-key')), syntheticCredentials.providerKey);
      assert.equal(report.requests.filter(r => r.path === '/api/account/llm-key' && r.method === 'PUT').length, before);
      await shot('provider-browser-scope');
      await page.evaluate(() => { localStorage.removeItem('fl-llm-key'); localStorage.removeItem('fl-llm-provider'); });
    });
    await check('Provider account PUT saves redacted metadata and DELETE removes it', async () => {
      await openProvider('provider-empty');
      await page.getByLabel('My account', { exact: true }).check();
      await page.getByLabel('Provider', { exact: true }).selectOption('anthropic');
      await page.getByLabel('API key', { exact: true }).fill(syntheticCredentials.providerKey);
      const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/account/llm-key' && response.request().method() === 'PUT');
      await button('Save').click();
      assert.equal((await saved).status(), 200);
      await text(/Account key: anthropic/);
      assert.equal(await page.getByLabel('API key', { exact: true }).inputValue(), '');
      assert.equal(await page.evaluate(() => localStorage.getItem('fl-llm-key')), null);
      await shot('provider-account-saved');
      const removed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/account/llm-key' && response.request().method() === 'DELETE');
      await button('Remove account key').click(); assert.equal((await removed).status(), 200);
      await page.getByText(/Account key:/).waitFor({ state: 'detached' });
      await shot('provider-account-removed');
    });
    await check('Provider failed save preserves typed synthetic credential', async () => {
      await openProvider('provider-save-error');
      await page.getByLabel('My account', { exact: true }).check();
      await page.getByLabel('Provider', { exact: true }).selectOption('anthropic');
      await page.getByLabel('API key', { exact: true }).fill(syntheticCredentials.providerKey);
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/account/llm-key' && response.request().method() === 'PUT');
      await button('Save').click();
      const response = await responsePromise;
      assert.equal(response.status(), 503);
      assert.equal(response.headers()['x-ui-preview'], 'synthetic-only');
      await appAlerts().filter({ hasText: 'Could not confirm account key save.' }).waitFor();
      await appAlerts().filter({ hasText: 'Account key status may be out of date.' }).waitFor();
      assert.equal(await page.getByLabel('API key', { exact: true }).inputValue(), syntheticCredentials.providerKey);
      assert.equal(await button('Save').isEnabled(), true);
      assert.equal(await button('Saved').count(), 0);
      await shot('provider-save-error');
    });
    await check('Provider failed DELETE does not claim the account key was removed', async () => {
      await openProvider('provider-delete-error'); await text(/Account key: anthropic/);
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/account/llm-key' && response.request().method() === 'DELETE');
      await button('Remove account key').click();
      const response = await responsePromise;
      assert.equal(response.status(), 503);
      assert.equal(response.headers()['x-ui-preview'], 'synthetic-only');
      await appAlerts().filter({ hasText: 'Could not confirm account key removal.' }).waitFor();
      await appAlerts().filter({ hasText: 'Account key status may be out of date.' }).waitFor();
      assert.equal(await button('Remove account key').isVisible(), true);
      assert.equal(await button('Remove account key').isEnabled(), true);
      assert.equal(await page.getByText('No account key saved.', { exact: true }).count(), 0);
      await text(/Account key: anthropic/); await shot('provider-delete-error');
    });
    for (const state of ['provider-error', 'provider-auth']) {
      await check(`${state}: failed account read is visible`, async () => {
        await openProvider(state);
        const message = state === 'provider-auth' ? 'Sign in to view your account key.' : 'Account key request failed (HTTP 503).';
        await appAlerts().filter({ hasText: message }).waitFor();
        assert.match(await body(), /failed|unavailable|sign in|session|could not/i);
        assert.equal(await page.getByText(/Account key:/).count(), 0);
        await shot(state);
      });
    }
    await check('Provider read retry uses the real recovery control', async () => {
      await openProvider('provider-retry');
      await appAlerts().filter({ hasText: 'Account key request failed (HTTP 503).' }).waitFor();
      retry = true;
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/account/llm-key' && response.request().method() === 'GET');
      await button('Try again').click();
      const response = await responsePromise;
      assert.equal(response.status(), 200);
      assert.equal(response.headers()['x-ui-preview'], 'synthetic-only');
      // Error disappearance alone can be the intermediate loading state. Require
      // the successful empty-account response and its settled visible content.
      assert.equal((await response.json()).key, null);
      await text('No account key saved.');
      assert.equal(await appAlerts().count(), 0);
      assert.equal(await button('Try again').count(), 0);
      await shot('provider-retry');
    });
    await check('Catalog template opens a draft without submitting an AI request', async () => {
      await visit('/enterprise/catalog', 'enterprise-populated');
      await text('Synthetic QFN sensor');
      const before = report.requests.filter(r => r.method === 'POST' && ['/api/architect', '/api/interview'].includes(r.path)).length;
      await page.getByRole('link', { name: /Environmental Telemetry Node/ }).click();
      await page.waitForURL(url => url.pathname === '/compose');
      const composer = page.getByRole('textbox', { name: 'Describe your product or board', exact: true });
      await composer.waitFor();
      await page.waitForFunction(() => document.querySelector('textarea')?.value.includes('environmental telemetry node'));
      assert.match(await composer.inputValue(), /environmental telemetry node/);
      assert.equal(report.requests.filter(r => r.method === 'POST' && ['/api/architect', '/api/interview'].includes(r.path)).length, before);
      await shot('catalog-compose-draft');
    });
    await check('Start fragment transfers a synthetic draft privately without submission', async () => {
      const prompt = 'Synthetic private start handoff 3.3 V sensor';
      scenario = 'provider-empty'; retry = false;
      await page.evaluate(() => { sessionStorage.clear(); localStorage.clear(); });
      const before = report.requests.length;
      await page.goto(`${origin}/start#prompt=${encodeURIComponent(prompt)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForURL(url => url.pathname === '/compose');
      const composer = page.getByRole('textbox', { name: 'Describe your product or board', exact: true });
      await composer.waitFor();
      await page.waitForFunction(expected => document.querySelector('textarea')?.value === expected, prompt);
      assert.equal(await composer.inputValue(), prompt);
      assert.equal(new URL(page.url()).hash, '');
      const requests = report.requests.slice(before);
      assert.ok(requests.every(request => !decodeURIComponent(request.url).includes(prompt)));
      assert.equal(requests.filter(r => r.method === 'POST' && ['/api/architect', '/api/interview'].includes(r.path)).length, 0);
      await shot('start-private-draft');
    });
    await check('Narrow enterprise navigation and keyboard settings tabs stay contained', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await visit('/enterprise', 'enterprise-populated');
      await page.getByRole('heading', { name: 'Enterprise Programs', exact: true }).waitFor();
      await text('Synthetic Sensor Program');
      const contained = async label => {
        const dimensions = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth }));
        assert.ok(dimensions.document <= dimensions.width, `${label}: document ${dimensions.document}px exceeds viewport ${dimensions.width}px`);
      };
      if (await button('Collapse sidebar').isVisible()) await button('Collapse sidebar').click();
      const nav = page.getByRole('navigation', { name: 'Enterprise sections' });
      await button('Expand sidebar').waitFor();
      const box = await nav.boundingBox();
      assert.ok(box && box.width >= 44 && box.width <= 390 && box.x >= 0 && box.x + box.width <= 390);
      await contained('collapsed navigation');
      await button('Expand sidebar').click();
      assert.equal(await button('Collapse sidebar').getAttribute('aria-expanded'), 'true');
      await contained('expanded navigation');
      // A horizontal scroll strip is intentional; only document overflow fails.
      const settingsLink = nav.getByRole('link', { name: 'Settings', exact: true });
      await settingsLink.scrollIntoViewIfNeeded();
      await settingsLink.click();
      const heading = page.getByRole('heading', { name: 'Workspace settings', exact: true });
      await heading.waitFor();
      assert.equal(await settingsLink.getAttribute('aria-current'), 'page');
      const main = await page.getByRole('main').boundingBox();
      assert.ok(main && main.width >= 388 && main.x >= 0 && main.x + main.width <= 390, 'mobile main retains full viewport width');
      const headingBox = await heading.boundingBox();
      assert.ok(headingBox && headingBox.x >= 0 && headingBox.x + headingBox.width <= 390, 'settings heading is contained');
      await contained('Settings members');
      // Start at the actual last navigation link, then prove each native settings
      // button is reachable by Tab and activatable by Enter, not forced clicks.
      await settingsLink.focus();
      for (const [name, content, screenshot] of [
        ['Members', 'Team members', 'members'],
        ['Billing & Usage', 'Usage ledger', 'billing'],
        ['Security', 'on (synthetic data)', 'security'],
      ]) {
        const tab = button(name);
        let reached = false;
        for (let step = 0; step < 20; step++) {
          await page.keyboard.press('Tab');
          if (await tab.evaluate(element => element === document.activeElement)) { reached = true; break; }
        }
        assert.ok(reached, `${name} must be reachable by keyboard within 20 Tab presses`);
        const tabBox = await tab.boundingBox();
        assert.ok(tabBox && tabBox.x >= 0 && tabBox.x + tabBox.width <= 390 && tabBox.y >= 0 && tabBox.y + tabBox.height <= 844, `${name} focused control is visible inside viewport`);
        await page.keyboard.press('Enter');
        await text(content);
        await contained(`Settings ${name}`);
        await shot(`enterprise-narrow-settings-${screenshot}`);
      }
    });
    report.browser = await browser.version();
    await check('No uncaught browser or hydration errors', () => { assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleIssues, []); });
    await check('No external traffic, run artifacts or downloads attempted', () => assert.deepEqual(report.blocked, []));
    await check('Owned API responses are synthetic-only', () => {
      const owned = report.responses.filter(r => ['/api/enterprise', '/api/account/llm-key', catalogFixturePath].includes(r.path));
      assert.ok(owned.length > 0); assert.ok(owned.every(r => r.fixture === 'synthetic-only'));
    });
    await check('Frozen snapshot remains unchanged', async () => {
      const response = await fetch(`${origin}/api/ux-preview/snapshot`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-ui-preview'), 'synthetic-only');
      const current = await response.json();
      assert.equal(current.frozen, true);
      assert.equal(current.sha256, snapshot.sha256);
    });
  } finally {
    clearTimeout(deadline);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
    console.log(JSON.stringify(report, null, 2));
    if (report.failures.length) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
