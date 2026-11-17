// Contacts, segments and broadcasts, per domain, kept in D1 and sent with
// Cloudflare Email Sending. Response shapes are snake_case with string ids,
// as { data, has_more }.

import { and, asc, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Db } from '../../db'
import { BODY_FORMATS, broadcast, broadcastRecipient, contact, contactSegment, segment, type Broadcast, type Contact } from '../../db/schema'
import type { AppEnv } from '../../env'
import { cancelBroadcast, placeBroadcast, previewHtml, queueBroadcast, sendTestBroadcast } from '../../lib/broadcast'
import { importContacts, upsertContact } from '../../lib/contacts'
import { emailConfigured } from '../../lib/mailer'
import { isEmail } from '../../lib/text'
import { emptyBody, validate } from '../../lib/validate'
import { domainRequired, idParam, inDomain } from './shared'

const PAGE = 100
const MAX_IMPORT = 5000

const id = z.coerce.number({ error: 'invalid_id' }).int('invalid_id').positive('invalid_id')
const optionalName = z.string().trim().max(100).optional()

const contactView = (c: Contact) => ({
  id: String(c.id),
  domain_id: c.domainId,
  email: c.email,
  first_name: c.firstName || null,
  last_name: c.lastName || null,
  unsubscribed: c.unsubscribed,
  confirmed_at: c.confirmedAt,
  created_at: c.createdAt,
})

// The segment, if it is one of the domain's.
const segmentOf = (db: Db, segmentId: number, domainId: number) =>
  db.query.segment.findFirst({ columns: { id: true, domainId: true }, where: and(eq(segment.id, segmentId), eq(segment.domainId, domainId)) })

export const contactRoutes = new Hono<AppEnv>()
  // Newest first; `after` is the last id of the previous page.
  .get('/', validate('query', z.object({ segment: id.optional(), after: id.optional() })), async (c) => {
    const { segment: segmentId, after } = c.req.valid('query')
    const where: (SQL | undefined)[] = [inDomain(c, contact.domainId)]
    if (after) where.push(lt(contact.id, after))
    if (segmentId) where.push(sql`EXISTS (SELECT 1 FROM contact_segment cs WHERE cs.contact_id = ${contact.id} AND cs.segment_id = ${segmentId})`)
    const rows = await c.var.db.select().from(contact).where(and(...where)).orderBy(desc(contact.id)).limit(PAGE + 1)
    return c.json({ data: rows.slice(0, PAGE).map(contactView), has_more: rows.length > PAGE })
  })
  // Only add people who asked for your emails: the law, and Cloudflare, expect consent.
  .post(
    '/',
    validate(
      'json',
      z.object({
        email: z.string().trim().toLowerCase().refine(isEmail, 'invalid_email'),
        firstName: optionalName,
        lastName: optionalName,
        segmentId: id.optional(),
      }),
    ),
    async (c) => {
      const d = c.var.domain
      if (!d) return domainRequired(c)
      const b = c.req.valid('json')
      const db = c.var.db
      if (b.segmentId && !(await segmentOf(db, b.segmentId, d.id))) return c.json({ error: 'unknown_segment' }, 400)
      const row = await upsertContact(db, d.id, b)
      if (b.segmentId) await db.insert(contactSegment).values({ contactId: row.id, segmentId: b.segmentId }).onConflictDoNothing()
      return c.json({ id: String(row.id) })
    },
  )
  // Many at once: one per line, "email" or "email, first name, last name".
  // Existing contacts are left as they are (and stay unsubscribed if they were).
  .post('/import', validate('json', z.object({ text: z.string().max(500_000, 'too_long'), segmentId: id.optional() })), async (c) => {
    const d = c.var.domain
    if (!d) return domainRequired(c)
    const { text, segmentId } = c.req.valid('json')
    const db = c.var.db
    if (segmentId && !(await segmentOf(db, segmentId, d.id))) return c.json({ error: 'unknown_segment' }, 400)
    const rows = new Map<string, { email: string; firstName: string; lastName: string }>()
    let invalid = 0
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      const [email = '', firstName = '', lastName = ''] = line.split(/[,;\t]/).map((s) => s.trim().replace(/^"|"$/g, ''))
      const address = email.toLowerCase()
      // A header row is not an error.
      if (!isEmail(address)) invalid += address === 'email' ? 0 : 1
      else rows.set(address, { email: address, firstName, lastName })
    }
    if (rows.size > MAX_IMPORT) return c.json({ error: 'too_many_contacts' }, 400)
    return c.json({ ...(await importContacts(db, d.id, [...rows.values()], segmentId ? [segmentId] : [])), invalid })
  })
  .patch('/:id', validate('param', idParam), validate('json', z.object({ unsubscribed: z.boolean(), firstName: optionalName, lastName: optionalName }).partial()), async (c) => {
    const b = c.req.valid('json')
    const rows = await c.var.db
      .update(contact)
      .set({
        ...(b.unsubscribed !== undefined && { unsubscribed: b.unsubscribed }),
        ...(b.firstName !== undefined && { firstName: b.firstName }),
        ...(b.lastName !== undefined && { lastName: b.lastName }),
      })
      .where(eq(contact.id, c.req.valid('param').id))
      .returning({ id: contact.id })
    return rows.length ? c.json({ id: String(rows[0]!.id) }) : c.json({ error: 'not_found' }, 404)
  })
  .delete('/:id', validate('param', idParam), async (c) => {
    await c.var.db.delete(contact).where(eq(contact.id, c.req.valid('param').id))
    return c.json({ ok: true })
  })
  // Segments of the contact's own domain only.
  .post('/:id/segments', validate('param', idParam), validate('json', z.object({ segmentId: id })), async (c) => {
    const db = c.var.db
    const row = await db.query.contact.findFirst({ columns: { id: true, domainId: true }, where: eq(contact.id, c.req.valid('param').id) })
    if (!row) return c.json({ error: 'not_found' }, 404)
    const { segmentId } = c.req.valid('json')
    if (!(await segmentOf(db, segmentId, row.domainId))) return c.json({ error: 'unknown_segment' }, 400)
    await db.insert(contactSegment).values({ contactId: row.id, segmentId }).onConflictDoNothing()
    return c.json({ ok: true })
  })
  .delete('/:id/segments/:segmentId', validate('param', idParam.extend({ segmentId: id })), async (c) => {
    const p = c.req.valid('param')
    await c.var.db.delete(contactSegment).where(and(eq(contactSegment.contactId, p.id), eq(contactSegment.segmentId, p.segmentId)))
    return c.json({ ok: true })
  })

