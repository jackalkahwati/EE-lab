'use client'

const COMPOSE_URL =
  process.env.NEXT_PUBLIC_COMPOSE_URL || 'http://localhost:4500'

export function TryCompose() {
  return (
    <form
      className="try-compose"
      onSubmit={(e) => {
        e.preventDefault()
        const input = e.currentTarget.elements.namedItem('board') as HTMLInputElement
        const prompt = input.value.trim()
        window.location.href = prompt
          ? `${COMPOSE_URL}/?prompt=${encodeURIComponent(prompt)}`
          : COMPOSE_URL
      }}
    >
      <input
        name="board"
        type="text"
        placeholder="Describe your board… e.g. solar-powered soil sensor with LoRa"
        aria-label="Describe your board"
      />
      <button type="submit" className="btn">
        Start the design interview &rarr;
      </button>
    </form>
  )
}
