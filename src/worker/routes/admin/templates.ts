// Reusable emails, picked as a starting point in Compose and Broadcasts. A
// template belongs to the domain it was made in, or is shared by all of them.

import { desc, eq, isNull, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { nowIso } from '../../db'
import { BODY_FORMATS, template } from '../../db/schema'
import type { AppEnv } from '../../env'
import { validate } from '../../lib/validate'
import { idParam } from './shared'

const input = z.object({
  name: z.string().trim().min(1, 'invalid_name').max(100, 'invalid_name'),
  subject: z.string().trim().max(300, 'invalid_subject').default(''),
  format: z.enum(BODY_FORMATS).default('html'),
  body: z.string().max(200_000, 'too_long').default(''),
  // For every domain rather than the one picked in the dashboard.
  shared: z.boolean().default(false),
})

export const templateRoutes = new Hono<AppEnv>()
  // The picked domain's and the shared ones, without bodies; the list only needs names.
  .get('/', async (c) => {
    const d = c.var.domain
    const items = await c.var.db
      .select({ id: template.id, domainId: template.domainId, name: template.name, subject: template.subject, format: template.format, updatedAt: template.updatedAt })
      .from(template)
      .where(d ? or(eq(template.domainId, d.id), isNull(template.domainId)) : undefined)
      .orderBy(desc(template.updatedAt))
    return c.json({ items })
  })
  .get('/:id', validate('param', idParam), async (c) => {
    const row = await c.var.db.query.template.findFirst({ where: eq(template.id, c.req.valid('param').id) })
    return row ? c.json(row) : c.json({ error: 'not_found' }, 404)
  })
  .post('/', validate('json', input), async (c) => {
    const { shared, ...values } = c.req.valid('json')
    const [row] = await c.var.db
      .insert(template)
      .values({ ...values, domainId: shared ? null : (c.var.domain?.id ?? null) })
      .returning({ id: template.id })
    return c.json({ id: row!.id })
  })
  // Sharing it is kept as it was unless `shared` says otherwise; making a
  // shared one domain-only puts it in the picked domain.
  .patch('/:id', validate('param', idParam), validate('json', input.partial({ shared: true })), async (c) => {
    const { shared, ...values } = c.req.valid('json')
    const rows = await c.var.db
      .update(template)
      .set({ ...values, ...(shared !== undefined && { domainId: shared ? null : (c.var.domain?.id ?? null) }), updatedAt: nowIso() })
      .where(eq(template.id, c.req.valid('param').id))
      .returning({ id: template.id })
    return rows.length ? c.json({ id: rows[0]!.id }) : c.json({ error: 'not_found' }, 404)
  })
  .delete('/:id', validate('param', idParam), async (c) => {
    await c.var.db.delete(template).where(eq(template.id, c.req.valid('param').id))
    return c.json({ ok: true })
  })
