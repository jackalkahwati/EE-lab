/**
 * Front door. The board-program portfolio (Programs, at /enterprise) is the
 * primary surface — Compose is a hardware-program platform, not a single-run
 * PCB generator. The design workspace lives at /compose.
 */
import { redirect } from 'next/navigation'

export default function Home() {
  redirect('/enterprise')
}
