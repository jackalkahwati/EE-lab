/**
 * FL-1 reservation checkout. Creates a Stripe Checkout session for the
 * refundable reservation deposit (STRIPE_RESERVATION_PRICE). No account
 * needed; Stripe collects the email, which becomes the reservation lead.
 * Without keys it answers with a clear message instead of a dead button.
 */
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const key = process.env.STRIPE_SECRET_KEY;
  const price = process.env.STRIPE_RESERVATION_PRICE;
  if (!key || !price) {
    return NextResponse.json(
      {
        error:
          "Reservations open shortly. Email jack@thestardrive.com to hold a place in line.",
      },
      { status: 503 },
    );
  }

  const origin = process.env.APP_URL || req.nextUrl.origin;
  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    billing_address_collection: "required",
    "metadata[type]": "fl1_reservation",
    cancel_url: `${origin}/fl1`,
  });
  const body =
    form.toString() +
    `&success_url=${encodeURIComponent(`${origin}/fl1?reserved=1`)}`;

  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const d = await r.json();
  if (!r.ok || !d.url) {
    return NextResponse.json(
      { error: `Could not open checkout: ${d.error?.message ?? r.status}` },
      { status: 502 },
    );
  }
  return NextResponse.json({ url: d.url });
}
