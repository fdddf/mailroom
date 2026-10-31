// Our domains, and per domain: its settings, a check of its DNS, a test
// email, and what other systems use to work with it — API keys for /v1 and
// webhooks. Adding a domain here is the Mailroom side of onboarding it; the
// Cloudflare side is in docs/domains.md, and the dashboard shows both.

import { and, asc, count, desc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { API_SCOPES, WEBHOOK_EVENTS, apiKey, domain, mailbox, webhook, type ApiKey, type Webhook } from '../../db/schema'
import type { AppEnv } from '../../env'
import { newApiKey, randomToken } from '../../lib/crypto'
import { checkDomain } from '../../lib/dns'
import { sendMail } from '../../lib/mailer'
import { isDomainName, isEmail } from '../../lib/text'
import { emptyBody, validate } from '../../lib/validate'
import { deliverWebhook } from '../../lib/webhooks'
import { idParam } from './shared'

const settings = z.object({
  brand: z.string().trim().max(100, 'too_long'),
  catchAll: z.boolean(),
  footer: z.string().trim().max(300, 'too_long'),
  about: z.string().trim().max(2000, 'too_long'),
})

const localPart = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => !v || /^[a-z0-9._+-]{1,64}$/.test(v), 'invalid_email')

const hookUrl = z
  .string()
  .trim()
  .max(500, 'too_long')
  .refine((v) => /^https:\/\/[^\s]+$/.test(v), 'invalid_url')

const keyParam = idParam.extend({ keyId: z.coerce.number().int().positive() })
const hookParam = idParam.extend({ hookId: z.coerce.number().int().positive() })

// The key itself is never kept; the secret is shown, since the receiver needs it.
const keyView = ({ hash, ...k }: ApiKey) => k
const hookView = (h: Webhook) => h

