// Broadcasts: one email per subscriber of a segment, each with its own
// unsubscribe link. The dashboard only queues them; the Worker's cron sends
// them a batch at a time (processBroadcasts), so a large list, the daily
// sending quota or a crash never loses or repeats an email.

import { and, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import type { Db } from '../db'
import { broadcast, broadcastRecipient, contact, domain, type BodyFormat, type Domain } from '../db/schema'
import { resolveSender, type SendRequest, type SendResponse } from './mailer'
import { fillVariables, htmlToText, textToHtml } from './text'

export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

const OWN_UNSUBSCRIBE = /\{\{\s*unsubscribe_url\s*\}\}/i

// The line before the unsubscribe link: the domain's own, else one made from its brand.
export const footerText = (d: Pick<Domain, 'footer' | 'brand' | 'name'>) => d.footer || `You are receiving this because you subscribed to ${d.brand || d.name} updates.`

export type Recipient = { email: string; firstName?: string; lastName?: string }

// One subscriber's copy of a broadcast: {{first_name}}, {{last_name}},
// {{email}} and {{unsubscribe_url}} filled in, and the unsubscribe footer
// added unless the message places the link itself. The message is plain text
// (HTML is made from it) or HTML (the text part is made from it).
export const broadcastBodies = (
  b: { message: string; format: BodyFormat; subject: string; previewText?: string },
  footer: string,
  unsubscribeUrl: string,
  to: Recipient = { email: 'you@example.com' },
) => {
  const footerEscaped = escapeHtml(footer)
  const values = { first_name: to.firstName ?? '', last_name: to.lastName ?? '', email: to.email, unsubscribe_url: unsubscribeUrl }
  const ownLink = OWN_UNSUBSCRIBE.test(b.message)
  const subject = fillVariables(b.subject, values)
  // The line inboxes show after the subject.
  const preheader = b.previewText ? `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(fillVariables(b.previewText, values))}</div>\n` : ''
  const footerHtml = ownLink
    ? ''
    : `<p style="margin:32px 0 0;font-size:12px;color:#68685f">${footerEscaped} <a href="${escapeHtml(unsubscribeUrl)}" style="color:#68685f">Unsubscribe</a></p>`

  if (b.format === 'html') {
    const filled = fillVariables(b.message, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, escapeHtml(v)])))
    // Inside the document if it is a whole one, else simply after the fragment.
    const html = /<\/body>/i.test(filled) ? filled.replace(/<\/body>/i, `${footerHtml}</body>`).replace(/<body[^>]*>/i, (tag) => tag + preheader) : preheader + filled + footerHtml
    return { subject, html, text: htmlToText(filled) + (ownLink ? '' : `\n\n—\n${footer}\nUnsubscribe: ${unsubscribeUrl}`) }
  }
  const filled = fillVariables(b.message, values).trim()
  return {
    subject,
    text: filled + (ownLink ? '' : `\n\n—\n${footer}\nUnsubscribe: ${unsubscribeUrl}`),
    html: preheader + textToHtml(filled, footerHtml),
  }
}

export const unsubscribeUrl = (publicUrl: string, token: string) => `${publicUrl.replace(/\/$/, '')}/u/${token}`

export const newToken = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().slice(0, 8)

// Emails per run. The cron runs every minute, so this is also the pace
// (6,000 an hour); the account's daily quota is what really limits a large send.
const BATCH = 100
const CONCURRENCY = 5
// A claim older than this belongs to a run that died.
const STALE_CLAIM_MINUTES = 15
// The account is out of quota for now: stop and let a later run continue.
const BACK_OFF = new Set(['E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED'])

type Send = (m: SendRequest) => Promise<SendResponse>

// Fix a queued broadcast's recipients and start sending it.
const start = async (db: Db, id: number, segmentId: number) => {
  await db.run(sql`
    INSERT OR IGNORE INTO broadcast_recipient (broadcast_id, contact_id, email, token)
    SELECT ${id}, c.id, c.email, c.token
    FROM contact c JOIN contact_segment cs ON cs.contact_id = c.id
    WHERE cs.segment_id = ${segmentId} AND c.unsubscribed = 0`)
  const total = await db.$count(broadcastRecipient, eq(broadcastRecipient.broadcastId, id))
  // Only if it is still queued: it may have been canceled meanwhile.
  await db.update(broadcast).set({ status: 'sending', total }).where(and(eq(broadcast.id, id), eq(broadcast.status, 'queued')))
}

