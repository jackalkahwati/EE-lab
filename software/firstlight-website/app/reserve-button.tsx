"use client";

import { useEffect, useRef, useState } from "react";

const VERIFICATION_HELP =
  "We could not verify this payment. If you already paid, do not pay again. Email jack@thestardrive.com for help.";
const STATUS_MESSAGES: Record<string, string> = {
  confirmed: "Your reservation deposit is confirmed. We will follow up at the email address you provided to Stripe.",
  "test-confirmed": "Test checkout confirmed. No real deposit was collected and no reservation was made.",
  pending: "Payment is not yet confirmed. Do not pay again while it is pending. Check the status again or email jack@thestardrive.com for help.",
  unverified: VERIFICATION_HELP,
  unavailable: "Payment verification is temporarily unavailable. If you already paid, do not pay again. Check the status again or email jack@thestardrive.com for help.",
};

type CheckoutReturn = { sessionId: string | null; returned: boolean; cancelled: boolean };
const RETURN_STORAGE_KEY = "fl1-checkout-return-v1";

export function ReserveButton({
  label = "Reserve an FL-1",
  className = "btn btn-large",
}: {
  label?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(true);
  const [msg, setMsg] = useState("");
  const [returned, setReturned] = useState(false);
  const [canRecheck, setCanRecheck] = useState(false);
  const [checkAttempt, setCheckAttempt] = useState(0);
  const checkoutReturn = useRef<CheckoutReturn | null>(null);
  const creationRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    // Remember only a lookup hint, never a trusted receipt. Every mount still
    // verifies against the server's signed browser binding. Persist before URL
    // cleanup so refresh cannot turn a pending payment into a new checkout.
    if (!checkoutReturn.current) {
      const url = new URL(window.location.href);
      const ids = url.searchParams.getAll("session_id");
      const info: CheckoutReturn = {
        sessionId: ids.length === 1 ? ids[0] : null,
        returned: ids.length > 0 || url.searchParams.has("reserved"),
        cancelled: url.searchParams.has("reservation_cancelled"),
      };
      let canScrub = !info.returned;
      try {
        if (info.returned) {
          const saved = JSON.stringify({ sessionId: info.sessionId });
          window.sessionStorage.setItem(RETURN_STORAGE_KEY, saved);
          canScrub = window.sessionStorage.getItem(RETURN_STORAGE_KEY) === saved;
        } else {
          const saved = window.sessionStorage.getItem(RETURN_STORAGE_KEY);
          if (saved !== null) {
            // Even corrupted storage means an earlier checkout may have
            // happened. Fail closed rather than offering a duplicate charge.
            info.returned = true;
            const parsed = JSON.parse(saved);
            info.sessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId : null;
          }
        }
      } catch {
        // On a checkout return, keep its URL when storage is blocked or full.
        // If reading ordinary-page storage fails, we cannot rule out payment.
        if (!info.returned) info.returned = true;
      }
      checkoutReturn.current = info;
      if (canScrub && (url.searchParams.has("session_id") || url.searchParams.has("reserved") || info.cancelled)) {
        url.searchParams.delete("session_id");
        url.searchParams.delete("reserved");
        url.searchParams.delete("reservation_cancelled");
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
    }
    const info = checkoutReturn.current;
    setReturned(info.returned);
    if (!info.returned) {
      if (info.cancelled) setMsg("Checkout was cancelled. No payment has been verified.");
      setBusy(false);
      return;
    }
    if (!info.sessionId) {
      setMsg(VERIFICATION_HELP);
      setBusy(false);
      return;
    }

    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 12_000);
    setBusy(true);
    setCanRecheck(false);
    setMsg("Checking your payment status...");
    async function verify() {
      try {
        const response = await fetch(`/api/reserve/status?session_id=${encodeURIComponent(info.sessionId!)}`, {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        const data = await response.json();
        if (!active) return;
        const status = response.ok && typeof data?.status === "string" && Object.hasOwn(STATUS_MESSAGES, data.status)
          ? data.status : "unavailable";
        setMsg(STATUS_MESSAGES[status]);
        setCanRecheck(status === "pending" || status === "unavailable");
      } catch {
        if (!active) return;
        setMsg(STATUS_MESSAGES.unavailable);
        setCanRecheck(true);
      } finally {
        window.clearTimeout(timer);
        if (active) setBusy(false);
      }
    }
    void verify();
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [checkAttempt]);

  useEffect(() => () => {
    creationRequest.current?.abort();
    creationRequest.current = null;
  }, []);

  async function reserve() {
    if (creationRequest.current || returned || !checkoutReturn.current || checkoutReturn.current.returned) return;
    const controller = new AbortController();
    creationRequest.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 12_000);
    setBusy(true);
    setMsg("");
    try {
      const response = await fetch("/api/reserve", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      const data = (await response.json().catch(() => null)) as { error?: string; url?: string } | null;
      if (creationRequest.current !== controller) return;
      if (response.ok && data?.url) window.location.assign(data.url);
      else setMsg(data?.error ?? VERIFICATION_HELP);
    } catch {
      if (creationRequest.current === controller) setMsg(VERIFICATION_HELP);
    } finally {
      window.clearTimeout(timer);
      if (creationRequest.current === controller) {
        creationRequest.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <span className="reserve-wrap">
      <button
        type="button"
        className={className}
        onClick={returned ? () => setCheckAttempt((attempt) => attempt + 1) : reserve}
        disabled={busy || (returned && !canRecheck)}
        aria-busy={busy}
      >
        {returned
          ? busy ? "Checking payment..." : canRecheck ? "Check payment status" : "Payment status"
          : busy ? "Opening checkout..." : label}
      </button>
      {msg && (
        <span className="reserve-msg" role="status" aria-live="polite">
          {msg}
        </span>
      )}
    </span>
  );
}
