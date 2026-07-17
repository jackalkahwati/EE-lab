/**
 * FL-1 reservation checkout. Creates a Stripe Checkout session for the
 * refundable reservation deposit (STRIPE_RESERVATION_PRICE). No account
 * needed; Stripe collects the email, which becomes the reservation lead.
 * Without keys it answers with a clear message instead of a dead button.
 */
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const RESERVATION_UNAVAILABLE =
  "Reservations are temporarily unavailable. Email jack@thestardrive.com to hold a place in line.";

function json(body: { error: string } | { url: string }, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function getPublicOrigin(req: NextRequest) {
  const configuredOrigin = process.env.APP_URL?.trim();

  // Never construct payment redirects from an untrusted Host in production.
  if (!configuredOrigin && process.env.NODE_ENV === "production") return null;

  try {
    const url = new URL(configuredOrigin || req.nextUrl.origin);
    const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const isAllowedProtocol =
      url.protocol === "https:" || (url.protocol === "http:" && isLoopback);

    if (!isAllowedProtocol || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isAllowedCheckoutUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;

  try {
    const checkoutUrl = new URL(value);
    const customHost = process.env.STRIPE_CHECKOUT_HOST?.trim().toLowerCase();
    const allowedHosts = new Set(["checkout.stripe.com"]);
    if (customHost) allowedHosts.add(customHost);

    return checkoutUrl.protocol === "https:" && allowedHosts.has(checkoutUrl.hostname);
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return json({ error: RESERVATION_UNAVAILABLE }, 503);
  }
  // $2,500 refundable deposit, priced inline so no pre-created Stripe Price is
  // needed. Override the amount with STRIPE_RESERVATION_AMOUNT_CENTS.
  const amountCents = process.env.STRIPE_RESERVATION_AMOUNT_CENTS?.trim() || "250000";

  const origin = getPublicOrigin(req);
  if (!origin) {
    console.error("FL-1 reservations require a valid APP_URL in production.");
    return json({ error: RESERVATION_UNAVAILABLE }, 503);
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

  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": amountCents,
    "line_items[0][price_data][product_data][name]":
      "FirstLight FL-1 reservation deposit (refundable)",
    "line_items[0][quantity]": "1",
    billing_address_collection: "required",
    "metadata[type]": "fl1_reservation",
    cancel_url: `${origin}/fl1`,
    success_url: `${origin}/fl1?reserved=1#reserve`,
  });

  let response: Response;
  try {
    response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error("Stripe Checkout request failed.", error);
    return json({ error: RESERVATION_UNAVAILABLE }, 502);
  }

  const data = (await response.json().catch(() => null)) as {
    error?: { code?: string };
    url?: unknown;
  } | null;

  const checkoutUrl = data?.url;
  if (!response.ok || !isAllowedCheckoutUrl(checkoutUrl)) {
    console.error("Stripe Checkout session creation failed.", {
      status: response.status,
      code: data?.error?.code,
    });
    return json({ error: RESERVATION_UNAVAILABLE }, 502);
  }

  return json({ url: checkoutUrl });
}
