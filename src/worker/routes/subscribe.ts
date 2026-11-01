// Public sign-up forms, for websites with no server of their own:
//
//   POST /subscribe/<public id>   a form, or fetch from an allowed website
//   GET, POST /c/<token>          the link in the confirmation email
//
// A submission needs an allowed Origin and a good Turnstile token, and only
// ever leads to one confirmation email. The person becomes a contact when they
// click its button; opening the link only asks, so that link scanners confirm
// nobody. The answer never tells whether an address is already on the list.

import { and, count, eq, gt, lt } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { getDb } from '../db'
import { contact, contactSegment, domain, pendingSubscription, subscribeForm, type SubscribeForm } from '../db/schema'
import type { AppEnv } from '../env'
import { newToken } from '../lib/broadcast'
import { decryptSecret, sha256Hex } from '../lib/crypto'
import { emailConfigured, resolveSender, sendMail } from '../lib/mailer'
import { confirmationEmail, confirmUrl, isLocalOrigin, verifyTurnstile } from '../lib/subscribe'
import { isEmail } from '../lib/text'
import { upsertContact } from './admin/marketing'
import { escapeHtml, page } from './public'

const TOKEN = /^[0-9a-f]{20,64}$/
const LINK_DAYS = 7
// One confirmation email per address per this long, whoever asks for it.
const RESEND_MINUTES = 10
// Unconfirmed submissions from one IP address per hour.
const MAX_PER_IP = 10

const HOUR = 60 * 60 * 1000

const submission = z.object({
  email: z.string({ error: 'invalid_email' }).trim().toLowerCase().max(254, 'invalid_email').refine(isEmail, 'invalid_email'),
  firstName: z.string().trim().max(100).default(''),
  lastName: z.string().trim().max(100).default(''),
  'cf-turnstile-response': z.string({ error: 'turnstile_failed' }).min(1, 'turnstile_failed'),
})

const MESSAGES = {
  invalid_email: ['That email address is not valid', 'Go back and check it.'],
  invalid_request: ['That did not work', 'Go back and check the form.'],
  turnstile_failed: ['We could not verify you', 'Reload the form and try again.'],
  rate_limited: ['Too many sign-ups', 'Please try again in an hour.'],
  form_unavailable: ['Sign-up is not available right now', 'Please try again later.'],
  origin_not_allowed: ['Sign-up is not available here', 'This form is not set up for this website.'],
} as const
type Refusal = keyof typeof MESSAGES

// A plain form gets a page to land on; fetch gets JSON.
const wantsPage = (c: Context<AppEnv>) => (c.req.header('Accept') || '').includes('text/html')

const refuse = (c: Context<AppEnv>, code: Refusal, status: 400 | 403 | 413 | 429 | 503) => {
  if (!wantsPage(c)) return c.json({ error: code }, status)
  const [title, text] = MESSAGES[code]
  return c.html(page(title, '', `<p>${escapeHtml(text)}</p>`), status)
}

const noteError = (db: AppEnv['Variables']['db'], form: SubscribeForm, message: string) => {
  console.error(`subscribe form ${form.publicId}: ${message}`)
  return db.update(subscribeForm).set({ lastError: message.slice(0, 500), lastErrorAt: new Date().toISOString() }).where(eq(subscribeForm.id, form.id))
}

const findForm = async (db: AppEnv['Variables']['db'], publicId: string) => (await db.query.subscribeForm.findFirst({ where: eq(subscribeForm.publicId, publicId) })) ?? null

const readBody = async (c: Context<AppEnv>): Promise<unknown> => ((c.req.header('Content-Type') || '').includes('application/json') ? c.req.json().catch(() => null) : c.req.parseBody().catch(() => null))

