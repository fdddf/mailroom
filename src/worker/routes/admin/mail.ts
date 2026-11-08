import { and, desc, eq, isNull, lt, ne, sql, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { nowIso } from '../../db'
import { BODY_FORMATS, mail, mailbox } from '../../db/schema'
import type { AppEnv } from '../../env'
import { composeBody } from '../../lib/compose'
import { publicBase } from '../../lib/files'
import { deleteAttachments, emailConfigured, sendMail } from '../../lib/mailer'
import { bareAddress, likePattern, parseAddressList } from '../../lib/text'
import { validate } from '../../lib/validate'
import { filePicks, prepareFiles } from './files'
import { PAGE_SIZE, domainRequired, idParam, inDomain, snippet, threadColumns } from './shared'

const listQuery = z.object({
  box: z.enum(['inbox', 'unread', 'archived', 'all']).default('inbox'),
  // One of our addresses; all of them (in the domain) when empty.
  mailbox: z.string().trim().toLowerCase().default(''),
  q: z.string().trim().default(''),
  before: z.coerce.number().int().positive().optional(),
})
const sentQuery = listQuery.omit({ box: true })
const sender = z.string().trim().toLowerCase().optional()

const addressList = (code: string) =>
  z
    .string()
    .default('')
    .transform((v, ctx) => {
      const list = parseAddressList(v)
      if (!list) ctx.addIssue({ code: 'custom', message: code })
      return list ?? []
    })

export const mailRoutes = new Hono<AppEnv>()
  // Received email, newest first.
  .get('/', validate('query', listQuery), async (c) => {
    const { box, mailbox: address, q, before } = c.req.valid('query')
    const db = c.var.db
    const where: (SQL | undefined)[] = [eq(mail.direction, 'in'), inDomain(c, mail.domainId)]
    if (box === 'inbox' || box === 'unread') where.push(eq(mail.archived, false))
    if (box === 'unread') where.push(isNull(mail.readAt))
    if (box === 'archived') where.push(eq(mail.archived, true))
    // Counts follow the domain and mailbox, not the box or the search.
    const scope = and(eq(mail.direction, 'in'), inDomain(c, mail.domainId), address ? eq(mail.mailbox, address) : undefined)
    if (address) where.push(eq(mail.mailbox, address))
    if (q) {
      const pattern = likePattern(q)
      where.push(sql`(${sql.join([mail.fromAddr, mail.subject, mail.text].map((col) => sql`${col} LIKE ${pattern} ESCAPE '\\'`), sql` OR `)})`)
    }
    if (before) where.push(lt(mail.id, before))

    const [rows, [counts]] = await db.batch([
      db
        .select({
          id: mail.id,
          domainId: mail.domainId,
          createdAt: mail.createdAt,
          fromAddr: mail.fromAddr,
          mailbox: mail.mailbox,
          subject: mail.subject,
          snippet: snippet(mail.text),
          readAt: mail.readAt,
          archived: mail.archived,
          attachmentCount: sql<number>`json_array_length(${mail.attachments})`,
        })
        .from(mail)
        .where(and(...where))
        .orderBy(desc(mail.id))
        .limit(PAGE_SIZE + 1),
      db
        .select({
          inbox: sql<number>`coalesce(sum(${mail.archived} = 0), 0)`,
          unread: sql<number>`coalesce(sum(${mail.archived} = 0 AND ${mail.readAt} IS NULL), 0)`,
          archived: sql<number>`coalesce(sum(${mail.archived} = 1), 0)`,
          all: sql<number>`count(*)`,
        })
        .from(mail)
        .where(scope),
    ])
    return c.json({ items: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE, counts: counts! })
  })

  // A new email to anyone, from one of our mailboxes (the picked domain's
  // default when `from` is left out); `to`/`cc` are comma-separated.
  // `message` is plain text, or HTML (a text version is made from it for
  // clients that prefer one). The files' download links are added under it; the other files are attached.
  .post(
    '/send',
    validate(
      'json',
      z.object({
        from: sender,
        to: addressList('invalid_to').refine((l) => l.length > 0, 'invalid_to'),
        cc: addressList('invalid_cc'),
        subject: z.string().trim().min(1, 'invalid_subject').max(300, 'invalid_subject'),
        message: z.string().trim().min(1, 'invalid_message').max(200000, 'invalid_message'),
        format: z.enum(BODY_FORMATS).default('text'),
        attachments: filePicks,
      }),
    ),
    async (c) => {
      if (!emailConfigured(c.env)) return c.json({ error: 'email_not_configured' }, 503)
      const { from, to, cc, subject, message, format, attachments } = c.req.valid('json')
      if (!from && !c.var.domain) return domainRequired(c)
      const db = c.var.db
      const files = await prepareFiles(c.env, db, publicBase(c.env, c.req.url), attachments)
      if (!files.ok) return c.json({ error: files.error }, files.status)
      const sent = await sendMail(c.env, db, {
        from,
        domainId: from ? undefined : c.var.domain!.id,
        to,
        cc,
        subject,
        ...composeBody({ message: { format, body: message }, links: files.links }),
        files: files.files,
        embedImages: true,
        source: 'dashboard',
      })
      if (!sent.ok) return c.json({ error: sent.error, message: sent.message }, sent.status)
      return c.json({ ok: true, mailId: sent.mailId })
    },
  )

  // Delete received emails picked in the list, with their attachments in R2.
  // Only those in the picked domain go; ids already gone are skipped. The ids
  // travel as one JSON parameter: D1 allows 100 bound parameters a query.
  .post('/bulk-delete', validate('json', z.object({ ids: z.array(z.number().int().positive()).min(1, 'invalid_ids').max(5000, 'invalid_ids') })), async (c) => {
    const { ids } = c.req.valid('json')
    const rows = await c.var.db
      .delete(mail)
      .where(and(sql`${mail.id} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`, eq(mail.direction, 'in'), inDomain(c, mail.domainId)))
      .returning({ attachments: mail.attachments })
    await deleteAttachments(c.env, rows.flatMap((r) => r.attachments.map((a) => a.id)))
    return c.json({ deleted: rows.length })
  })

  // One email (either direction) plus recent back-and-forth with the same
  // person on the same domain. Opening an incoming email marks it read.
  .get('/:id', validate('param', idParam), async (c) => {
    const { id } = c.req.valid('param')
    const db = c.var.db
    const [row] = await db.select({ ...threadColumns, messageId: mail.messageId }).from(mail).where(eq(mail.id, id))
    if (!row) return c.json({ error: 'not_found' }, 404)

    const markedRead = row.direction === 'in' && !row.readAt
    if (markedRead) {
      row.readAt = nowIso()
      await db.update(mail).set({ readAt: row.readAt }).where(eq(mail.id, id))
    }

    // The other party: the sender of an incoming email, the first recipient of an outgoing one.
    const counterpart = row.direction === 'in' ? bareAddress(row.fromAddr) : bareAddress(row.toAddrs[0])
    const pattern = likePattern(counterpart)
    const related = counterpart
      ? await db
          .select({ id: mail.id, direction: mail.direction, createdAt: mail.createdAt, subject: mail.subject, snippet: snippet(mail.text) })
          .from(mail)
          .where(
            and(
              ne(mail.id, id),
              eq(mail.domainId, row.domainId),
              sql`((${mail.direction} = 'in' AND lower(${mail.fromAddr}) LIKE ${pattern} ESCAPE '\\')
                OR (${mail.direction} = 'out' AND EXISTS (SELECT 1 FROM json_each(${mail.toAddrs}) WHERE lower(value) LIKE ${pattern} ESCAPE '\\')))`,
            ),
          )
          .orderBy(desc(mail.id))
          .limit(20)
      : []

    return c.json({ mail: row, related, markedRead })
  })

  .patch(
    '/:id',
    validate('param', idParam),
    validate(
      'json',
      z
        .object({ read: z.boolean(), archived: z.boolean() })
        .partial()
        .refine((v) => Object.keys(v).length > 0, 'nothing_to_update'),
    ),
    async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.valid('json')
      const rows = await c.var.db
        .update(mail)
        .set({
          ...(body.read !== undefined && { readAt: body.read ? nowIso() : null }),
          ...(body.archived !== undefined && { archived: body.archived }),
        })
        .where(eq(mail.id, id))
        .returning({ id: mail.id })
      return rows.length ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
    },
  )

  // Its attachments in R2 go too.
  .delete('/:id', validate('param', idParam), async (c) => {
    const { id } = c.req.valid('param')
    const rows = await c.var.db.delete(mail).where(eq(mail.id, id)).returning({ id: mail.id, attachments: mail.attachments })
    if (!rows.length) return c.json({ error: 'not_found' }, 404)
    await deleteAttachments(c.env, rows[0]!.attachments.map((a) => a.id))
    return c.json({ ok: true })
  })

  // An email's HTML body, for an <iframe sandbox> in the dashboard. The CSP
  // (including its own `sandbox`) keeps it inert even if opened directly: no
  // scripts, no forms, no same-origin access, and no remote loads — remote
  // images (often trackers) only with ?images=1.
  .get('/:id/html', validate('param', idParam), async (c) => {
    const { id } = c.req.valid('param')
    const row = await c.var.db.query.mail.findFirst({ columns: { html: true }, where: eq(mail.id, id) })
    if (!row?.html) return c.text('Not found', 404)
    const images = c.req.query('images') === '1' ? 'data: https:' : 'data:'
    return c.body(row.html, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; img-src ${images}; style-src 'unsafe-inline'; font-src data:; sandbox allow-popups allow-popups-to-escape-sandbox`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    })
  })

  // An attachment of a received email, from R2 (its id is the object key).
  // Always a download: never rendered on this origin.
  .get('/:id/attachments/:aid{.+}', validate('param', idParam.extend({ aid: z.string().min(1) })), async (c) => {
    const { id, aid } = c.req.valid('param')
    const row = await c.var.db.query.mail.findFirst({ columns: { attachments: true }, where: eq(mail.id, id) })
    const meta = row?.attachments.find((a) => a.id === aid)
    if (!meta) return c.json({ error: 'not_found' }, 404)
    const object = await c.env.BUCKET?.get(aid)
    if (!object) return c.json({ error: 'attachment_unavailable' }, 424)
    const filename = (meta.filename || 'attachment').replace(/[\r\n"\\]/g, '_')
    return c.body(object.body as unknown as ReadableStream, 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Content-Length': String(object.size),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    })
  })

  // Answer an incoming email: to its Reply-To (or sender), from the mailbox
  // it arrived at unless `from` says otherwise, threaded with
  // In-Reply-To/References, quoting the original under it.
  .post(
    '/:id/reply',
    validate('param', idParam),
    validate(
      'json',
      z.object({
        message: z.string().trim().min(1, 'empty_reply').max(20000, 'too_long'),
        format: z.enum(BODY_FORMATS).default('text'),
        archive: z.boolean().default(false),
        from: sender,
        attachments: filePicks,
      }),
    ),
    async (c) => {
      if (!emailConfigured(c.env)) return c.json({ error: 'email_not_configured' }, 503)
      const { id } = c.req.valid('param')
      const { message, format, archive, from, attachments } = c.req.valid('json')
      const db = c.var.db
      const original = await db.query.mail.findFirst({ where: and(eq(mail.id, id), eq(mail.direction, 'in')) })
      if (!original) return c.json({ error: 'not_found' }, 404)
      const files = await prepareFiles(c.env, db, publicBase(c.env, c.req.url), attachments)
      if (!files.ok) return c.json({ error: files.error }, files.status)

      const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`.trim()
      // The address it arrived at, if it is (still) a mailbox; else the domain's default.
      const arrivedAt = (await db.query.mailbox.findFirst({ columns: { address: true }, where: eq(mailbox.address, original.mailbox) }))?.address
      const sent = await sendMail(c.env, db, {
        from: from || arrivedAt,
        domainId: original.domainId,
        to: [bareAddress(original.replyTo || original.fromAddr)],
        subject,
        ...composeBody({
          message: { format, body: message },
          links: files.links,
          quote: { attribution: `On ${original.createdAt.slice(0, 10)}, ${original.fromAddr} wrote:`, text: original.text ?? '' },
        }),
        files: files.files,
        embedImages: true,
        headers: original.messageId ? { 'In-Reply-To': original.messageId, References: original.messageId } : undefined,
        source: 'dashboard',
      })
      if (!sent.ok) return c.json({ error: sent.error, message: sent.message }, sent.status)

      await db
        .update(mail)
        .set({ readAt: original.readAt ?? nowIso(), archived: archive || original.archived })
        .where(eq(mail.id, id))
      return c.json({ ok: true, mailId: sent.mailId })
    },
  )

// Everything sent from here and through the API, newest first; the detail
// view is /mail/:id.
export const sentRoutes = new Hono<AppEnv>().get('/', validate('query', sentQuery), async (c) => {
  const { mailbox: address, q, before } = c.req.valid('query')
  const where: (SQL | undefined)[] = [eq(mail.direction, 'out'), inDomain(c, mail.domainId)]
  if (address) where.push(eq(mail.mailbox, address))
  if (q) {
    const pattern = likePattern(q)
    where.push(sql`(${sql.join([mail.toAddrs, mail.subject, mail.text].map((col) => sql`${col} LIKE ${pattern} ESCAPE '\\'`), sql` OR `)})`)
  }
  if (before) where.push(lt(mail.id, before))
  const rows = await c.var.db
    .select({
      id: mail.id,
      domainId: mail.domainId,
      createdAt: mail.createdAt,
      mailbox: mail.mailbox,
      source: mail.source,
      toAddrs: mail.toAddrs,
      subject: mail.subject,
      snippet: snippet(mail.text),
      status: mail.status,
    })
    .from(mail)
    .where(and(...where))
    .orderBy(desc(mail.id))
    .limit(PAGE_SIZE + 1)
  return c.json({ items: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE })
})
