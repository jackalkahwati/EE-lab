"use client";

import { useState } from "react";

export function ReserveButton({
  label = "Reserve an FL-1",
  className = "btn btn-large",
}: {
  label?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function reserve() {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/reserve", { method: "POST" });
      const d = await r.json();
      if (d.url) window.location.href = d.url;
      else setMsg(d.error ?? "Something went wrong.");
    } catch {
      setMsg("Something went wrong. Email jack@thestardrive.com to reserve.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="reserve-wrap">
      <button type="button" className={className} onClick={reserve} disabled={busy}>
        {busy ? "Opening checkout..." : label}
      </button>
      {msg && <span className="reserve-msg">{msg}</span>}
    </span>
  );
}
