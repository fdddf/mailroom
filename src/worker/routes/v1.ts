// /v1 — the integration API, for other systems that work with one of our
// domains: send email from it, and manage its contacts (sign-up forms,
// account emails, notifications…). Every request carries an API key made on
// the Domains page, `Authorization: Bearer mr_…`, which is good for one
// domain and the scopes it was given. Reference: docs/api.md.
//
// Keys are secrets: call this from a server, never from a browser.

import { and, eq, inArray } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import { getDb } from '../db'
import { apiKey, contact, contactSegment, domain, mail, mailbox, segment, type ApiScope, type Contact } from '../db/schema'
import type { AppEnv } from '../env'
import { sha256Hex } from '../lib/crypto'
import { emailConfigured, sendMail } from '../lib/mailer'
import { htmlToText, isEmail, parseAddressList } from '../lib/text'
import { validate } from '../lib/validate'
import { upsertContact } from './admin/marketing'

// Headers a caller may set on an email; the rest are Email Sending's.
const ALLOWED_HEADER = /^(x-[a-z0-9-]+|in-reply-to|references|list-unsubscribe|list-unsubscribe-post|list-id)$/i
// last_used_at is written at most this often per key.
const TOUCH_MS = 60_000

const auth = createMiddleware<AppEnv>(async (c, next) => {
  const token = (c.req.header('Authorization') || '').match(/^Bearer\s+(mr_[A-Za-z0-9_-]+)$/)?.[1]
  if (!token) return c.json({ error: 'unauthorized', message: 'Send the API key as Authorization: Bearer mr_…' }, 401)
  const db = getDb(c.env.DB)
  const [row] = await db
    .select({ key: apiKey, domain })
    .from(apiKey)
    .innerJoin(domain, eq(domain.id, apiKey.domainId))
    .where(eq(apiKey.hash, await sha256Hex(token)))
  if (!row) return c.json({ error: 'unauthorized', message: 'Unknown or revoked API key' }, 401)
  c.set('db', db)
  c.set('domain', row.domain)
  c.set('apiKey', row.key)
  if (!row.key.lastUsedAt || Date.now() - Date.parse(row.key.lastUsedAt) > TOUCH_MS) {
    c.executionCtx.waitUntil(db.update(apiKey).set({ lastUsedAt: new Date().toISOString() }).where(eq(apiKey.id, row.key.id)).then(() => {}))
  }
  return next()
})

// null when the key may; else the answer to send.
const forbidden = (c: Context<AppEnv>, scope: ApiScope) =>
  c.var.apiKey.scopes.includes(scope) ? null : c.json({ error: 'forbidden', message: `This key lacks the "${scope}" scope` }, 403)

const recipients = (code: string) =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v, ctx) => {
      const list = parseAddressList(v ?? '')
      if (!list) ctx.addIssue({ code: 'custom', message: code })
      return list ?? []
    })

const sendInput = z
  .object({
    // An address on the key's domain, "Name <a@b.c>" or "a@b.c"; the domain's
    // default mailbox when left out.
    from: z.string().trim().max(320).optional(),
    to: recipients('invalid_to'),
    cc: recipients('invalid_cc'),
    bcc: recipients('invalid_bcc'),
    replyTo: z
      .string()
      .trim()
      .optional()
      .refine((v) => !v || isEmail(v), 'invalid_reply_to'),
    subject: z.string().trim().min(1, 'invalid_subject').max(998, 'invalid_subject'),
    text: z.string().max(400_000, 'too_long').optional(),
    html: z.string().max(900_000, 'too_long').optional(),
    headers: z
      .record(z.string(), z.string().max(2000))
      .optional()
      .refine((h) => !h || Object.keys(h).every((k) => ALLOWED_HEADER.test(k)), 'header_not_allowed'),
    // false: send without keeping a copy in Sent.
    record: z.boolean().default(true),
  })
  .refine((m) => m.to.length + m.cc.length + m.bcc.length > 0, 'invalid_to')
  .refine((m) => m.to.length + m.cc.length + m.bcc.length <= 50, 'too_many_recipients')
  .refine((m) => Boolean(m.text?.trim() || m.html?.trim()), 'invalid_message')

const contactInput = z.object({
  email: z.string().trim().toLowerCase().refine(isEmail, 'invalid_email'),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  // Segment names; ones that do not exist yet are made.
  segments: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  // Subscribe again someone who had unsubscribed. Only for someone who has
  // just asked for it again, e.g. by signing up.
  resubscribe: z.boolean().default(false),
})

const contactView = (row: Contact, segments: string[]) => ({
  id: row.id,
  email: row.email,
  firstName: row.firstName,
  lastName: row.lastName,
  unsubscribed: row.unsubscribed,
  segments,
  createdAt: row.createdAt,
})

const segmentsOf = async (db: AppEnv['Variables']['db'], contactId: number) =>
  (
    await db
      .select({ name: segment.name })
      .from(contactSegment)
      .innerJoin(segment, eq(segment.id, contactSegment.segmentId))
      .where(eq(contactSegment.contactId, contactId))
  ).map((s) => s.name)