export const domainRoutes = new Hono<AppEnv>()
  // With how much each has.
  .get('/', async (c) => {
    const rows = await c.var.db
      .select({
        id: domain.id,
        name: domain.name,
        brand: domain.brand,
        catchAll: domain.catchAll,
        createdAt: domain.createdAt,
        mailboxes: sql<number>`(SELECT COUNT(*) FROM mailbox x WHERE x.domain_id = "domain"."id")`,
        contacts: sql<number>`(SELECT COUNT(*) FROM contact x WHERE x.domain_id = "domain"."id" AND x.unsubscribed = 0)`,
        received: sql<number>`(SELECT COUNT(*) FROM mail x WHERE x.domain_id = "domain"."id" AND x.direction = 'in')`,
        sent: sql<number>`(SELECT COUNT(*) FROM mail x WHERE x.domain_id = "domain"."id" AND x.direction = 'out')`,
        apiKeys: sql<number>`(SELECT COUNT(*) FROM api_key x WHERE x.domain_id = "domain"."id")`,
        webhooks: sql<number>`(SELECT COUNT(*) FROM webhook x WHERE x.domain_id = "domain"."id")`,
      })
      .from(domain)
      .orderBy(asc(domain.name))
    return c.json({ items: rows })
  })

  // A new domain, and optionally its first mailbox (the local part, e.g. "hello").
  .post(
    '/',
    validate(
      'json',
      z.object({
        name: z
          .string()
          .trim()
          .toLowerCase()
          .transform((v) => v.replace(/^https?:\/\//, '').replace(/[/.]+$/, ''))
          .refine(isDomainName, 'invalid_domain'),
        brand: z.string().trim().max(100, 'too_long').default(''),
        mailbox: localPart.default(''),
      }),
    ),
    async (c) => {
      const { name, brand, mailbox: local } = c.req.valid('json')
      const db = c.var.db
      const [row] = await db.insert(domain).values({ name, brand }).onConflictDoNothing({ target: domain.name }).returning()
      if (!row) return c.json({ error: 'domain_exists' }, 409)
      if (local) await db.insert(mailbox).values({ domainId: row.id, address: `${local}@${name}`, name: brand, isDefault: true }).onConflictDoNothing()
      return c.json(row)
    },
  )

  .get('/:id', validate('param', idParam), async (c) => {
    const row = await c.var.db.query.domain.findFirst({ where: eq(domain.id, c.req.valid('param').id) })
    return row ? c.json(row) : c.json({ error: 'not_found' }, 404)
  })

  .patch('/:id', validate('param', idParam), validate('json', settings.partial().refine((v) => Object.keys(v).length > 0, 'nothing_to_update')), async (c) => {
    const rows = await c.var.db.update(domain).set(c.req.valid('json')).where(eq(domain.id, c.req.valid('param').id)).returning()
    return rows.length ? c.json(rows[0]!) : c.json({ error: 'not_found' }, 404)
  })

  // Everything of the domain goes with it: mailboxes, mail and its
  // attachments, contacts, broadcasts, templates, keys and webhooks.
  .delete('/:id', validate('param', idParam), async (c) => {
    const { id } = c.req.valid('param')
    const [gone] = await c.var.db.delete(domain).where(eq(domain.id, id)).returning({ id: domain.id })
    if (!gone) return c.json({ error: 'not_found' }, 404)
    const bucket = c.env.BUCKET
    if (bucket) {
      c.executionCtx.waitUntil(
        (async () => {
          for (let cursor: string | undefined, more = true; more; ) {
            const listed = await bucket.list({ prefix: `mail/${id}/`, cursor, limit: 1000 })
            if (listed.objects.length) await bucket.delete(listed.objects.map((o) => o.key))
            more = listed.truncated
            cursor = listed.truncated ? listed.cursor : undefined
          }
        })().catch((err) => console.error('attachment cleanup failed', err)),
      )
    }
    return c.json({ ok: true })
  })

  // Its public DNS, as the setup checklist shows it.
  .get('/:id/checks', validate('param', idParam), async (c) => {
    const row = await c.var.db.query.domain.findFirst({ columns: { name: true }, where: eq(domain.id, c.req.valid('param').id) })
    if (!row) return c.json({ error: 'not_found' }, 404)
    return c.json({ checks: await checkDomain(row.name) })
  })

  // A real email from the domain's default mailbox: the one sure test of sending.
  .post('/:id/test', validate('param', idParam), validate('json', z.object({ to: z.string().trim().toLowerCase().refine(isEmail, 'invalid_to') })), async (c) => {
    const { id } = c.req.valid('param')
    const row = await c.var.db.query.domain.findFirst({ where: eq(domain.id, id) })
    if (!row) return c.json({ error: 'not_found' }, 404)
    const sent = await sendMail(c.env, c.var.db, {
      domainId: id,
      to: [c.req.valid('json').to],
      subject: `Mailroom test from ${row.name}`,
      text: `This is a test email from ${row.brand || row.name}, sent by Mailroom to check that sending works.\n\nIf it reached your inbox (not spam), ${row.name} is ready to send.`,
      source: 'dashboard',
      record: false,
    })
    return sent.ok ? c.json({ ok: true }) : c.json({ error: sent.error, message: sent.message }, sent.status)
  })

  // ---- API keys ----

  .get('/:id/keys', validate('param', idParam), async (c) => {
    const rows = await c.var.db.select().from(apiKey).where(eq(apiKey.domainId, c.req.valid('param').id)).orderBy(desc(apiKey.id))
    return c.json({ items: rows.map(keyView) })
  })

  // The key is in this answer and nowhere else, ever.
  .post(
    '/:id/keys',
    validate('param', idParam),
    validate('json', z.object({ name: z.string().trim().min(1, 'invalid_name').max(60, 'invalid_name'), scopes: z.array(z.enum(API_SCOPES)).min(1, 'scope_required') })),
    async (c) => {
      const { id } = c.req.valid('param')
      const db = c.var.db
      if (!(await db.query.domain.findFirst({ columns: { id: true }, where: eq(domain.id, id) }))) return c.json({ error: 'not_found' }, 404)
      const { key, prefix, hash } = await newApiKey()
      const { name, scopes } = c.req.valid('json')
      const [row] = await db.insert(apiKey).values({ domainId: id, name, scopes: [...new Set(scopes)], prefix, hash }).returning()
      return c.json({ ...keyView(row!), key })
    },
  )

  .delete('/:id/keys/:keyId', validate('param', keyParam), async (c) => {
    const { id, keyId } = c.req.valid('param')
    const rows = await c.var.db.delete(apiKey).where(and(eq(apiKey.id, keyId), eq(apiKey.domainId, id))).returning({ id: apiKey.id })
    return rows.length ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
  })

  // ---- Webhooks ----

  .get('/:id/webhooks', validate('param', idParam), async (c) => {
    const rows = await c.var.db.select().from(webhook).where(eq(webhook.domainId, c.req.valid('param').id)).orderBy(asc(webhook.id))
    return c.json({ items: rows.map(hookView) })
  })

  .post(
    '/:id/webhooks',
    validate('param', idParam),
    validate('json', z.object({ url: hookUrl, events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'event_required') })),
    async (c) => {
      const { id } = c.req.valid('param')
      const db = c.var.db
      if (!(await db.query.domain.findFirst({ columns: { id: true }, where: eq(domain.id, id) }))) return c.json({ error: 'not_found' }, 404)
      const [{ n }] = await db.select({ n: count() }).from(webhook).where(eq(webhook.domainId, id))
      if (n >= 10) return c.json({ error: 'too_many_webhooks' }, 400)
      const { url, events } = c.req.valid('json')
      const [row] = await db
        .insert(webhook)
        .values({ domainId: id, url, events: [...new Set(events)], secret: `whsec_${randomToken(24)}` })
        .returning()
      return c.json(hookView(row!))
    },
  )

  .patch(
    '/:id/webhooks/:hookId',
    validate('param', hookParam),
    validate(
      'json',
      z
        .object({ url: hookUrl, events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'event_required'), enabled: z.boolean() })
        .partial()
        .refine((v) => Object.keys(v).length > 0, 'nothing_to_update'),
    ),
    async (c) => {
      const { id, hookId } = c.req.valid('param')
      const rows = await c.var.db
        .update(webhook)
        .set(c.req.valid('json'))
        .where(and(eq(webhook.id, hookId), eq(webhook.domainId, id)))
        .returning()
      return rows.length ? c.json(hookView(rows[0]!)) : c.json({ error: 'not_found' }, 404)
    },
  )

  .delete('/:id/webhooks/:hookId', validate('param', hookParam), async (c) => {
    const { id, hookId } = c.req.valid('param')
    const rows = await c.var.db.delete(webhook).where(and(eq(webhook.id, hookId), eq(webhook.domainId, id))).returning({ id: webhook.id })
    return rows.length ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
  })

  // A "ping" event, to check the receiver and its signature check.
  .post('/:id/webhooks/:hookId/test', validate('param', hookParam), emptyBody(), async (c) => {
    const { id, hookId } = c.req.valid('param')
    const db = c.var.db
    const hook = await db.query.webhook.findFirst({ where: and(eq(webhook.id, hookId), eq(webhook.domainId, id)) })
    if (!hook) return c.json({ error: 'not_found' }, 404)
    const row = await db.query.domain.findFirst({ columns: { name: true }, where: eq(domain.id, id) })
    const result = await deliverWebhook(db, hook, 'ping', { domain: row?.name })
    return c.json(result)
  })