export const segmentRoutes = new Hono<AppEnv>()
  // With how many subscribed contacts each has.
  .get('/', async (c) => {
    const rows = await c.var.db
      .select({
        id: segment.id,
        domainId: segment.domainId,
        name: segment.name,
        createdAt: segment.createdAt,
        // "segment"."id" is spelled out: Drizzle would write it as a bare "id", which in here is the contact's.
        subscribers: sql<number>`(SELECT COUNT(*) FROM contact_segment cs JOIN contact c ON c.id = cs.contact_id WHERE cs.segment_id = "segment"."id" AND c.unsubscribed = 0)`,
      })
      .from(segment)
      .where(inDomain(c, segment.domainId))
      .orderBy(asc(segment.name))
    return c.json({ data: rows.map((s) => ({ id: String(s.id), domain_id: s.domainId, name: s.name, created_at: s.createdAt, subscribers: s.subscribers })) })
  })
  .post('/', validate('json', z.object({ name: z.string().trim().min(1, 'invalid_name').max(100, 'invalid_name') })), async (c) => {
    const d = c.var.domain
    if (!d) return domainRequired(c)
    const [row] = await c.var.db
      .insert(segment)
      .values({ ...c.req.valid('json'), domainId: d.id })
      .onConflictDoNothing()
      .returning()
    return row ? c.json({ id: String(row.id), name: row.name }) : c.json({ error: 'segment_exists' }, 409)
  })
  // The contacts themselves stay.
  .delete('/:id', validate('param', idParam), async (c) => {
    await c.var.db.delete(segment).where(eq(segment.id, c.req.valid('param').id))
    return c.json({ ok: true })
  })

// The broadcast editor's fields.
const broadcastInput = z.object({
  name: z.string().trim().max(200).default(''),
  segmentId: id,
  subject: z.string().trim().min(1, 'invalid_subject').max(300, 'invalid_subject'),
  previewText: z.string().trim().max(200).default(''),
  message: z.string().trim().min(1, 'invalid_message').max(200000, 'invalid_message'),
  // What `message` is: plain text, or HTML.
  format: z.enum(BODY_FORMATS).default('text'),
  // One of the domain's mailboxes; its default mailbox when omitted.
  from: z.string().trim().toLowerCase().optional(),
})

const broadcastView = (b: Broadcast) => ({
  id: String(b.id),
  domain_id: b.domainId,
  name: b.name,
  from: b.fromAddr,
  segment_id: b.segmentId ? String(b.segmentId) : null,
  status: b.status,
  created_at: b.createdAt,
  scheduled_at: b.scheduledAt,
  sent_at: b.sentAt,
  subject: b.subject,
  preview_text: b.previewText,
  message: b.message,
  format: b.format,
  total: b.total,
  sent: b.sent,
  failed: b.failed,
})

