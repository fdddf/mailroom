// Sending and receiving email. Mail goes out through Cloudflare Email Sending
// (the EMAIL binding) from an address on one of our domains, and comes in
// through the Worker's email() handler, which files it with storeInbound.

import type { EmailAttachment } from '@cloudflare/workers-types'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db'
import { domain, mail, mailbox, type Attachment } from '../db/schema'
import type { Env } from '../env'
import { bareAddress, domainOf } from './text'

export const emailConfigured = (env: Env) => Boolean(env.EMAIL)

// R2 takes at most this many keys in one delete.
const R2_DELETE_LIMIT = 1000

// Remove the attachments of received mail from R2. The email is already gone
// by now, so a failure here leaves orphaned objects, not an error to show.
// Only mail/… keys: what sent mail lists is the file library's, and stays.
export async function deleteAttachments(env: Pick<Env, 'BUCKET'>, allKeys: string[]) {
  const keys = allKeys.filter((k) => k.startsWith('mail/'))
  if (!env.BUCKET || !keys.length) return
  try {
    for (let i = 0; i < keys.length; i += R2_DELETE_LIMIT) await env.BUCKET.delete(keys.slice(i, i + R2_DELETE_LIMIT))
  } catch (err) {
    console.error('attachment cleanup failed', err)
  }
}

// "Name <a@b.c>" or "a@b.c" -> its parts.
export const parseSender = (from: string) => ({
  email: bareAddress(from),
  name: from.includes('<') ? from.slice(0, from.indexOf('<')).trim().replace(/^"|"$/g, '') : '',
})
export const formatSender = ({ email, name }: { email: string; name?: string }) => (name ? `${name} <${email}>` : email)

export type Sender = { email: string; name: string; domainId: number }

// Who an email goes out as. With an address: that mailbox, or — when
// `anyAddress` (the API) — any address on one of our domains. Without one: the
// default mailbox of `domainId`. `domainId`, when given, must be the
// sender's domain. null when none of that works.
export const resolveSender = async (
  db: Db,
  { address, domainId, anyAddress = false }: { address?: string | null; domainId?: number | null; anyAddress?: boolean },
): Promise<Sender | null> => {
  if (address) {
    const parsed = parseSender(address)
    const box = await db.query.mailbox.findFirst({ where: eq(mailbox.address, parsed.email) })
    if (box) return domainId && box.domainId !== domainId ? null : { email: box.address, name: parsed.name || box.name, domainId: box.domainId }
    if (!anyAddress) return null
    const own = await db.query.domain.findFirst({ columns: { id: true }, where: eq(domain.name, domainOf(parsed.email)) })
    if (!own || (domainId && own.id !== domainId)) return null
    return { email: parsed.email, name: parsed.name, domainId: own.id }
  }
  if (!domainId) return null
  const box = await db.query.mailbox.findFirst({ where: eq(mailbox.domainId, domainId), orderBy: [desc(mailbox.isDefault), asc(mailbox.id)] })
  return box ? { email: box.address, name: box.name, domainId } : null
}

// ---- Sending ----------------------------------------------------------------

export type SendRequest = {
  from: { email: string; name?: string }
  to: string[]
  cc?: string[]
  bcc?: string[]
  replyTo?: string
  subject: string
  text?: string
  html?: string
  headers?: Record<string, string>
  attachments?: EmailAttachment[]
}
export type SendResponse = { ok: true; messageId: string } | { ok: false; code: string; message: string }

// One email through the send_email binding. Never throws.
export const deliver = async (env: Env, m: SendRequest): Promise<SendResponse> => {
  if (!env.EMAIL) return { ok: false, code: 'email_not_configured', message: 'No send_email binding named EMAIL' }
  try {
    const result = await env.EMAIL.send({
      from: m.from.name ? { email: m.from.email, name: m.from.name } : m.from.email,
      to: m.to,
      ...(m.cc?.length && { cc: m.cc }),
      ...(m.bcc?.length && { bcc: m.bcc }),
      ...(m.replyTo && { replyTo: m.replyTo }),
      subject: m.subject,
      ...(m.text && { text: m.text }),
      ...(m.html && { html: m.html }),
      ...(m.headers && { headers: m.headers }),
      ...(m.attachments?.length && { attachments: m.attachments }),
    })
    return { ok: true, messageId: result.messageId }
  } catch (err) {
    // The binding throws an Error with a `code` such as E_SENDER_NOT_VERIFIED.
    const e = err as { code?: string; message?: string }
    return { ok: false, code: e.code || 'send_failed', message: e.message || String(err) }
  }
}

export type Outgoing = {
  // A mailbox address, or (with `anyAddress`) any address on our domains;
  // the domain's default mailbox when omitted.
  from?: string | null
  domainId?: number | null
  anyAddress?: boolean
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  text?: string
  html?: string
  replyTo?: string
  headers?: Record<string, string>
  // Files from the library: attached when `content` is there, else already
  // linked in the body. All are listed on the recorded email.
  files?: (Attachment & { content?: ArrayBuffer })[]
  // Who sent it: 'dashboard' or 'api:<key name>'.
  source: string
  // false for tests that do not belong in the Sent list.
  record?: boolean
}

export type SendResult =
  | { ok: true; mailId: number | null; messageId: string }
  | { ok: false; status: 400 | 424 | 503; error: string; message?: string }

