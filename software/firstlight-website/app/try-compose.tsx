"use client";

const COMPOSE_URL =
  process.env.NEXT_PUBLIC_COMPOSE_URL || "http://localhost:4500";

export function TryCompose() {
  return (
    <form
      className="try-compose"
      action={COMPOSE_URL}
      method="get"
      aria-label="Start a PCB design"
      onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem(
          "prompt",
        ) as HTMLInputElement;
        const destination = new URL(COMPOSE_URL, window.location.origin);
        const prompt = input.value.trim();

        if (prompt) destination.searchParams.set("prompt", prompt);
        window.location.assign(destination);
      }}
    >
      <label className="sr-only" htmlFor="board-description">
        Describe the board you want to design
      </label>
      <input
        id="board-description"
        name="prompt"
        type="text"
        placeholder="Describe your board… e.g. solar-powered soil sensor with LoRa"
        autoComplete="off"
      />
      <button type="submit" className="btn">
        Start the design interview &rarr;
      </button>
    </form>
  );
}
