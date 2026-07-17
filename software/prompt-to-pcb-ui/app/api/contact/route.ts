/**
 * Contact / "Talk to us" form handler — captures Studio & Enterprise leads.
 *
 * Three jobs: (1) persist every lead so none are lost (data/contacts.json, on
 * the persistent data volume); (2) notify the team instantly; (3) auto-reply to
 * the lead with a booking link so they self-schedule. Notify + auto-reply use
 * Resend (dependency-free REST) when configured, and no-op gracefully otherwise
 * so the form always succeeds and the lead is always stored.
 *
 * Env (all optional — the form works store-only without them):
 *   RESEND_API_KEY        re_...  — enables the notify + auto-reply emails
 *   CONTACT_NOTIFY_EMAIL  where new leads are sent (default: FL_ADMIN_EMAILS[0])
 *   CONTACT_FROM_EMAIL    verified Resend sender (default: hello@firstlight.build)
 *   CAL_BOOKING_URL       Cal.com/Calendly link included in the auto-reply
 */
import fs from 'node:fs'
import path from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import { adminEmails } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const STORE = path.join(process.cwd(), 'data', 'contacts.json')

function store(lead: Record<string, unknown>) {
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true })
    let all: unknown[] = []
    try {
      all = JSON.parse(fs.readFileSync(STORE, 'utf8'))
      if (!Array.isArray(all)) all = []
    } catch { /* new file */ }
    all.push(lead)
    const tmp = STORE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(all, null, 1))
    fs.renameSync(tmp, STORE)
  } catch (e) {
    // Never fail the request on a storage hiccup — the email is the durable copy.
    console.error('[contact] store failed', e)
  }
}

/** Free lead notification via Telegram — no transactional-email service needed.
 *  Needs TELEGRAM_BOT_TOKEN (create with @BotFather) + TELEGRAM_CHAT_ID. */
async function notifyTelegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chat = process.env.TELEGRAM_CHAT_ID
  if (!token || !chat) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text }),
    })
  } catch (e) {
    console.error('[contact] telegram failed', e)
  }
}

async function sendEmail(to: string, subject: string, text: string, replyTo?: string) {
  const key = process.env.RESEND_API_KEY
  if (!key) return false
  const from = process.env.CONTACT_FROM_EMAIL || 'FirstLight <hello@firstlight.build>'
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
    })
    if (!r.ok) console.error('[contact] resend error', r.status, await r.text())
    return r.ok
  } catch (e) {
    console.error('[contact] resend threw', e)
    return false
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, string>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }

  const email = String(body.email ?? '').trim()
  const name = String(body.name ?? '').trim().slice(0, 200)
  const company = String(body.company ?? '').trim().slice(0, 200)
  const plan = String(body.plan ?? '').trim().slice(0, 40)
  const message = String(body.message ?? '').trim().slice(0, 4000)
  // Basic honeypot + email sanity (no heavy validation — leads over friction).
  if (body.website) return NextResponse.json({ ok: true }) // bot filled hidden field
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'a valid email is required' }, { status: 400 })
  }

  const lead = { name, email, company, plan, message, at: new Date().toISOString() }
  store(lead)

  // Notify the team — Telegram (free) and/or email (Resend), whichever is set.
  const summary = `New FirstLight ${plan || 'contact'} lead\nName: ${name}\nEmail: ${email}\nCompany: ${company}\n\n${message}`
  await notifyTelegram(summary)
  const notifyTo = process.env.CONTACT_NOTIFY_EMAIL || adminEmails()[0]
  if (notifyTo) {
    await sendEmail(
      notifyTo,
      `FirstLight ${plan || 'contact'} lead — ${name || email}`,
      `New ${plan || 'contact'} inquiry:\n\nName: ${name}\nEmail: ${email}\nCompany: ${company}\nPlan: ${plan}\n\n${message}\n`,
      email,
    )
  }

  // Auto-reply with a booking link (self-scheduling beats a fixed calendar invite).
  const booking = process.env.CAL_BOOKING_URL
  const bookingLine = booking
    ? `\nGrab a time that works for you here: ${booking}\n`
    : ''
  await sendEmail(
    email,
    'Thanks for reaching out to FirstLight',
    `Hi ${name || 'there'},\n\nThanks for your interest in FirstLight ${plan || ''}. `
      + `We got your note and will be in touch shortly.\n${bookingLine}\n— The FirstLight team`,
  )

  // Return the booking link so the success screen can offer it immediately —
  // works even before transactional email is configured.
  return NextResponse.json({ ok: true, booking: booking || null })
}
