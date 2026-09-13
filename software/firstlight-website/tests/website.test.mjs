import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const source = (path) => readFileSync(new URL(path, root), "utf8");

function load(path, { env = {}, modules = {}, globals = {} } = {}) {
  const { outputText } = ts.transpileModule(source(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    require: (id) => id in modules ? modules[id] : require(id),
    URL,
    process: { env },
    ...globals,
  }, { filename: path });
  return exports;
}

test("public origins use production defaults and normalize valid overrides", () => {
  const config = load("lib/public-config.ts");
  assert.equal(config.SITE_URL, "https://firstlight.build");
  assert.equal(config.COMPOSE_URL, "https://app.firstlight.build");
  const override = load("lib/public-config.ts", { env: {
    NEXT_PUBLIC_SITE_URL: "https://www.example.com/",
    NEXT_PUBLIC_COMPOSE_URL: "https://app.example.com:8443/",
  } });
  assert.equal(override.SITE_URL, "https://www.example.com");
  assert.equal(override.COMPOSE_URL, "https://app.example.com:8443");
});

test("origin validation rejects unsafe, ambiguous, and non-origin values", () => {
  const { validatePublicOrigin } = load("lib/public-config.ts");
  for (const value of [
    "javascript:alert(1)", "data:text/html,hello", "ftp://example.com", "http://example.com",
    "//example.com", "https://user:pass@example.com", "https://@example.com",
    "https://example.com/path", "https://example.com/../", "https://example.com/?a=1",
    "https://example.com?", "https://example.com/#x", "https://example.com#",
    "https://example.com\\path", " https://example.com", "https://example.com\n", "",
  ]) {
    assert.throws(() => validatePublicOrigin(value, "TEST", false), /TEST must be an HTTPS origin/, value);
  }
  for (const value of ["http://localhost:4500", "https://localhost", "http://127.0.0.1:4500", "http://127.1", "http://[::1]:4500"]) {
    assert.throws(() => validatePublicOrigin(value, "TEST", false), /TEST must be an HTTPS origin/);
    assert.equal(validatePublicOrigin(value, "TEST", true), new URL(value).origin);
  }
  assert.throws(() => validatePublicOrigin("http://localhost.example.com", "TEST", true));
  assert.throws(() => load("lib/public-config.ts", { env: { NEXT_PUBLIC_COMPOSE_URL: "https://example.com/path" } }));
});

test("every public page provides its own canonical, Open Graph and Twitter metadata", () => {
  const config = load("lib/public-config.ts");
  const { pageMetadata, COMPOSE_IMAGE, FL1_IMAGE } = load("lib/metadata.ts", { modules: { "./public-config": config } });
  const routes = ["/", "/fl1", "/developers", "/case-study", "/terms", "/privacy"];
  for (const path of routes) {
    const file = path === "/" ? "app/page.tsx" : `app${path}/page.tsx`;
    assert.ok(source(file).includes(`path: "${path}"`));
    const image = ["/fl1", "/case-study"].includes(path) ? FL1_IMAGE : COMPOSE_IMAGE;
    const meta = pageMetadata({ path, title: path, description: `About ${path}`, image });
    assert.equal(meta.alternates.canonical, new URL(path, config.SITE_URL).href);
    assert.equal(meta.openGraph.url, meta.alternates.canonical);
    assert.equal(meta.openGraph.title, meta.title);
    assert.equal(meta.twitter.title, meta.title);
    assert.equal(meta.twitter.description, meta.description);
    assert.equal(meta.twitter.images[0].url, image.url);
  }
  for (const path of ["app/robots.ts", "app/sitemap.ts", "app/layout.tsx"]) {
    assert.match(source(path), /import \{ SITE_URL \} from "\.\.\/lib\/public-config"/);
  }
});

test("navigation and footer sit outside a focusable main on each marketing page", () => {
  for (const path of ["app/page.tsx", "app/fl1/page.tsx", "app/developers/page.tsx", "app/case-study/page.tsx"]) {
    const text = source(path);
    const main = text.indexOf('<main id="main-content" tabIndex={-1}>');
    assert.ok(main > text.indexOf("</nav>"), path);
    assert.ok(text.indexOf("</main>") < text.indexOf('<footer className="footer">'), path);
    assert.equal((text.match(/<main\b/g) || []).length, 1);
  }
  assert.match(source("app/case-study/page.tsx"), /<div className="case-study">/);
  for (const path of ["app/terms/page.tsx", "app/privacy/page.tsx", "app/not-found.tsx"]) {
    assert.match(source(path), /id="main-content" tabIndex=\{-1\}/);
  }
});