// Send one email and record it in the mail table.
export const sendMail = async (env: Env, db: Db, m: Outgoing): Promise<SendResult> => {
  if (!emailConfigured(env)) return { ok: false, status: 503, error: 'email_not_configured' }
  const from = await resolveSender(db, { address: m.from, domainId: m.domainId, anyAddress: m.anyAddress })
  if (!from) return { ok: false, status: 400, error: m.from ? 'unknown_sender' : 'no_mailbox' }
  const cc = m.cc ?? []

  const files = m.files ?? []
  const attachments = files.flatMap((f): EmailAttachment[] =>
    f.content ? [{ disposition: 'attachment', filename: f.filename || 'file', type: f.content_type, content: f.content }] : [],
  )
  const result = await deliver(env, { from, to: m.to, cc, bcc: m.bcc, replyTo: m.replyTo, subject: m.subject, text: m.text, html: m.html, headers: m.headers, attachments })
  if (!result.ok) return { ok: false, status: 424, error: 'send_failed', message: `${result.code}: ${result.message}` }

  let mailId: number | null = null
  if (m.record !== false) {
    const [row] = await db
      .insert(mail)
      .values({
        domainId: from.domainId,
        direction: 'out',
        key: result.messageId,
        // Lets a reply's In-Reply-To find its way back to this email.
        messageId: result.messageId,
        mailbox: from.email,
        source: m.source,
        fromAddr: formatSender(from),
        toAddrs: m.to,
        ccAddrs: cc,
        replyTo: m.replyTo ?? '',
        subject: m.subject,
        text: m.text ?? null,
        html: m.html ?? null,
        attachments: files.map(({ content: _, ...meta }) => meta),
        status: 'sent',
      })
      .onConflictDoNothing({ target: mail.key })
      .returning({ id: mail.id })
    mailId = row?.id ?? null
  }
  return { ok: true, mailId, messageId: result.messageId }
}

// ---- Receiving --------------------------------------------------------------

export type Inbound = {
  // Unique per delivery; a second delivery of the same email is ignored.
  key: string
  domainId: number
  // Envelope recipient: which of our addresses it arrived at.
  mailbox: string
  from: string
  to: string[]
  cc: string[]
  replyTo: string
  subject: string
  text: string | null
  html: string | null
  messageId: string
  date: string | null
  attachments: Attachment[]
}

// D1 caps a row at 2 MB.
const MAX_HTML = 900_000
const MAX_TEXT = 400_000

export type StoreResult = { id: number; created: boolean; createdAt: string }

// File one received email in the mail table (idempotent on `key`).
export const storeInbound = async (db: Db, email: Inbound): Promise<StoreResult> => {
  const existing = await db.query.mail.findFirst({ columns: { id: true, createdAt: true }, where: eq(mail.key, email.key) })
  if (existing) return { ...existing, created: false }

  const received = email.date ? new Date(email.date) : new Date()
  // A missing or nonsense Date header must not reorder the inbox.
  const createdAt = (Number.isNaN(received.getTime()) || received.getTime() > Date.now() ? new Date() : received).toISOString()
  const [row] = await db
    .insert(mail)
    .values({
      domainId: email.domainId,
      direction: 'in',
      key: email.key,
      mailbox: bareAddress(email.mailbox),
      createdAt,
      fromAddr: email.from,
      toAddrs: email.to,
      ccAddrs: email.cc,
      replyTo: email.replyTo,
      subject: email.subject,
      text: email.text ? email.text.slice(0, MAX_TEXT) : null,
      html: email.html ? email.html.slice(0, MAX_HTML) : null,
      messageId: email.messageId,
      attachments: email.attachments,
    })
    .onConflictDoNothing({ target: mail.key })
    .returning({ id: mail.id })

  if (!row) {
    // Lost a race with another delivery of the same email.
    const again = await db.query.mail.findFirst({ columns: { id: true, createdAt: true }, where: eq(mail.key, email.key) })
    if (!again) throw new Error('mail insert failed')
    return { ...again, created: false }
  }
  return { id: row.id, created: true, createdAt }
}

// Delivery events never overwrite a worse or more final one.
const RANK: Record<string, number> = { sent: 1, delivery_delayed: 2, delivered: 3, opened: 4, clicked: 5, failed: 6, suppressed: 6, bounced: 7, complained: 8 }

// Record a delivery event against the email it is about: by Email Sending's
// message id, else (ids do not always survive the trip) by sender, recipient
// and subject among recent mail. Returns that email if one was found.
export const recordDeliveryStatus = async (
  db: Db,
  providerId: string,
  status: string,
  hint?: { sender?: string; recipient?: string; subject?: string },
) => {
  const columns = { id: true, domainId: true, status: true, messageId: true, mailbox: true, toAddrs: true, subject: true } as const
  let row = await db.query.mail.findFirst({ columns, where: eq(mail.key, providerId) })
  if (!row && hint?.sender && hint.recipient) {
    row = await db.query.mail.findFirst({
      columns,
      where: and(
        eq(mail.direction, 'out'),
        eq(mail.mailbox, bareAddress(hint.sender)),
        hint.subject === undefined ? undefined : eq(mail.subject, hint.subject),
        sql`${mail.createdAt} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days')`,
        sql`EXISTS (SELECT 1 FROM json_each(${mail.toAddrs} || '') WHERE lower(value) LIKE ${`%${bareAddress(hint.recipient)}%`})`,
      ),
      orderBy: desc(mail.id),
    })
  }
  if (!row) return null
  if ((RANK[status] ?? 0) >= (RANK[row.status] ?? 0)) await db.update(mail).set({ status }).where(eq(mail.id, row.id))
  return row
}
