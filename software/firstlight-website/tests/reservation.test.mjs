import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { test, beforeEach, afterEach } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createReservation, getReservationPrice, getReservationStatus } from "../lib/reservation.ts";

const KEYS = ["STRIPE_SECRET_KEY", "STRIPE_RESERVATION_AMOUNT_CENTS", "APP_URL", "NODE_ENV", "STRIPE_CHECKOUT_HOST"];
const SESSION = "cs_test_mockSession123456789";
const OTHER_SESSION = "cs_test_otherSession123456789";
const KEY = "sk_test_fake_not_a_real_stripe_key";
let saved;

beforeEach((t) => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  process.env.STRIPE_SECRET_KEY = KEY;
  process.env.APP_URL = "https://firstlight.example";
  process.env.NODE_ENV = "test";
  // A forgotten mock fails locally; no test may make a real network request.
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unmocked network access forbidden"); });
});
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function request(cookie, id = SESSION) {
  return new Request(`https://firstlight.example/api/reserve/status?session_id=${encodeURIComponent(id)}`, {
    headers: cookie ? { cookie } : {},
  });
}

async function checkout(t, overrides = {}) {
  let form;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.stripe.com/v1/checkout/sessions");
    assert.equal(options.method, "POST");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
    form = options.body;
    return Response.json({ id: SESSION, url: "https://checkout.stripe.com/c/pay/mock", ...overrides });
  });
  const response = await createReservation(new Request("https://firstlight.example/api/reserve", {
    method: "POST", headers: { origin: "https://firstlight.example" },
  }));
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  const session = {
    id: SESSION, mode: "payment", status: "complete", payment_status: "paid",
    livemode: true, amount_total: Number(form?.get("line_items[0][price_data][unit_amount]")), currency: "usd",
    metadata: { type: "fl1_reservation", reservation_nonce: form?.get("metadata[reservation_nonce]") },
    customer_details: { email: "private@example.com", name: "Private Customer", address: { line1: "Sensitive Street" } },
    customer: "cus_private", payment_intent: "pi_private",
  };
  return { response, cookie, form, session };
}

async function verify(t, cookie, session, status = 200) {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, `https://api.stripe.com/v1/checkout/sessions/${SESSION}`);
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(session, { status });
  });
  const response = await getReservationStatus(request(cookie));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  return response.json();
}

function resign(cookie, changes) {
  const payload = JSON.parse(Buffer.from(cookie.split("=")[1].split(".")[0], "base64url").toString());
  const encoded = Buffer.from(JSON.stringify({ ...payload, ...changes })).toString("base64url");
  const signature = createHmac("sha256", KEY).update(`fl1-reservation:v1:${encoded}`).digest("base64url");
  return `fl1_reservation=${encoded}.${signature}`;
}

test("price uses runtime env, unchanged default, and exact cents formatting", () => {
  assert.deepEqual(getReservationPrice(), { amountCents: 250000, currency: "usd", formatted: "$2,500" });
  process.env.STRIPE_RESERVATION_AMOUNT_CENTS = " 250001 ";
  assert.deepEqual(getReservationPrice(), { amountCents: 250001, currency: "usd", formatted: "$2,500.01" });
  process.env.STRIPE_RESERVATION_AMOUNT_CENTS = "99999999";
  assert.equal(getReservationPrice().amountCents, 99999999);
});