const pendingByToken = async (db: AppEnv['Variables']['db'], token: string) => {
  const [row] = await db
    .select({ pending: pendingSubscription, form: subscribeForm, brand: domain.brand, domainName: domain.name })
    .from(pendingSubscription)
    .innerJoin(subscribeForm, eq(subscribeForm.id, pendingSubscription.formId))
    .innerJoin(domain, eq(domain.id, pendingSubscription.domainId))
    .where(and(eq(pendingSubscription.tokenHash, await sha256Hex(token)), gt(pendingSubscription.expiresAt, new Date().toISOString())))
  return row ?? null
}

const LINK_GONE = page('This link is no longer valid', '', '<p>If you already confirmed, you are all set. Otherwise it may have expired: sign up again to get a new one.</p>')

export const subscribeRoutes = new Hono<AppEnv>()
  // A fetch that sends JSON asks first.
  .options('/subscribe/:publicId', async (c) => {
    const form = await findForm(getDb(c.env.DB), c.req.param('publicId'))
    const origin = c.req.header('Origin') || ''
    c.header('Vary', 'Origin')
    if (!form?.allowedOrigins.includes(origin)) return c.body(null, 403)
    c.header('Access-Control-Allow-Origin', origin)
    c.header('Access-Control-Allow-Methods', 'POST')
    c.header('Access-Control-Allow-Headers', 'Content-Type')
    c.header('Access-Control-Max-Age', '600')
    return c.body(null, 204)
  })

  .post(
    '/subscribe/:publicId',
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'invalid_request' }, 413) }),
    async (c) => {
      const db = getDb(c.env.DB)
      const form = await findForm(db, c.req.param('publicId'))
      const origin = c.req.header('Origin') || ''
      c.header('Vary', 'Origin')
      if (!form) return c.json({ error: 'not_found' }, 404)
      if (!form.allowedOrigins.includes(origin)) return refuse(c, 'origin_not_allowed', 403)
      c.header('Access-Control-Allow-Origin', origin)
      if (!form.enabled || !form.segmentId) return refuse(c, 'form_unavailable', 503)

      const parsed = submission.safeParse(await readBody(c))
      if (!parsed.success) {
        const code = parsed.error.issues[0]?.message
        return refuse(c, code === 'invalid_email' || code === 'turnstile_failed' ? code : 'invalid_request', 400)
      }
      const { email, firstName, lastName, 'cf-turnstile-response': token } = parsed.data
      const ip = c.req.header('CF-Connecting-IP') || ''

      const secret = await decryptSecret(c.env.ADMIN_PASSWORD ?? '', form.turnstileSecret)
      if (!secret) {
        await noteError(db, form, 'The Turnstile secret key cannot be read (the admin password changed since). Enter it again.')
        return refuse(c, 'form_unavailable', 503)
      }
      const check = await verifyTurnstile(secret, token, {
        ip,
        hostnames: form.allowedOrigins.map((o) => new URL(o).hostname),
        allowTestKeys: isLocalOrigin(origin),
      })
      if (check === 'bad_secret') {
        await noteError(db, form, 'Cloudflare refused the Turnstile secret key. Enter it again.')
        return refuse(c, 'form_unavailable', 503)
      }
      if (check !== 'ok') return refuse(c, 'turnstile_failed', 403)

      const now = new Date()
      if (ip) {
        const since = new Date(now.getTime() - HOUR).toISOString()
        const [recent] = await db
          .select({ n: count() })
          .from(pendingSubscription)
          .where(and(eq(pendingSubscription.ip, ip), gt(pendingSubscription.lastSentAt, since)))
        if ((recent?.n ?? 0) >= MAX_PER_IP) return refuse(c, 'rate_limited', 429)
      }

      const sender = emailConfigured(c.env) ? await resolveSender(db, { domainId: form.domainId }) : null
      if (!sender) {
        await noteError(db, form, emailConfigured(c.env) ? 'This domain has no mailbox to send the confirmation email from.' : 'Sending is not set up on this deployment.')
        return refuse(c, 'form_unavailable', 503)
      }

      // Everything from here answers the same, so the form cannot be used to
      // find out who is on the list.
      const accepted = () => {
        if (!wantsPage(c)) return c.json({ ok: true })
        return c.html(page('Check your inbox', '', '<p>We sent you an email with a link to confirm your subscription.</p>'))
      }

      const [already] = await db
        .select({ id: contact.id })
        .from(contact)
        .innerJoin(contactSegment, eq(contactSegment.contactId, contact.id))
        .where(and(eq(contact.domainId, form.domainId), eq(contact.email, email), eq(contact.unsubscribed, false), eq(contactSegment.segmentId, form.segmentId)))
      if (already) return accepted()

      const link = newToken()
      const values = {
        formId: form.id,
        firstName,
        lastName,
        tokenHash: await sha256Hex(link),
        ip,
        lastSentAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + LINK_DAYS * 24 * HOUR).toISOString(),
      }
      // Atomic, so that repeated submissions cannot flood somebody's inbox.
      const [claimed] = await db
        .insert(pendingSubscription)
        .values({ ...values, domainId: form.domainId, email })
        .onConflictDoUpdate({
          target: [pendingSubscription.domainId, pendingSubscription.email],
          set: values,
          setWhere: lt(pendingSubscription.lastSentAt, new Date(now.getTime() - RESEND_MINUTES * 60_000).toISOString()),
        })
        .returning({ id: pendingSubscription.id })
      if (!claimed) return accepted()

      // After the answer: how long sending takes must not tell anything either.
      c.executionCtx.waitUntil(
        (async () => {
          const own = await db.query.domain.findFirst({ columns: { brand: true, name: true }, where: eq(domain.id, form.domainId) })
          const publicUrl = c.env.PUBLIC_URL || new URL(c.req.url).origin
          const sent = await sendMail(c.env, db, {
            domainId: form.domainId,
            to: [email],
            ...confirmationEmail(own?.brand || own?.name || '', confirmUrl(publicUrl, link)),
            source: 'subscribe',
            record: false,
          })
          if (sent.ok) {
            if (form.lastError) await db.update(subscribeForm).set({ lastError: '', lastErrorAt: null }).where(eq(subscribeForm.id, form.id))
          } else {
            // So that they can try again right away.
            await db.delete(pendingSubscription).where(eq(pendingSubscription.id, claimed.id))
            await noteError(db, form, `The confirmation email could not be sent: ${sent.message ?? sent.error}`)
          }
        })().catch((err) => console.error('confirmation email failed', err)),
      )
      return accepted()
    },
  )

  .get('/c/:token', async (c) => {
    const token = c.req.param('token')
    const row = TOKEN.test(token) ? await pendingByToken(getDb(c.env.DB), token) : null
    if (!row) return c.html(LINK_GONE, 404)
    const brand = row.brand || row.domainName
    return c.html(
      page(
        `Subscribe to ${brand}?`,
        brand,
        `<p>${escapeHtml(row.pending.email)} will get emails from ${escapeHtml(brand)}. You can unsubscribe at any time.</p><form method="post" action="/c/${token}"><button>Confirm subscription</button></form>`,
      ),
    )
  })

  .post('/c/:token', async (c) => {
    const token = c.req.param('token')
    const db = getDb(c.env.DB)
    const row = TOKEN.test(token) ? await pendingByToken(db, token) : null
    if (!row) return c.html(LINK_GONE, 404)
    const { pending, form } = row
    const added = await upsertContact(db, pending.domainId, { email: pending.email, firstName: pending.firstName, lastName: pending.lastName })
    // Their own click, from their own inbox: this also undoes an earlier unsubscribe.
    await db.update(contact).set({ unsubscribed: false, confirmedAt: new Date().toISOString() }).where(eq(contact.id, added.id))
    if (form.segmentId) await db.insert(contactSegment).values({ contactId: added.id, segmentId: form.segmentId }).onConflictDoNothing()
    // Last: if anything above fails, the link still works.
    await db.delete(pendingSubscription).where(eq(pendingSubscription.id, pending.id))
    const brand = row.brand || row.domainName
    return c.html(page('You are subscribed', brand, `<p>Thanks for confirming. You will now get emails from ${escapeHtml(brand)}.</p>`))
  })