const sendBatch = async (db: Db, send: Send, publicUrl: string, b: typeof broadcast.$inferSelect, limit: number) => {
  // Claiming in one statement keeps overlapping runs off the same rows.
  const claimed = await db
    .update(broadcastRecipient)
    .set({ status: 'claimed', claimedAt: new Date().toISOString() })
    .where(
      inArray(
        broadcastRecipient.id,
        db
          .select({ id: broadcastRecipient.id })
          .from(broadcastRecipient)
          .where(and(eq(broadcastRecipient.broadcastId, b.id), eq(broadcastRecipient.status, 'pending')))
          .limit(limit),
      ),
    )
    .returning({ id: broadcastRecipient.id, contactId: broadcastRecipient.contactId, email: broadcastRecipient.email, token: broadcastRecipient.token })

  // Names, for the {{first_name}} and {{last_name}} placeholders.
  const names = new Map<number, { firstName: string; lastName: string }>()
  for (let i = 0; i < claimed.length; i += 50) {
    const rows = await db
      .select({ id: contact.id, firstName: contact.firstName, lastName: contact.lastName })
      .from(contact)
      .where(inArray(contact.id, claimed.slice(i, i + 50).map((r) => r.contactId)))
    for (const row of rows) names.set(row.id, row)
  }

  const own = (await db.query.domain.findFirst({ where: eq(domain.id, b.domainId) }))!
  // The mailbox it was written from may have gone since; the domain's default takes over.
  const from =
    (b.fromAddr && (await resolveSender(db, { address: b.fromAddr, domainId: b.domainId }))) || (await resolveSender(db, { domainId: b.domainId })) || { email: b.fromAddr, name: '' }
  const footer = footerText(own)

  let backOff = false
  const release = (id: number) => db.update(broadcastRecipient).set({ status: 'pending', claimedAt: null }).where(eq(broadcastRecipient.id, id))
  const queue = [...claimed]
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      if (backOff) {
        await release(r.id)
        continue
      }
      const url = unsubscribeUrl(publicUrl || b.publicUrl, r.token)
      const result = await send({
        from,
        to: [r.email],
        ...broadcastBodies(b, footer, url, { email: r.email, ...names.get(r.contactId) }),
        headers: { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      }).catch((err): SendResponse => ({ ok: false, code: 'send_failed', message: String(err) }))

      if (result.ok) {
        await db.update(broadcastRecipient).set({ status: 'sent' }).where(eq(broadcastRecipient.id, r.id))
      } else if (BACK_OFF.has(result.code)) {
        backOff = true
        await release(r.id)
      } else {
        await db.update(broadcastRecipient).set({ status: 'failed', error: `${result.code}: ${result.message}`.slice(0, 500) }).where(eq(broadcastRecipient.id, r.id))
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  const counts = await db
    .select({ status: broadcastRecipient.status, n: sql<number>`count(*)` })
    .from(broadcastRecipient)
    .where(eq(broadcastRecipient.broadcastId, b.id))
    .groupBy(broadcastRecipient.status)
  const n = (status: string) => counts.find((c) => c.status === status)?.n ?? 0
  const done = n('pending') + n('claimed') === 0
  await db
    .update(broadcast)
    .set({ sent: n('sent'), failed: n('failed'), ...(done && { status: 'sent' as const, sentAt: new Date().toISOString() }) })
    .where(and(eq(broadcast.id, b.id), eq(broadcast.status, 'sending')))
  return { claimed: claimed.length, backOff }
}

// One run: start what is due, then send the next batch.
export const processBroadcasts = async (db: Db, send: Send, publicUrl: string) => {
  const now = new Date()
  const due = await db
    .select({ id: broadcast.id, segmentId: broadcast.segmentId })
    .from(broadcast)
    .where(and(eq(broadcast.status, 'queued'), or(isNull(broadcast.scheduledAt), lte(broadcast.scheduledAt, now.toISOString()))))
  for (const b of due) {
    if (b.segmentId) await start(db, b.id, b.segmentId)
    // Its segment was deleted while it waited.
    else await db.update(broadcast).set({ status: 'draft', scheduledAt: null }).where(eq(broadcast.id, b.id))
  }

  await db
    .update(broadcastRecipient)
    .set({ status: 'pending', claimedAt: null })
    .where(and(eq(broadcastRecipient.status, 'claimed'), lt(broadcastRecipient.claimedAt, new Date(now.getTime() - STALE_CLAIM_MINUTES * 60_000).toISOString())))

  let budget = BATCH
  for (const b of await db.select().from(broadcast).where(eq(broadcast.status, 'sending')).orderBy(broadcast.id)) {
    if (budget <= 0) break
    const result = await sendBatch(db, send, publicUrl, b, budget)
    budget -= result.claimed
    if (result.backOff) break
  }
}

// A hard bounce or spam complaint: never write to them again from that
// domain (from any, when it is not known).
export const suppressContact = (db: Db, email: string, domainId?: number) =>
  db
    .update(contact)
    .set({ unsubscribed: true })
    .where(and(eq(contact.email, email.trim().toLowerCase()), domainId ? eq(contact.domainId, domainId) : undefined))