test("invalid configured amounts fail closed before Stripe", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected Stripe call"));
  for (const amount of ["", " ", "0", "-1", "1.5", "2e5", "+250000", "NaN", "Infinity", "100000000", "9007199254740993", "250,000"]) {
    process.env.STRIPE_RESERVATION_AMOUNT_CENTS = amount;
    assert.throws(getReservationPrice, /Invalid reservation amount/);
    const response = await createReservation(new Request("https://firstlight.example/api/reserve", { method: "POST" }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("creation binds random browser nonce, original price and session with secure cookie", async (t) => {
  process.env.NODE_ENV = "production";
  const first = await checkout(t);
  assert.equal(first.response.status, 200);
  assert.deepEqual(await first.response.json(), { url: "https://checkout.stripe.com/c/pay/mock" });
  assert.equal(first.form.get("mode"), "payment");
  assert.equal(first.form.get("metadata[type]"), "fl1_reservation");
  assert.equal(first.form.get("line_items[0][price_data][unit_amount]"), "250000");
  assert.equal(first.form.get("line_items[0][price_data][currency]"), "usd");
  assert.equal(first.form.get("success_url"), "https://firstlight.example/fl1?session_id={CHECKOUT_SESSION_ID}#reserve");
  assert.equal(first.form.get("cancel_url"), "https://firstlight.example/fl1?reservation_cancelled=1#reserve");
  const cookie = first.response.headers.get("set-cookie");
  for (const attribute of ["HttpOnly", "SameSite=Lax", "Secure", "Path=/api/reserve", "Max-Age=172800"]) assert.ok(cookie.includes(attribute));
  const second = await checkout(t);
  assert.notEqual(first.cookie, second.cookie);
  assert.notEqual(first.form.get("metadata[reservation_nonce]"), second.form.get("metadata[reservation_nonce]"));
});

test("origin and missing key protection make no upstream calls", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected Stripe call"));
  const req = (origin = "https://firstlight.example") => new Request("https://firstlight.example/api/reserve", {
    method: "POST", headers: { origin },
  });
  assert.equal((await createReservation(req("https://attacker.example"))).status, 403);
  assert.equal((await createReservation(req("invalid"))).status, 400);
  process.env.NODE_ENV = "production";
  delete process.env.APP_URL;
  assert.equal((await createReservation(req())).status, 503);
  for (const origin of ["http://firstlight.example", "https://user:password@firstlight.example", "garbage"]) {
    process.env.APP_URL = origin;
    assert.equal((await createReservation(req())).status, 503);
  }
  process.env.APP_URL = "https://firstlight.example";
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal((await createReservation(req())).status, 503);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("creation accepts configured checkout host but rejects unsafe checkout URLs and missing IDs", async (t) => {
  for (const url of ["http://checkout.stripe.com/pay", "https://checkout.stripe.com.attacker.example/pay", "https://user:pw@checkout.stripe.com/pay", "javascript:alert(1)", "https://checkout.stripe.com:444/pay", null]) {
    assert.equal((await checkout(t, { url })).response.status, 502);
  }
  for (const id of [undefined, "../sessions", "not_a_session"]) assert.equal((await checkout(t, { id })).response.status, 502);
  process.env.STRIPE_CHECKOUT_HOST = "pay.firstlight.example";
  assert.equal((await checkout(t, { url: "https://pay.firstlight.example/session" })).response.status, 200);
});

test("live and test receipts are distinct and contain no PII, Stripe objects, or session ID", async (t) => {
  const { cookie, session } = await checkout(t);
  assert.deepEqual(await verify(t, cookie, session), { status: "confirmed" });
  assert.deepEqual(await verify(t, cookie, { ...session, livemode: false }), { status: "test-confirmed" });
});

test("verification uses integrity-protected original amount after config changes", async (t) => {
  const { cookie, session } = await checkout(t);
  process.env.STRIPE_RESERVATION_AMOUNT_CENTS = "invalid-new-config";
  assert.deepEqual(await verify(t, cookie, session), { status: "confirmed" });
  assert.deepEqual(await verify(t, cookie, { ...session, amount_total: 500000 }), { status: "unverified" });
});

test("all session receipt fields must match before a confirmation is possible", async (t) => {
  const { cookie, session } = await checkout(t);
  for (const change of [
    { id: OTHER_SESSION }, { mode: "subscription" }, { mode: undefined },
    { metadata: { ...session.metadata, type: "other" } },
    { metadata: { ...session.metadata, reservation_nonce: "other_browser" } },
    { metadata: null }, { amount_total: "250000" }, { amount_total: 250001 },
    { currency: "eur" }, { currency: "USD" }, { livemode: "true" }, { livemode: undefined },
    { status: "expired" }, { status: "open", payment_status: "paid" },
    { payment_status: "no_payment_required" }, { status: undefined }, { payment_status: undefined },
  ]) {
    assert.deepEqual(await verify(t, cookie, { ...session, ...change }), { status: "unverified" });
  }
});

test("unpaid sessions remain pending, not confirmed", async (t) => {
  const { cookie, session } = await checkout(t);
  for (const status of ["open", "complete"]) {
    assert.deepEqual(await verify(t, cookie, { ...session, status, payment_status: "unpaid" }), { status: "pending" });
  }
});

test("malformed, absent, mismatched, expired, or tampered browser binding stops before fetch", async (t) => {
  const { cookie } = await checkout(t);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected Stripe read"));
  const invalidCookies = [
    undefined, "fl1_reservation=garbage", "fl1_reservation=" + "a".repeat(3000),
    cookie.replace(/.$/, "!"), `${cookie}; ${cookie}`, resign(cookie, { sessionId: OTHER_SESSION }),
    resign(cookie, { expires: Date.now() - 1000 }), resign(cookie, { amountCents: 0 }),
    resign(cookie, { currency: "eur" }), resign(cookie, { nonce: "invalid" }),
  ];
  // Edit the amount without recomputing the signature.
  const [payload, sig] = cookie.split("=")[1].split(".");
  const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), amountCents: 1 })).toString("base64url");
  invalidCookies.push(`fl1_reservation=${altered}.${sig}`);
  for (const invalid of invalidCookies) {
    assert.deepEqual(await (await getReservationStatus(request(invalid))).json(), { status: "unverified" });
  }
  for (const id of [OTHER_SESSION, "../../customer", "", "cs_test_" + "x".repeat(300)]) {
    assert.deepEqual(await (await getReservationStatus(request(cookie, id))).json(), { status: "unverified" });
  }
  for (const query of ["reserved=1", `session_id=${SESSION}&session_id=${SESSION}`]) {
    assert.deepEqual(await (await getReservationStatus(new Request(`https://firstlight.example/api/reserve/status?${query}`, { headers: { cookie } }))).json(), { status: "unverified" });
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("Stripe errors and malformed JSON return only unavailable/unverified", async (t) => {
  const { cookie } = await checkout(t);
  for (const status of [400, 401, 429, 500]) {
    assert.deepEqual(await verify(t, cookie, { error: { message: "private@example.com sk_secret" } }, status), { status: "unavailable" });
  }
  assert.deepEqual(await verify(t, cookie, {}, 404), { status: "unverified" });
  for (const body of ["not JSON", "null"]) {
    t.mock.method(globalThis, "fetch", async () => new Response(body));
    const response = await getReservationStatus(request(cookie));
    assert.deepEqual(await response.json(), { status: body === "null" ? "unverified" : "unavailable" });
    const creation = await createReservation(new Request("https://firstlight.example/api/reserve", { method: "POST" }));
    assert.equal(creation.status, 502);
    assert.ok(!(await creation.text()).includes("sk_secret"));
  }
});

test("native fetch failures and abort timeout fail safely without leaking error details", async (t) => {
  const { cookie } = await checkout(t);
  for (const timeout of [false, true]) {
    if (timeout) t.mock.method(AbortSignal, "timeout", (milliseconds) => {
      assert.equal(milliseconds, 10000);
      return AbortSignal.abort(new DOMException("private@example.com", "TimeoutError"));
    });
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      if (timeout) options.signal.throwIfAborted();
      throw new Error("private@example.com sk_secret");
    });
    const status = await getReservationStatus(request(cookie));
    assert.equal(status.status, 503);
    assert.deepEqual(await status.json(), { status: "unavailable" });
    const creation = await createReservation(new Request("https://firstlight.example/api/reserve", { method: "POST" }));
    assert.equal(creation.status, 502);
    const body = await creation.text();
    assert.ok(!body.includes("private@example.com"));
    assert.ok(!body.includes("sk_secret"));
  }
});

// Tiny isolated React hook harness. No server, browser, shared files, installs,
// Stripe SDK, or network is required to exercise return handling and cleanup.
function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
}
function clientHarness(url, fetchImpl, storage = memoryStorage()) {
  const source = readFileSync(new URL("../app/reserve-button.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const slots = [];
  const effects = [];
  const timers = new Map();
  let index = 0;
  let timerId = 0;
  let scheduled = [];
  const runtime = {
    useState(initial) {
      const position = index++;
      if (!(position in slots)) slots[position] = initial;
      return [slots[position], (value) => { slots[position] = typeof value === "function" ? value(slots[position]) : value; }];
    },
    useRef(initial) {
      const position = index++;
      return slots[position] ??= { current: initial };
    },
    useEffect(callback, dependencies) {
      const position = index++;
      const old = effects[position];
      if (!old || dependencies.some((dependency, i) => dependency !== old.dependencies[i])) {
        scheduled.push(() => { old?.cleanup?.(); effects[position] = { dependencies, cleanup: callback() }; });
      }
    },
  };
  const window = {
    sessionStorage: storage,
    location: { href: url, assign() { assert.fail("Unexpected payment navigation"); } },
    history: { state: {}, replaceState(_state, _title, path) { window.location.href = new URL(path, window.location.href).href; } },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, require(name) {
      if (name === "react") return runtime;
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      assert.fail(`Unexpected client dependency ${name}`);
    }, window, fetch: fetchImpl, URL, URLSearchParams, AbortController, console,
  });
  function render() {
    index = 0;
    scheduled = [];
    const result = exports.ReserveButton({});
    for (const effect of scheduled) effect();
    return result;
  }
  return {
    window, render,
    text: () => JSON.stringify(render()),
    button: () => render().props.children[0].props,
    unmount: () => { for (const effect of effects) effect?.cleanup?.(); },
    expire: () => { for (const callback of timers.values()) callback(); },
    effects,
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("client never trusts reserved=1, strips return parameters and prevents another checkout", async () => {
  const client = clientHarness("https://firstlight.example/fl1?reserved=1&keep=yes#reserve", () => assert.fail("Legacy flag must not fetch"));
  client.render();
  assert.ok(client.text().includes("could not verify"));
  assert.ok(!client.text().includes("deposit is confirmed"));
  assert.equal(client.window.location.href, "https://firstlight.example/fl1?keep=yes#reserve");
  assert.equal(client.button().disabled, true);
});

test("client reports honest live, test, pending and unavailable states and offers only status rechecks", async () => {
  for (const status of ["confirmed", "test-confirmed", "pending", "unverified", "unavailable", "bad-status"]) {
    const client = clientHarness(`https://firstlight.example/fl1?session_id=${SESSION}&reserved=1#reserve`, async (url, options) => {
      assert.equal(url, `/api/reserve/status?session_id=${SESSION}`);
      assert.equal(options.cache, "no-store");
      assert.equal(options.credentials, "same-origin");
      return Response.json({ status });
    });
    client.render();
    await flush();
    const text = client.text();
    assert.equal(client.window.location.href, "https://firstlight.example/fl1#reserve");
    if (status === "test-confirmed") assert.ok(text.includes("No real deposit was collected and no reservation was made"));
    if (status === "pending") assert.ok(text.includes("not yet confirmed"));
    if (["pending", "unavailable", "bad-status"].includes(status)) {
      assert.equal(client.button().children, "Check payment status");
      assert.equal(client.button().disabled, false);
    } else assert.equal(client.button().disabled, true);
    client.unmount();
  }
});

test("client verification timeout is bounded and retry never opens checkout", async () => {
  let calls = 0;
  const client = clientHarness(`https://firstlight.example/fl1?session_id=${SESSION}`, (url, { signal }) => {
    calls++;
    assert.ok(url.startsWith("/api/reserve/status?"));
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("timeout"))));
  });
  client.render();
  assert.equal(client.button().disabled, true);
  client.expire();
  await flush();
  assert.ok(client.text().includes("verification is temporarily unavailable"));
  client.button().onClick();
  client.render();
  assert.equal(calls, 2);
  client.unmount();
});

test("client cancels stale verification and ignores its late response", async () => {
  let resolve;
  let signal;
  const client = clientHarness(`https://firstlight.example/fl1?session_id=${SESSION}`, (_url, options) => {
    signal = options.signal;
    return new Promise((done) => { resolve = done; });
  });
  client.render();
  client.unmount();
  assert.equal(signal.aborted, true);
  resolve(Response.json({ status: "confirmed" }));
  await flush();
  assert.ok(!client.text().includes("deposit is confirmed"));
});

test("refresh after URL cleanup re-verifies every receipt state without offering another checkout", async () => {
  for (const status of ["pending", "unavailable", "unverified", "confirmed", "test-confirmed"]) {
    const storage = memoryStorage();
    let calls = 0;
    const fetchStatus = async (url) => {
      calls++;
      assert.equal(url, `/api/reserve/status?session_id=${SESSION}`);
      return Response.json({ status });
    };
    const first = clientHarness(`https://firstlight.example/fl1?session_id=${SESSION}#reserve`, fetchStatus, storage);
    first.render();
    await flush();
    assert.equal(first.window.location.href, "https://firstlight.example/fl1#reserve");
    first.unmount();
    const refreshed = clientHarness(first.window.location.href, fetchStatus, storage);
    const initialButton = refreshed.render().props.children[0].props;
    assert.equal(initialButton.disabled, true, "Checkout must be disabled before recovery effect finishes");
    await flush();
    assert.equal(calls, 2, "Stored state is a hint, not a trusted cached receipt");
    assert.ok(!refreshed.button().children.includes("Reserve"));
    if (status === "pending" || status === "unavailable") {
      assert.equal(refreshed.button().children, "Check payment status");
      assert.ok(refreshed.text().includes("do not pay again") || refreshed.text().includes("Do not pay again"));
    } else assert.equal(refreshed.button().disabled, true);
    refreshed.unmount();
  }
});

test("unavailable or silently failing storage retains return URL and refresh guard", async () => {
  for (const storage of [
    { getItem() { throw new Error("storage blocked"); }, setItem() { throw new Error("storage blocked"); } },
    { getItem() { return null; }, setItem() { throw new Error("quota exceeded"); } },
    { getItem() { return null; }, setItem() {} },
  ]) {
    const url = `https://firstlight.example/fl1?session_id=${SESSION}#reserve`;
    let calls = 0;
    const fetchStatus = async (path) => {
      calls++;
      assert.equal(path, `/api/reserve/status?session_id=${SESSION}`);
      return Response.json({ status: "pending" });
    };
    const first = clientHarness(url, fetchStatus, storage);
    first.render();
    await flush();
    assert.equal(first.window.location.href, url);
    first.unmount();
    const refreshed = clientHarness(first.window.location.href, fetchStatus, storage);
    refreshed.render();
    await flush();
    assert.equal(calls, 2);
    assert.equal(refreshed.button().children, "Check payment status");
    refreshed.unmount();
  }
});

test("legacy returns and corrupt or inaccessible stored state fail closed after refresh", async () => {
  const storage = memoryStorage();
  const first = clientHarness("https://firstlight.example/fl1?reserved=1", () => assert.fail("No session to verify"), storage);
  first.render();
  const refreshed = clientHarness(first.window.location.href, () => assert.fail("No session to verify"), storage);
  refreshed.render();
  assert.equal(refreshed.button().disabled, true);
  assert.ok(refreshed.text().includes("could not verify"));
  storage.setItem("fl1-checkout-return-v1", "corrupt JSON");
  const corrupt = clientHarness("https://firstlight.example/fl1", () => assert.fail("No session to verify"), storage);
  corrupt.render();
  assert.equal(corrupt.button().disabled, true);
  assert.ok(corrupt.text().includes("could not verify"));
  const blocked = clientHarness("https://firstlight.example/fl1", () => assert.fail("No session to verify"), {
    getItem() { throw new Error("storage blocked"); }, setItem() { throw new Error("storage blocked"); },
  });
  blocked.render();
  assert.equal(blocked.button().disabled, true);
  assert.ok(blocked.text().includes("could not verify"));
});

test("client creation timeout and unmount abort requests without stale updates", async () => {
  for (const unmount of [false, true]) {
    let signal;
    const client = clientHarness("https://firstlight.example/fl1", (url, options) => {
      assert.equal(url, "/api/reserve");
      assert.equal(options.method, "POST");
      signal = options.signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    client.render();
    const pending = client.button().onClick();
    if (unmount) client.unmount();
    else client.expire();
    await pending;
    assert.equal(signal.aborted, true);
    if (unmount) assert.ok(!client.text().includes("could not verify"));
    else assert.ok(client.text().includes("could not verify"));
  }
});