export const broadcastRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const rows = await c.var.db.select().from(broadcast).where(inDomain(c, broadcast.domainId)).orderBy(desc(broadcast.id)).limit(200)
    return c.json({ data: rows.map(broadcastView) })
  })
  // A draft; sending is a separate, deliberate step.
  .post('/', validate('json', broadcastInput), async (c) => {
    const { from, ...b } = c.req.valid('json')
    const placed = await placeBroadcast(c.var.db, b.segmentId, from)
    if ('error' in placed) return c.json({ error: placed.error }, 400)
    const [row] = await c.var.db
      .insert(broadcast)
      .values({ ...b, ...placed, name: b.name || b.subject })
      .returning({ id: broadcast.id })
    return c.json({ id: String(row!.id) })
  })
  // Send the draft as a normal email (default: to its sender) to check it.
  .post(
    '/test',
    validate(
      'json',
      broadcastInput.pick({ subject: true, message: true, format: true, previewText: true, from: true }).extend({ segmentId: id.optional(), to: z.string().trim().optional() }),
    ),
    async (c) => {
      const { to, from, segmentId, ...draft } = c.req.valid('json')
      const db = c.var.db
      const domainId = segmentId ? (await db.query.segment.findFirst({ columns: { domainId: true }, where: eq(segment.id, segmentId) }))?.domainId : c.var.domain?.id
      const sent = await sendTestBroadcast(c.env, db, draft, { from, domainId, to, source: 'dashboard' })
      return sent.ok ? c.json({ ok: true }) : c.json({ error: sent.error, message: 'message' in sent ? sent.message : undefined }, sent.status)
    },
  )
  // Plus `html`, as a subscriber sees it (with a dead unsubscribe link), and
  // the failures so far.
  .get('/:id', validate('param', idParam), async (c) => {
    const { id: bid } = c.req.valid('param')
    const db = c.var.db
    const row = await db.query.broadcast.findFirst({ where: eq(broadcast.id, bid) })
    if (!row) return c.json({ error: 'not_found' }, 404)
    const failures = await db
      .select({ email: broadcastRecipient.email, error: broadcastRecipient.error })
      .from(broadcastRecipient)
      .where(and(eq(broadcastRecipient.broadcastId, bid), eq(broadcastRecipient.status, 'failed')))
      .limit(50)
    return c.json({ ...broadcastView(row), html: await previewHtml(db, row), failures })
  })
  // Drafts only.
  .patch('/:id', validate('param', idParam), validate('json', broadcastInput), async (c) => {
    const { from, ...b } = c.req.valid('json')
    const placed = await placeBroadcast(c.var.db, b.segmentId, from)
    if ('error' in placed) return c.json({ error: placed.error }, 400)
    const rows = await c.var.db
      .update(broadcast)
      .set({ ...b, ...placed, name: b.name || b.subject })
      .where(and(eq(broadcast.id, c.req.valid('param').id), eq(broadcast.status, 'draft')))
      .returning({ id: broadcast.id })
    return rows.length ? c.json({ id: String(rows[0]!.id) }) : c.json({ error: 'not_a_draft' }, 409)
  })
  // Anything but one that is going out right now.
  .delete('/:id', validate('param', idParam), async (c) => {
    const rows = await c.var.db
      .delete(broadcast)
      .where(and(eq(broadcast.id, c.req.valid('param').id), inArray(broadcast.status, ['draft', 'sent', 'canceled'])))
      .returning({ id: broadcast.id })
    return rows.length ? c.json({ ok: true }) : c.json({ error: 'broadcast_in_progress' }, 409)
  })
  // Queue it: now, or at `scheduledAt` (ISO date). The cron picks it up
  // within a minute and sends it in batches.
  .post('/:id/send', validate('param', idParam), validate('json', z.object({ scheduledAt: z.iso.datetime().optional() })), async (c) => {
    if (!emailConfigured(c.env)) return c.json({ error: 'email_not_configured' }, 503)
    const { scheduledAt } = c.req.valid('json')
    const db = c.var.db
    const row = await db.query.broadcast.findFirst({ where: eq(broadcast.id, c.req.valid('param').id) })
    if (!row) return c.json({ error: 'not_found' }, 404)
    const queued = await queueBroadcast(db, row, scheduledAt, new URL(c.req.url).origin)
    if (queued.error) return c.json({ error: queued.error }, queued.status)
    return c.json({ id: String(row.id), recipients: queued.recipients })
  })
  // A queued one goes back to being a draft; one that is going out stops, and
  // whoever has not received it yet never will.
  .post('/:id/cancel', validate('param', idParam), emptyBody(), async (c) => {
    const { id: bid } = c.req.valid('param')
    const done = await cancelBroadcast(c.var.db, bid)
    return done ? c.json({ id: String(bid), status: done.status }) : c.json({ error: 'not_cancelable' }, 409)
  })
