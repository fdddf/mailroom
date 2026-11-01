// Sign-up forms for outside websites (routes/subscribe.ts takes their
// submissions). The Turnstile secret goes in and never comes back out.

import { and, desc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Db } from '../../db'
import { segment, subscribeForm } from '../../db/schema'
import type { AppEnv } from '../../env'
import { encryptSecret, randomToken } from '../../lib/crypto'
import { normalizeOrigin, turnstileSecretAccepted } from '../../lib/subscribe'
import { validate } from '../../lib/validate'
import { domainRequired, idParam, inDomain } from './shared'

const origins = z
  .array(z.string().max(300, 'invalid_origin'))
  .min(1, 'origin_required')
  .max(20, 'invalid_origin')
  .transform((list, ctx) => {
    const normal = list.map(normalizeOrigin)
    if (normal.includes(null)) ctx.addIssue({ code: 'custom', message: 'invalid_origin' })
    return [...new Set(normal.filter((o): o is string => o !== null))]
  })

const fields = {
  name: z.string().trim().min(1, 'invalid_name').max(100, 'invalid_name'),
  segmentId: z.coerce.number({ error: 'unknown_segment' }).int('unknown_segment').positive('unknown_segment'),
  allowedOrigins: origins,
  turnstileSiteKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{10,100}$/, 'invalid_site_key'),
  turnstileSecret: z
    .string()
    .trim()
    .regex(/^\S{10,200}$/, 'invalid_secret'),
}

const segmentInDomain = (db: Db, segmentId: number, domainId: number) =>
  db.query.segment.findFirst({ columns: { id: true }, where: and(eq(segment.id, segmentId), eq(segment.domainId, domainId)) })

export const formRoutes = new Hono<AppEnv>()
  // With who is still to confirm.
  .get('/', async (c) => {
    const rows = await c.var.db
      .select({
        id: subscribeForm.id,
        publicId: subscribeForm.publicId,
        name: subscribeForm.name,
        segmentId: subscribeForm.segmentId,
        segmentName: segment.name,
        allowedOrigins: subscribeForm.allowedOrigins,
        turnstileSiteKey: subscribeForm.turnstileSiteKey,
        enabled: subscribeForm.enabled,
        lastError: subscribeForm.lastError,
        lastErrorAt: subscribeForm.lastErrorAt,
        createdAt: subscribeForm.createdAt,
        pending: sql<number>`(SELECT COUNT(*) FROM pending_subscription p WHERE p.form_id = "subscribe_form"."id")`,
      })
      .from(subscribeForm)
      .leftJoin(segment, eq(segment.id, subscribeForm.segmentId))
      .where(inDomain(c, subscribeForm.domainId))
      .orderBy(desc(subscribeForm.id))
    return c.json({ items: rows })
  })

  .post('/', validate('json', z.object(fields)), async (c) => {
    const d = c.var.domain
    if (!d) return domainRequired(c)
    const { turnstileSecret, ...b } = c.req.valid('json')
    const db = c.var.db
    if (!(await segmentInDomain(db, b.segmentId, d.id))) return c.json({ error: 'unknown_segment' }, 400)
    if (!(await turnstileSecretAccepted(turnstileSecret))) return c.json({ error: 'turnstile_secret_rejected' }, 400)
    const [row] = await db
      .insert(subscribeForm)
      .values({ ...b, domainId: d.id, publicId: `sf_${randomToken(12)}`, turnstileSecret: await encryptSecret(c.env.ADMIN_PASSWORD!, turnstileSecret) })
      .returning({ id: subscribeForm.id, publicId: subscribeForm.publicId })
    return c.json(row!)
  })

  // Any change also clears the last error: it may just have been fixed.
  .patch(
    '/:id',
    validate('param', idParam),
    validate(
      'json',
      z
        .object({ ...fields, enabled: z.boolean() })
        .partial()
        .refine((v) => Object.keys(v).length > 0, 'nothing_to_update'),
    ),
    async (c) => {
      const { id } = c.req.valid('param')
      const { turnstileSecret, ...b } = c.req.valid('json')
      const db = c.var.db
      const form = await db.query.subscribeForm.findFirst({ columns: { domainId: true }, where: eq(subscribeForm.id, id) })
      if (!form) return c.json({ error: 'not_found' }, 404)
      if (b.segmentId && !(await segmentInDomain(db, b.segmentId, form.domainId))) return c.json({ error: 'unknown_segment' }, 400)
      if (turnstileSecret && !(await turnstileSecretAccepted(turnstileSecret))) return c.json({ error: 'turnstile_secret_rejected' }, 400)
      await db
        .update(subscribeForm)
        .set({ ...b, ...(turnstileSecret && { turnstileSecret: await encryptSecret(c.env.ADMIN_PASSWORD!, turnstileSecret) }), lastError: '', lastErrorAt: null })
        .where(eq(subscribeForm.id, id))
      return c.json({ ok: true })
    },
  )

  // People who have not confirmed yet go with it: their links stop working.
  .delete('/:id', validate('param', idParam), async (c) => {
    await c.var.db.delete(subscribeForm).where(eq(subscribeForm.id, c.req.valid('param').id))
    return c.json({ ok: true })
  })
