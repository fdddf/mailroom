// The Worker. Besides answering HTTP (app.ts: the admin API, /v1, the
// unsubscribe pages, images), it is where Cloudflare's mail plumbing lands:
//
//   email()      Email Routing delivers mail for our domains here; it is
//                parsed and filed in the mail table, where the dashboard
//                shows it, and announced to the domain's webhooks.
//   scheduled()  Every minute: sends the next batch of any broadcast that is
//                due (lib/broadcast.ts).
//   queue()      Email Sending delivery events (delivered, bounced, …) update
//                the status shown in Sent, go to the domain's webhooks, and
//                unsubscribe contacts that hard-bounce or complain.

import type { ExecutionContext, ForwardableEmailMessage, MessageBatch } from '@cloudflare/workers-types'
import { eq } from 'drizzle-orm'
import PostalMime, { type Address } from 'postal-mime'
import app from './app'
import { getDb } from './db'
import { domain, mailbox, type Attachment } from './db/schema'
import type { Env } from './env'
import { sendBark } from './lib/bark'
import { processBroadcasts, suppressContact } from './lib/broadcast'
import { purgeExpiredSubscriptions } from './lib/subscribe'
import { deliver, recordDeliveryStatus, storeInbound } from './lib/mailer'
import { bareAddress, domainOf } from './lib/text'
import { emitEvent } from './lib/webhooks'

// Attachments above this are listed but not stored.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

const formatAddress = (a: Address | undefined) => (a?.address ? (a.name ? `${a.name} <${a.address}>` : a.address) : '')
const addressList = (list: Address[] | undefined) =>
  (list ?? []).flatMap((a) => (a.group ? a.group : [a])).map(formatAddress).filter(Boolean)

const publicUrl = (env: Env) => (env.PUBLIC_URL || '').replace(/\/$/, '')

const receive = async (message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) => {
  const recipient = bareAddress(message.to)
  const db = getDb(env.DB)
  const own = await db.query.domain.findFirst({ where: eq(domain.name, domainOf(recipient)) })
  // Email Routing sent us a domain nobody added in the dashboard.
  if (!own) return message.setReject('Unknown recipient')
  const box = await db.query.mailbox.findFirst({ where: eq(mailbox.address, recipient) })
  if (!box && !own.catchAll) return message.setReject('No such mailbox')

  try {
    // The raw stream can be read once.
    const raw = await new Response(message.raw as unknown as ReadableStream).arrayBuffer()
    const parsed = await PostalMime.parse(raw)
    const messageId = parsed.messageId || ''

    const prefix = `mail/${own.id}/${crypto.randomUUID()}`
    const attachments: Attachment[] = []
    for (const [i, a] of parsed.attachments.entries()) {
      const body = typeof a.content === 'string' ? new TextEncoder().encode(a.content) : new Uint8Array(a.content)
      const id = `${prefix}/${i}`
      attachments.push({ id, filename: a.filename, size: body.byteLength, content_type: a.mimeType })
      if (env.BUCKET && body.byteLength <= MAX_ATTACHMENT_BYTES) await env.BUCKET.put(id, body, { httpMetadata: { contentType: a.mimeType } })
    }

    const email = {
      // One email to two of our addresses is delivered, and kept, twice.
      key: `cf:${recipient}:${messageId || crypto.randomUUID()}`,
      domainId: own.id,
      mailbox: recipient,
      // The header is what a person sees; the envelope sender is the fallback.
      from: formatAddress(parsed.from) || message.from,
      to: addressList(parsed.to),
      cc: addressList(parsed.cc),
      replyTo: addressList(parsed.replyTo)[0] || '',
      subject: parsed.subject || '',
      text: parsed.text || null,
      html: parsed.html || null,
      messageId,
      date: parsed.date || null,
      attachments,
    }
    const stored = await storeInbound(db, email)

    if (!stored.created) {
      // A redelivery: drop the copies of the attachments just written.
      if (env.BUCKET && attachments.length) await env.BUCKET.delete(attachments.map((a) => a.id))
    } else {
      const snippet = (parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 300)
      ctx.waitUntil(
        Promise.all([
          sendBark(env, {
            title: `New mail to ${recipient} · ${bareAddress(parsed.from?.address || message.from)}`,
            body: [parsed.subject, snippet].filter(Boolean).join('\n'),
            url: publicUrl(env) ? `${publicUrl(env)}/mail/${stored.id}` : undefined,
          }),
          emitEvent(db, own.id, 'mail.received', {
            id: stored.id,
            domain: own.name,
            mailbox: recipient,
            envelopeFrom: message.from,
            from: email.from,
            to: email.to,
            cc: email.cc,
            replyTo: email.replyTo,
            subject: email.subject,
            text: email.text,
            html: email.html,
            messageId,
            inReplyTo: parsed.inReplyTo || null,
            references: (parsed.references || '').split(/\s+/).filter(Boolean),
            date: stored.createdAt,
            attachments: attachments.map(({ filename, size, content_type }) => ({ filename, size, contentType: content_type })),
          }),
        ]).catch((err) => console.error('new mail notifications failed', err)),
      )
    }
  } catch (err) {
    console.error('inbound mail failed', err)
    // Without a forward to fall back on, make the sending server retry
    // rather than lose the email.
    if (!box?.forwardTo) throw err
  }
  if (box?.forwardTo) await message.forward(box.forwardTo)
}

// cf.email.sending.message.<event> -> the status the dashboard shows.
const EVENT_STATUS: Record<string, string> = {
  delivered: 'delivered',
  deferred: 'delivery_delayed',
  bounced: 'bounced',
  failed: 'failed',
  rejected: 'suppressed',
  complained: 'complained',
}

type DeliveryEvent = { type?: string; payload?: { messageId?: string; sender?: string; recipient?: string; subject?: string; bounce?: { type?: string } } }

export default {
  fetch: app.fetch,

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    await receive(message, env, ctx)
  },

  async scheduled(_controller: unknown, env: Env) {
    const db = getDb(env.DB)
    await purgeExpiredSubscriptions(db)
    await processBroadcasts(db, (m) => deliver(env, m), publicUrl(env))
  },

  async queue(batch: MessageBatch<DeliveryEvent>, env: Env) {
    const db = getDb(env.DB)
    for (const message of batch.messages) {
      const status = EVENT_STATUS[(message.body.type || '').split('.').pop() || '']
      const { messageId, sender, recipient, subject, bounce } = message.body.payload ?? {}
      if (status && messageId) {
        const row = await recordDeliveryStatus(db, messageId, status, { sender, recipient, subject })
        if (row) {
          await emitEvent(db, row.domainId, 'mail.status', {
            id: row.id,
            messageId: row.messageId,
            mailbox: row.mailbox,
            to: row.toAddrs,
            subject: row.subject,
            status,
            recipient: recipient ?? null,
            bounce: bounce ?? null,
          }).catch((err) => console.error('mail.status webhook failed', err))
        } else {
          // Broadcast emails are not in the mail table, so most misses are those;
          // the log line is for telling when something else is going unmatched.
          console.log('delivery event without a matching email', JSON.stringify(message.body.payload))
        }
      }
      if (recipient && (status === 'complained' || (status === 'bounced' && bounce?.type === 'hard'))) {
        const own = sender ? await db.query.domain.findFirst({ columns: { id: true }, where: eq(domain.name, domainOf(sender)) }) : undefined
        await suppressContact(db, recipient, own?.id)
      }
      message.ack()
    }
  },
}
