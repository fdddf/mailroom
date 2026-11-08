// Our own addresses. Adding one makes it selectable as a sender and as an
// inbox filter. Its domain must be one of ours; whether mail for it is kept
// also depends on that domain's catch-all setting (and its Email Routing).

import { and, asc, count, desc, eq, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { domain, mail, mailbox, signature } from '../../db/schema'
import type { AppEnv } from '../../env'
import { domainOf, isEmail } from '../../lib/text'
import { validate } from '../../lib/validate'
import { idParam, inDomain } from './shared'

const name = z.string().trim().max(100, 'too_long')
// A verified Email Routing destination address, or nothing.
const forwardTo = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => !v || isEmail(v), 'invalid_email')

export const mailboxRoutes = new Hono<AppEnv>()
  // With how much mail each has received and sent.
  .get('/', async (c) => {
    const db = c.var.db
    const [rows, totals] = await db.batch([
      db.select().from(mailbox).where(inDomain(c, mailbox.domainId)).orderBy(asc(mailbox.domainId), desc(mailbox.isDefault), asc(mailbox.address)),
      db.select({ mailbox: mail.mailbox, direction: mail.direction, n: count() }).from(mail).where(inDomain(c, mail.domainId)).groupBy(mail.mailbox, mail.direction),
    ])
    const total = (address: string, direction: 'in' | 'out') => totals.find((t) => t.mailbox === address && t.direction === direction)?.n ?? 0
    return c.json({ items: rows.map((r) => ({ ...r, received: total(r.address, 'in'), sent: total(r.address, 'out') })) })
  })

  .post(
    '/',
    validate(
      'json',
      z.object({
        address: z.string().trim().toLowerCase().refine(isEmail, 'invalid_email').pipe(z.string().max(254, 'too_long')),
        name: name.default(''),
        forwardTo: forwardTo.default(''),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json')
      const db = c.var.db
      const own = await db.query.domain.findFirst({ columns: { id: true }, where: eq(domain.name, domainOf(body.address)) })
      if (!own) return c.json({ error: 'unknown_domain' }, 400)
      const [{ n }] = await db.select({ n: count() }).from(mailbox).where(eq(mailbox.domainId, own.id))
      const [row] = await db
        .insert(mailbox)
        // A domain's first mailbox is its default one.
        .values({ ...body, domainId: own.id, isDefault: n === 0 })
        .onConflictDoNothing({ target: mailbox.address })
        .returning()
      return row ? c.json(row) : c.json({ error: 'mailbox_exists' }, 409)
    },
  )

  // Rename, forward, give it a signature (null for none), or make it its
// domain's default sender (each domain has exactly one).
  .patch(
    '/:id',
    validate('param', idParam),
    validate(
      'json',
      z
        .object({ name, forwardTo, signatureId: z.number().int().positive().nullable(), isDefault: z.literal(true) })
        .partial()
        .refine((v) => Object.keys(v).length > 0, 'nothing_to_update'),
    ),
    async (c) => {
      const { id } = c.req.valid('param')
      const { isDefault, ...body } = c.req.valid('json')
      const db = c.var.db
      const row = await db.query.mailbox.findFirst({ columns: { id: true, domainId: true }, where: eq(mailbox.id, id) })
      if (!row) return c.json({ error: 'not_found' }, 404)
      if (body.signatureId && !(await db.query.signature.findFirst({ columns: { id: true }, where: eq(signature.id, body.signatureId) }))) {
        return c.json({ error: 'unknown_signature' }, 400)
      }
      if (Object.keys(body).length) await db.update(mailbox).set(body).where(eq(mailbox.id, id))
      if (isDefault) {
        await db.batch([
          db
            .update(mailbox)
            .set({ isDefault: false })
            .where(and(eq(mailbox.domainId, row.domainId), ne(mailbox.id, id))),
          db.update(mailbox).set({ isDefault: true }).where(eq(mailbox.id, id)),
        ])
      }
      return c.json({ ok: true })
    },
  )

  // Its mail stays. A domain's default goes only when it is the last one.
  .delete('/:id', validate('param', idParam), async (c) => {
    const { id } = c.req.valid('param')
    const db = c.var.db
    const row = await db.query.mailbox.findFirst({ where: eq(mailbox.id, id) })
    if (!row) return c.json({ error: 'not_found' }, 404)
    if (row.isDefault && (await db.$count(mailbox, eq(mailbox.domainId, row.domainId))) > 1) return c.json({ error: 'default_mailbox' }, 409)
    await db.delete(mailbox).where(eq(mailbox.id, id))
    return c.json({ ok: true })
  })
