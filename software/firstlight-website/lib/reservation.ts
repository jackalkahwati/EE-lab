import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Server code only. Avoid a `server-only` package import so the same handlers can
// be exercised by Node's built-in test runner without a Next.js compilation.
if (typeof window !== "undefined") throw new Error("Reservation helpers are server-only.");

export type ReservationStatus =
  | "confirmed"
  | "test-confirmed"
  | "pending"
  | "unverified"
  | "unavailable";

const COOKIE_NAME = "fl1_reservation";
const BINDING_SECONDS = 48 * 60 * 60;
const MAX_AMOUNT_CENTS = 99_999_999;
const STRIPE_TIMEOUT_MS = 10_000;
const UNAVAILABLE =
  "Checkout is unavailable or its result could not be confirmed. If you already paid, do not pay again. Email jack@thestardrive.com for help.";

export function getReservationPrice(): {
  amountCents: number;
  currency: "usd";
  formatted: string;
} {
  const configured = process.env.STRIPE_RESERVATION_AMOUNT_CENTS;
  const raw = configured === undefined ? "250000" : configured.trim();
  if (!/^[0-9]+$/.test(raw)) throw new Error("Invalid reservation amount configuration.");
  const amountCents = Number(raw);
  // Stripe supports at most eight digits for a USD amount. Never round or accept
  // exponent notation, a negative value, or an empty configured value.
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) {
    throw new Error("Invalid reservation amount configuration.");
  }
  return {
    amountCents,
    currency: "usd",
    formatted: new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: amountCents % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amountCents / 100),
  };
}

function json(body: object, status = 200, cookie?: string) {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

function getPublicOrigin(req: Request) {
  const configuredOrigin = process.env.APP_URL?.trim();
  if (!configuredOrigin && process.env.NODE_ENV === "production") return null;
  try {
    const url = new URL(configuredOrigin || req.url);
    const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (
      !(url.protocol === "https:" || (url.protocol === "http:" && isLoopback)) ||
      url.username || url.password
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isAllowedCheckoutUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const customHost = process.env.STRIPE_CHECKOUT_HOST?.trim().toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.port && (url.hostname === "checkout.stripe.com" || url.hostname === customHost);
  } catch {
    return false;
  }
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && /^cs_(?:test_|live_)?[A-Za-z0-9]{8,240}$/.test(value);
}

interface Binding {
  sessionId: string;
  nonce: string;
  amountCents: number;
  currency: "usd";
  expires: number;
}

function signature(payload: string, key: string) {
  return createHmac("sha256", key).update(`fl1-reservation:v1:${payload}`).digest();
}

function bindingCookie(binding: Binding, key: string) {
  const payload = Buffer.from(JSON.stringify(binding)).toString("base64url");
  const token = `${payload}.${signature(payload, key).toString("base64url")}`;
  return `${COOKIE_NAME}=${token}; Path=/api/reserve; Max-Age=${BINDING_SECONDS}; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

function readBinding(req: Request, sessionId: string, key: string): Binding | null {
  const cookies = (req.headers.get("cookie") || "").split(";")
    .map((part) => part.trim()).filter((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (cookies.length !== 1) return null;
  const token = cookies[0].slice(COOKIE_NAME.length + 1);
  if (token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
  const expected = signature(parts[0], key);
  const supplied = Buffer.from(parts[1], "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const binding = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (
      !binding || binding.sessionId !== sessionId ||
      typeof binding.nonce !== "string" || !/^[a-f0-9]{64}$/.test(binding.nonce) ||
      !Number.isSafeInteger(binding.amountCents) || binding.amountCents <= 0 ||
      binding.amountCents > MAX_AMOUNT_CENTS || binding.currency !== "usd" ||
      !Number.isSafeInteger(binding.expires) || binding.expires <= Date.now()
    ) return null;
    return binding;
  } catch {
    return null;
  }
}

export async function createReservation(req: Request): Promise<Response> {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  const origin = getPublicOrigin(req);
  if (!key || !origin) return json({ error: UNAVAILABLE }, 503);
  let price: ReturnType<typeof getReservationPrice>;
  try {
    price = getReservationPrice();
  } catch {
    return json({ error: UNAVAILABLE }, 503);
  }
  const requestOrigin = req.headers.get("origin");
  if (requestOrigin) {
    try {
      if (new URL(requestOrigin).origin !== origin) {
        return json({ error: "Cross-origin reservation requests are not allowed." }, 403);
      }
    } catch {
      return json({ error: "Invalid request origin." }, 400);
    }
  }

  const nonce = randomBytes(32).toString("hex");
  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][price_data][currency]": price.currency,
    "line_items[0][price_data][unit_amount]": String(price.amountCents),
    "line_items[0][price_data][product_data][name]":
      "FirstLight FL-1 reservation deposit (refundable)",
    "line_items[0][quantity]": "1",
    billing_address_collection: "required",
    "metadata[type]": "fl1_reservation",
    "metadata[reservation_nonce]": nonce,
    cancel_url: `${origin}/fl1?reservation_cancelled=1#reserve`,
    success_url: `${origin}/fl1?session_id={CHECKOUT_SESSION_ID}#reserve`,
  });
  try {
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
    });
    const data = await response.json();
    if (!response.ok || !isAllowedCheckoutUrl(data?.url) || !isSessionId(data?.id)) {
      return json({ error: UNAVAILABLE }, 502);
    }
    return json({ url: data.url }, 200, bindingCookie({
      sessionId: data.id,
      nonce,
      amountCents: price.amountCents,
      currency: price.currency,
      expires: Date.now() + BINDING_SECONDS * 1000,
    }, key));
  } catch {
    // Do not log Stripe responses/errors: they can contain customer details.
    return json({ error: UNAVAILABLE }, 502);
  }
}

export async function getReservationStatus(req: Request): Promise<Response> {
  const result = (status: ReservationStatus) => json({ status }, status === "unavailable" ? 503 : 200);
  const params = new URL(req.url).searchParams;
  const sessionId = params.get("session_id");
  if (!isSessionId(sessionId) || params.getAll("session_id").length !== 1) return result("unverified");
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return result("unavailable");
  const binding = readBinding(req, sessionId, key);
  // A guessed session ID or copied success URL must never trigger a Stripe read.
  if (!binding) return result("unverified");

  try {
    const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
    });
    if (!response.ok) return result(response.status === 404 ? "unverified" : "unavailable");
    const data = await response.json();
    if (
      !data || data.id !== sessionId || data.mode !== "payment" ||
      data.metadata?.type !== "fl1_reservation" ||
      data.metadata?.reservation_nonce !== binding.nonce ||
      data.amount_total !== binding.amountCents || data.currency !== binding.currency ||
      typeof data.livemode !== "boolean"
    ) return result("unverified");
    if (data.status === "complete" && data.payment_status === "paid") {
      return result(data.livemode ? "confirmed" : "test-confirmed");
    }
    if (
      (data.status === "open" || data.status === "complete") &&
      data.payment_status === "unpaid"
    ) return result("pending");
    return result("unverified");
  } catch {
    return result("unavailable");
  }
}
