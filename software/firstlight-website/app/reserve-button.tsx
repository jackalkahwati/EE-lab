"use client";

import { useEffect, useState } from "react";

export function ReserveButton({
  label = "Reserve an FL-1",
  className = "btn btn-large",
}: {
  label?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [checkoutCompleted, setCheckoutCompleted] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setCheckoutCompleted(params.get("reserved") === "1");
  }, []);

  async function reserve() {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/reserve", { method: "POST" });
      const d = (await r.json().catch(() => null)) as {
        error?: string;
        url?: string;
      } | null;
      if (r.ok && d?.url) window.location.assign(d.url);
      else setMsg(d?.error ?? "Something went wrong.");
    } catch {
      setMsg("Something went wrong. Email jack@thestardrive.com to reserve.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="reserve-wrap">
      <button
        type="button"
        className={className}
        onClick={reserve}
        disabled={busy}
        aria-busy={busy}
      >
        {busy ? "Opening checkout..." : label}
      </button>
      {msg && (
        <span className="reserve-msg" role="alert">
          {msg}
        </span>
      )}
      {checkoutCompleted && (
        <span className="reserve-success" role="status">
          Checkout complete. Thank you for reserving an FL-1—we&apos;ll follow up
          at the email address you provided to Stripe.
        </span>
      )}
    </span>
  );
}