test("deposit copy uses the runtime price and CLI examples agree with copied docs", () => {
  for (const path of ["app/fl1/page.tsx", "app/terms/page.tsx"]) {
    const text = source(path);
    assert.match(text, /export const dynamic = "force-dynamic"/);
    assert.match(text, /const \{ formatted \} = getReservationPrice\(\)/);
    assert.doesNotMatch(text, /\$2,500/);
  }
  const commands = [
    'firstlight artifacts "$RUN_ID"',
    'firstlight get "$RUN_ID" step -o enclosure.step',
    'firstlight get "$RUN_ID" fab-package -o fab.zip',
    'firstlight status "$RUN_ID" --watch',
  ];
  for (const path of ["app/developers/page.tsx", "app/developers/CopyForAi.tsx"]) {
    const text = source(path);
    for (const command of commands) assert.ok(text.includes(command));
    assert.doesNotMatch(text, /firstlight (?:artifacts|get|status) (?:&lt;|<runId>)/);
  }
});

// Minimal hook harness: exercises the actual copy handler without a browser or new dependencies.
function copyHarness({ clipboard, legacy = () => false } = {}) {
  const hooks = [];
  const effects = [];
  const timers = new Map();
  let cursor = 0;
  let timerId = 0;
  let legacyCalls = 0;
  let removed = 0;
  let restored = 0;
  let manualFocused = 0;
  let manualSelected = 0;
  class HTMLElement { focus() { restored++; } }
  const react = {
    useState(initial) {
      const index = cursor++;
      hooks[index] ??= initial;
      return [hooks[index], (value) => { hooks[index] = value; }];
    },
    useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
    useId() { cursor++; return "copy-reference"; },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) {
        effects.push(() => {
          previous?.cleanup?.();
          hooks[index] = { deps, cleanup: effect() };
        });
      }
    },
  };
  const { CopyForAi } = load("app/developers/CopyForAi.tsx", {
    modules: { react },
    globals: {
      navigator: { clipboard }, HTMLElement,
      document: {
        activeElement: new HTMLElement(),
        body: { appendChild() {} },
        createElement: () => ({ style: {}, focus() {}, select() {}, remove() { removed++; } }),
        execCommand: () => { legacyCalls++; return legacy(); },
      },
      setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
      clearTimeout: (id) => timers.delete(id),
    },
  });
  function render() {
    cursor = 0;
    const tree = CopyForAi();
    const textarea = tree.props.children[2]?.props?.children[2];
    if (textarea) {
      textarea.props.ref.current = {
        focus() { manualFocused++; },
        select() { manualSelected++; },
      };
    }
    while (effects.length) effects.shift()();
    return tree;
  }
  const tree = render();
  return {
    click: () => tree.props.children[0].props.onClick(),
    status: () => hooks[0], render, timers,
    fallback: () => ({ legacyCalls, removed, restored }),
    manualFocus: () => ({ manualFocused, manualSelected }),
    unmount: () => hooks.forEach((hook) => hook?.cleanup?.()),
  };
}

test("clipboard success announces success and cleans reset timers on retry/unmount", async () => {
  const harness = copyHarness({ clipboard: { writeText: async () => {} } });
  await harness.click();
  assert.equal(harness.status(), "copied");
  assert.equal(harness.timers.size, 1);
  await harness.click();
  assert.equal(harness.timers.size, 1);
  assert.equal(harness.fallback().legacyCalls, 0);
  harness.unmount();
  assert.equal(harness.timers.size, 0);
});

test("failed legacy copy returns visible manual text, never false success", async () => {
  for (const legacy of [() => false, () => { throw new Error("blocked"); }]) {
    const harness = copyHarness({ legacy });
    await harness.click();
    assert.equal(harness.status(), "manual");
    assert.deepEqual(harness.fallback(), { legacyCalls: 1, removed: 1, restored: 1 });
    assert.equal(harness.timers.size, 0);
    const tree = harness.render();
    const manual = tree.props.children[2];
    const textarea = manual.props.children[2];
    assert.equal(textarea.type, "textarea");
    assert.equal(textarea.props.readOnly, true);
    assert.ok(textarea.props.value.includes('firstlight artifacts "$RUN_ID"'));
    assert.equal(textarea.props["aria-describedby"], "copy-reference-hint");
    assert.deepEqual(harness.manualFocus(), { manualFocused: 1, manualSelected: 1 });
  }
});

test("legacy copy only reports success for true; pending copy cannot update after unmount", async () => {
  const fallback = copyHarness({ clipboard: { writeText: async () => { throw new Error("denied"); } }, legacy: () => true });
  await fallback.click();
  assert.equal(fallback.status(), "copied");
  fallback.unmount();

  let finish;
  const pending = copyHarness({ clipboard: { writeText: () => new Promise((resolve) => { finish = resolve; }) } });
  const click = pending.click();
  pending.unmount();
  finish();
  await click;
  assert.equal(pending.timers.size, 0);
  assert.equal(pending.status(), "copying");
});