const emailParam = z.object({ email: z.string().trim().toLowerCase().refine(isEmail, 'invalid_email') })

export const v1Routes = new Hono<AppEnv>()
  .use(auth)

  // Which domain this key is for, and its addresses: a quick check of a key.
  .get('/domain', async (c) => {
    const d = c.var.domain!
    const boxes = await c.var.db.select({ address: mailbox.address, name: mailbox.name, isDefault: mailbox.isDefault }).from(mailbox).where(eq(mailbox.domainId, d.id))
    return c.json({ domain: d.name, brand: d.brand, scopes: c.var.apiKey.scopes, mailboxes: boxes })
  })

  // Send one email. With only `html`, the text part is made from it.
  .post('/send', validate('json', sendInput), async (c) => {
    const denied = forbidden(c, 'send')
    if (denied) return denied
    if (!emailConfigured(c.env)) return c.json({ error: 'email_not_configured' }, 503)
    const m = c.req.valid('json')
    const sent = await sendMail(c.env, c.var.db, {
      from: m.from,
      domainId: c.var.domain!.id,
      anyAddress: true,
      to: m.to,
      cc: m.cc,
      bcc: m.bcc,
      replyTo: m.replyTo,
      subject: m.subject,
      text: m.text?.trim() ? m.text : htmlToText(m.html ?? ''),
      html: m.html?.trim() ? m.html : undefined,
      headers: m.headers,
      source: `api:${c.var.apiKey.name}`,
      record: m.record,
    })
    if (!sent.ok) return c.json({ error: sent.error, message: sent.message }, sent.status)
    return c.json({ id: sent.mailId, messageId: sent.messageId })
  })

  // An email of this domain's, sent or received: mostly for its delivery status.
  .get('/mail/:id', validate('param', z.object({ id: z.coerce.number().int().positive() })), async (c) => {
    const denied = forbidden(c, 'send')
    if (denied) return denied
    const row = await c.var.db.query.mail.findFirst({
      columns: { id: true, direction: true, createdAt: true, mailbox: true, fromAddr: true, toAddrs: true, ccAddrs: true, subject: true, messageId: true, status: true },
      where: and(eq(mail.id, c.req.valid('param').id), eq(mail.domainId, c.var.domain!.id)),
    })
    return row ? c.json(row) : c.json({ error: 'not_found' }, 404)
  })

  // Add or update a contact, and put them in segments.
  .post('/contacts', validate('json', contactInput), async (c) => {
    const denied = forbidden(c, 'contacts')
    if (denied) return denied
    const { segments: names, resubscribe, ...b } = c.req.valid('json')
    const db = c.var.db
    const domainId = c.var.domain!.id
    let row = await upsertContact(db, domainId, b)
    if (resubscribe && row.unsubscribed) {
      ;[row] = await db.update(contact).set({ unsubscribed: false }).where(eq(contact.id, row.id)).returning()
    }
    if (names.length) {
      const unique = [...new Set(names)]
      await db.insert(segment).values(unique.map((name) => ({ domainId, name }))).onConflictDoNothing()
      const ids = await db
        .select({ id: segment.id })
        .from(segment)
        .where(and(eq(segment.domainId, domainId), inArray(segment.name, unique)))
      await db
        .insert(contactSegment)
        .values(ids.map((s) => ({ contactId: row!.id, segmentId: s.id })))
        .onConflictDoNothing()
    }
    return c.json(contactView(row!, await segmentsOf(db, row!.id)))
  })

  .get('/contacts/:email', validate('param', emailParam), async (c) => {
    const denied = forbidden(c, 'contacts')
    if (denied) return denied
    const row = await c.var.db.query.contact.findFirst({ where: and(eq(contact.domainId, c.var.domain!.id), eq(contact.email, c.req.valid('param').email)) })
    return row ? c.json(contactView(row, await segmentsOf(c.var.db, row.id))) : c.json({ error: 'not_found' }, 404)
  })

  // They stay on file, marked unsubscribed, so a later import cannot add them back.
  .post('/contacts/:email/unsubscribe', validate('param', emailParam), async (c) => {
    const denied = forbidden(c, 'contacts')
    if (denied) return denied
    const rows = await c.var.db
      .update(contact)
      .set({ unsubscribed: true })
      .where(and(eq(contact.domainId, c.var.domain!.id), eq(contact.email, c.req.valid('param').email)))
      .returning({ id: contact.id })
    return rows.length ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
  })

  // Forget them entirely (e.g. a deletion request).
  .delete('/contacts/:email', validate('param', emailParam), async (c) => {
    const denied = forbidden(c, 'contacts')
    if (denied) return denied
    const rows = await c.var.db
      .delete(contact)
      .where(and(eq(contact.domainId, c.var.domain!.id), eq(contact.email, c.req.valid('param').email)))
      .returning({ id: contact.id })
    return rows.length ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
  })
