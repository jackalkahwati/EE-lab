"use client";

import { COMPOSE_URL } from "../lib/public-config";

export function TryCompose() {
  const startUrl = new URL("/start", COMPOSE_URL).toString();
  return (
    <form
      className="try-compose"
      action={startUrl}
      method="get"
      aria-label="Start a PCB design"
      onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.querySelector<HTMLInputElement>(
          "#board-description",
        );
        const destination = new URL(startUrl);
        const prompt = input?.value.trim();
        if (prompt) destination.hash = new URLSearchParams({ prompt }).toString();
        window.location.assign(destination);
      }}
    >
      <label className="sr-only" htmlFor="board-description">
        Describe the board you want to design
      </label>
      <input
        id="board-description"
        type="text"
        maxLength={4000}
        placeholder="Describe your board… e.g. solar-powered soil sensor with LoRa"
        autoComplete="off"
      />
      <button type="submit" className="btn">
        Start the design interview &rarr;
      </button>
      <noscript>
        <p>Your description will not be submitted without JavaScript. Copy it before continuing, then paste it into Compose after signing in.</p>
      </noscript>
    </form>
  );
}
