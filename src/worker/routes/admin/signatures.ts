// Signatures, added under what is written when sending (lib/compose.ts). One
// belongs to the domain it was made in, or is shared by all of them; a mailbox
// can have one it starts with.

import { desc, eq, isNull, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { nowIso, type Db } from '../../db'
import { BODY_FORMATS, mailbox, signature } from '../../db/schema'
import type { AppEnv } from '../../env'
import { validate } from '../../lib/validate'
import { idParam } from './shared'

const input = z.object({
  name: z.string().trim().min(1, 'invalid_name').max(100, 'invalid_name'),
  format: z.enum(BODY_FORMATS).default('text'),
  body: z.string().max(20_000, 'too_long').default(''),
  // For every domain rather than the one picked in the dashboard.
  shared: z.boolean().default(false),
})

export const signatureRoutes = new Hono<AppEnv>()
  // The picked domain's and the shared ones, with their bodies: they are
  // short, and Compose shows the one picked.
  .get('/', async (c) => {
    const d = c.var.domain
    const items = await c.var.db
      .select()
      .from(signature)
      .where(d ? or(eq(signature.domainId, d.id), isNull(signature.domainId)) : undefined)
      .orderBy(desc(signature.updatedAt))
    return c.json({ items })
  })
  .get('/:id', validate('param', idParam), async (c) => {
    const row = await c.var.db.query.signature.findFirst({ where: eq(signature.id, c.req.valid('param').id) })
    return row ? c.json(row) : c.json({ error: 'not_found' }, 404)
  })
  .post('/', validate('json', input), async (c) => {
    const { shared, ...values } = c.req.valid('json')
    const [row] = await c.var.db
      .insert(signature)
      .values({ ...values, domainId: shared ? null : (c.var.domain?.id ?? null) })
      .returning({ id: signature.id })
    return c.json({ id: row!.id })
  })
  // As for templates: sharing stays as it was unless `shared` says otherwise.
  .patch('/:id', validate('param', idParam), validate('json', input.partial({ shared: true })), async (c) => {
    const { shared, ...values } = c.req.valid('json')
    const rows = await c.var.db
      .update(signature)
      .set({ ...values, ...(shared !== undefined && { domainId: shared ? null : (c.var.domain?.id ?? null) }), updatedAt: nowIso() })
      .where(eq(signature.id, c.req.valid('param').id))
      .returning({ id: signature.id })
    return rows.length ? c.json({ id: rows[0]!.id }) : c.json({ error: 'not_found' }, 404)
  })
  // Mailboxes that started with it start with none.
  .delete('/:id', validate('param', idParam), async (c) => {
    const { id } = c.req.valid('param')
    const db = c.var.db
    await db.batch([db.update(mailbox).set({ signatureId: null }).where(eq(mailbox.signatureId, id)), db.delete(signature).where(eq(signature.id, id))])
    return c.json({ ok: true })
  })
