// Block rules: what the inbox files straight into Archived (lib/spam.ts).

import { desc, eq, isNull, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { BLOCK_KINDS, blockRule } from '../../db/schema'
import type { AppEnv } from '../../env'
import { bareAddress, domainOf, isDomainName } from '../../lib/text'
import { validate } from '../../lib/validate'
import { idParam } from './shared'

const input = z.object({
  kind: z.enum(BLOCK_KINDS),
  // An address or domain may be given as a whole "Name <a@b.c>".
  value: z.string().trim().min(1, 'invalid_value').max(200, 'invalid_value'),
  // For every domain rather than the one picked in the dashboard.
  shared: z.boolean().default(false),
})

export const blockRuleRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const d = c.var.domain
    const items = await c.var.db
      .select()
      .from(blockRule)
      .where(d ? or(eq(blockRule.domainId, d.id), isNull(blockRule.domainId)) : undefined)
      .orderBy(desc(blockRule.id))
    return c.json({ items })
  })
  .post('/', validate('json', input), async (c) => {
    const { kind, value: raw, shared } = c.req.valid('json')
    const value = kind === 'address' ? bareAddress(raw) : kind === 'domain' ? (raw.includes('@') ? domainOf(raw) : raw.toLowerCase()) : raw.toLowerCase()
    if (kind === 'address' && !/^[^@\s]+@[^@\s]+$/.test(value)) return c.json({ error: 'invalid_value' }, 400)
    if (kind === 'domain' && !isDomainName(value)) return c.json({ error: 'invalid_value' }, 400)
    if (kind === 'keyword' && value.length < 3) return c.json({ error: 'invalid_value' }, 400)
    const domainId = shared ? null : (c.var.domain?.id ?? null)
    const db = c.var.db
    // The same rule twice does nothing more.
    const rules = await db.select().from(blockRule)
    const same = rules.find((r) => r.kind === kind && r.value === value && r.domainId === domainId)
    if (same) return c.json({ id: same.id })
    const [row] = await db.insert(blockRule).values({ kind, value, domainId }).returning({ id: blockRule.id })
    return c.json({ id: row!.id })
  })
  .delete('/:id', validate('param', idParam), async (c) => {
    await c.var.db.delete(blockRule).where(eq(blockRule.id, c.req.valid('param').id))
    return c.json({ ok: true })
  })
