// /api/admin/* — everything the dashboard talks to. All of it needs a valid
// session cookie except login/logout. The cookie is SameSite=Strict, and
// writes must be JSON, which a cross-site form cannot send without a CORS
// preflight.
//
// The dashboard says which domain it is looking at in the X-Mailroom-Domain
// header (a domain id; none for all of them); lists follow it, and new things
// are made in it (routes/admin/shared.ts).

import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import { getDb } from '../../db'
import { aiProvider, contact, domain, mail, mailbox } from '../../db/schema'
import type { AppEnv } from '../../env'
import { SESSION_COOKIE, SESSION_SECONDS, secretsMatch, signSession, verifySession } from '../../lib/crypto'
import { ATTACH_LIMIT } from '../../lib/files'
import { emailConfigured } from '../../lib/mailer'
import { emptyBody, validate } from '../../lib/validate'
import { aiRoutes } from './ai'
import { domainRoutes } from './domains'
import { fileRoutes } from './files'
import { formRoutes } from './forms'
import { mailRoutes, sentRoutes } from './mail'
import { mailboxRoutes } from './mailboxes'
import { broadcastRoutes, contactRoutes, segmentRoutes } from './marketing'
import { mediaRoutes } from './media'
import { inDomain } from './shared'
import { signatureRoutes } from './signatures'
import { templateRoutes } from './templates'

export const DOMAIN_HEADER = 'X-Mailroom-Domain'

const OPEN = new Set(['/api/admin/login', '/api/admin/logout'])
const cookieOptions = { path: '/api/admin', httpOnly: true, secure: true, sameSite: 'Strict' } as const

const guard = createMiddleware<AppEnv>(async (c, next) => {
  const password = c.env.ADMIN_PASSWORD
  if (!password) return c.json({ error: 'admin_not_configured' }, 503)

  if ((c.req.method === 'POST' || c.req.method === 'PATCH') && !(c.req.header('Content-Type') || '').includes('application/json')) {
    return c.json({ error: 'json_required' }, 415)
  }
  if (OPEN.has(c.req.path.replace(/\/$/, ''))) return next()

  if (!(await verifySession(password, getCookie(c, SESSION_COOKIE)))) return c.json({ error: 'unauthorized' }, 401)
  const db = getDb(c.env.DB)
  c.set('db', db)
  // An id that is not (or no longer) a domain means all of them.
  const id = Number(c.req.header(DOMAIN_HEADER))
  c.set('domain', id > 0 ? ((await db.query.domain.findFirst({ where: eq(domain.id, id) })) ?? null) : null)
  return next()
})

const unreadMail = and(eq(mail.direction, 'in'), eq(mail.archived, false), isNull(mail.readAt))

export const adminRoutes = new Hono<AppEnv>()
  .use(guard)

  .post('/login', validate('json', z.object({ password: z.string() })), async (c) => {
    const { password } = c.req.valid('json')
    if (!(await secretsMatch(password, c.env.ADMIN_PASSWORD!))) {
      // Slow down guessing a little; the real defence is a long password.
      await new Promise((resolve) => setTimeout(resolve, 800))
      return c.json({ error: 'wrong_password' }, 401)
    }
    const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS
    setCookie(c, SESSION_COOKIE, await signSession(c.env.ADMIN_PASSWORD!, expires), { ...cookieOptions, maxAge: SESSION_SECONDS })
    return c.json({ ok: true })
  })

  .post('/logout', emptyBody(), (c) => {
    deleteCookie(c, SESSION_COOKIE, cookieOptions)
    return c.json({ ok: true })
  })

  // What is configured, our domains and mailboxes, and the nav badge count.
  .get('/session', async (c) => {
    const db = c.var.db
    const [domains, mailboxes, aiProviders, [unread]] = await db.batch([
      db.select().from(domain).orderBy(asc(domain.name)),
      db.select().from(mailbox).orderBy(desc(mailbox.isDefault), asc(mailbox.address)),
      db.select({ id: aiProvider.id, name: aiProvider.name, isDefault: aiProvider.isDefault }).from(aiProvider).orderBy(desc(aiProvider.isDefault), asc(aiProvider.name)),
      db.select({ n: count() }).from(mail).where(and(unreadMail, inDomain(c, mail.domainId))),
    ])
    return c.json({
      ok: true,
      // Whether the send_email binding is there: without it nothing is sent.
      canEmail: emailConfigured(c.env),
      attachments: Boolean(c.env.BUCKET),
      // How much may go attached in one email; bigger files go as links.
      attachLimit: ATTACH_LIMIT,
      publicUrl: (c.env.PUBLIC_URL || new URL(c.req.url).origin).replace(/\/$/, ''),
      // The domain the dashboard is looking at, as the server understood it.
      domainId: c.var.domain?.id ?? null,
      domains,
      mailboxes,
      // The writing assistant is offered once there is one.
      aiProviders,
      counts: { mail: unread?.n ?? 0 },
    })
  })

  // Numbers and recent items for the overview page.
  .get('/stats', async (c) => {
    const db = c.var.db
    const since = (days: number) => sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`-${days} days`})`
    const scope = inDomain(c, mail.domainId)
    const [[counts], [subscribers], recentMail, perDomain] = await db.batch([
      db
        .select({
          unread: sql<number>`coalesce(sum(${unreadMail}), 0)`,
          received7: sql<number>`coalesce(sum(${mail.direction} = 'in' AND ${mail.createdAt} > ${since(7)}), 0)`,
          sent30: sql<number>`coalesce(sum(${mail.direction} = 'out' AND ${mail.createdAt} > ${since(30)}), 0)`,
        })
        .from(mail)
        .where(scope),
      db
        .select({ n: count() })
        .from(contact)
        .where(and(eq(contact.unsubscribed, false), inDomain(c, contact.domainId))),
      db
        .select({ id: mail.id, createdAt: mail.createdAt, fromAddr: mail.fromAddr, mailbox: mail.mailbox, subject: mail.subject })
        .from(mail)
        .where(and(unreadMail, scope))
        .orderBy(desc(mail.id))
        .limit(8),
      db
        .select({
          id: domain.id,
          name: domain.name,
          unread: sql<number>`(SELECT COUNT(*) FROM mail m WHERE m.domain_id = "domain"."id" AND m.direction = 'in' AND m.archived = 0 AND m.read_at IS NULL)`,
          mailboxes: sql<number>`(SELECT COUNT(*) FROM mailbox b WHERE b.domain_id = "domain"."id")`,
          lastReceived: sql<string | null>`(SELECT MAX(created_at) FROM mail m WHERE m.domain_id = "domain"."id" AND m.direction = 'in')`,
        })
        .from(domain)
        .orderBy(asc(domain.name)),
    ])
    return c.json({
      mail: { unread: counts?.unread ?? 0, receivedLast7Days: counts?.received7 ?? 0, sentLast30Days: counts?.sent30 ?? 0 },
      subscribers: subscribers?.n ?? 0,
      recentMail,
      domains: perDomain,
    })
  })

  .route('/domains', domainRoutes)
  .route('/mail', mailRoutes)
  .route('/sent', sentRoutes)
  .route('/mailboxes', mailboxRoutes)
  .route('/templates', templateRoutes)
  .route('/signatures', signatureRoutes)
  .route('/files', fileRoutes)
  .route('/ai', aiRoutes)
  .route('/media', mediaRoutes)
  .route('/contacts', contactRoutes)
  .route('/segments', segmentRoutes)
  .route('/forms', formRoutes)
  .route('/broadcasts', broadcastRoutes)
