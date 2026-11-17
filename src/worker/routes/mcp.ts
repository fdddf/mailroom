// /mcp — a Model Context Protocol server, so an AI assistant (Claude Code,
// or any MCP client that can send a header) can work with one of our
// domains: add contacts, write and send broadcasts, send an email.
//
// It takes the same API keys as /v1 (Authorization: Bearer mr_…), or an
// OAuth access token from an app approved for a domain (routes/oauth.ts),
// for clients that can only sign in (ChatGPT, claude.ai). Either is good for
// one domain; each tool needs the scope noted on it, and a caller only sees
// the tools it may use. Streamable HTTP, stateless: every POST is answered on
// its own, with JSON. Reference: docs/mcp.md.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js'
import { and, asc, desc, eq, like, lt, sql, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import { BODY_FORMATS, broadcast, broadcastRecipient, contact, mailbox, segment, type ApiScope, type Broadcast, type Domain } from '../db/schema'
import type { AppEnv, Env } from '../env'
import { cancelBroadcast, queueBroadcast, sendTestBroadcast, subscriberCount } from '../lib/broadcast'
import { ensureSegments, importContacts, segmentNamesOf } from '../lib/contacts'
import { emailConfigured, resolveSender, sendMail } from '../lib/mailer'
import { htmlToText, isEmail, parseAddressList } from '../lib/text'
import { getDb } from '../db'
import { oauthGrant } from '../db/schema'
import { verifyAccessToken, wwwAuthenticate } from '../lib/oauth'
import { API_KEY, findApiKey } from './v1'

const MAX_ADD = 1000

// Who is calling: an API key, or an app signed in with OAuth.
type Caller = AppEnv['Variables']['caller']
type Ctx = { env: Env; db: AppEnv['Variables']['db']; domain: Domain; key: Caller; origin: string }

const INSTRUCTIONS = `Mailroom: email for one domain (the API key's). Call get_domain first to see the domain, its mailboxes and what this key may do.

Bulk email goes out as a broadcast, never as many send_email calls: a broadcast sends each subscriber of a segment their own copy, with an unsubscribe link, and skips everyone who unsubscribed, bounced or complained.
1. add_contacts to put people in a segment (only people who agreed to receive this email).
2. create_broadcast for that segment: it is a draft and sends nothing.
3. send_test_broadcast to check it in a real inbox, and show the user the draft.
4. send_broadcast only once the user has approved this draft and the number of recipients.
send_email is for a single message (at most 50 recipients, who all see each other).`

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] })
const fail = (error: string, message?: string) => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error, ...(message && { message }) }) }] })

const emailArg = z.string().trim().toLowerCase().describe('Email address')
const broadcastId = z.number().int().positive().describe('The broadcast id')

const broadcastView = (b: Broadcast, segmentName: string | null) => ({
  id: b.id,
  name: b.name,
  status: b.status,
  segment: segmentName,
  from: b.fromAddr,
  subject: b.subject,
  previewText: b.previewText,
  format: b.format,
  createdAt: b.createdAt,
  scheduledAt: b.scheduledAt,
  sentAt: b.sentAt,
  total: b.total,
  sent: b.sent,
  failed: b.failed,
})

const findSegment = (x: Ctx, name: string) =>
  x.db.query.segment.findFirst({ where: and(eq(segment.domainId, x.domain.id), eq(segment.name, name.trim())) })

const findBroadcast = (x: Ctx, id: number) => x.db.query.broadcast.findFirst({ where: and(eq(broadcast.id, id), eq(broadcast.domainId, x.domain.id)) })

const segmentName = async (x: Ctx, id: number | null) => (id ? ((await x.db.query.segment.findFirst({ columns: { name: true }, where: eq(segment.id, id) }))?.name ?? null) : null)

const unknownSegment = async (x: Ctx, name: string) => {
  const names = (await x.db.select({ name: segment.name }).from(segment).where(eq(segment.domainId, x.domain.id))).map((s) => s.name)
  return fail('unknown_segment', `No segment "${name}" on ${x.domain.name}. Segments: ${names.length ? names.join(', ') : 'none yet (add_contacts makes them)'}`)
}

// The broadcast fields an assistant writes.
const draftFields = {
  subject: z.string().trim().min(1).max(300).describe('Subject line; placeholders work here too'),
  message: z
    .string()
    .trim()
    .min(1)
    .max(200_000)
    .describe(
      'The email. Placeholders: {{first_name}}, {{last_name}}, {{email}}, {{unsubscribe_url}}. An unsubscribe footer is added unless the message has {{unsubscribe_url}} itself.',
    ),
  format: z.enum(BODY_FORMATS).default('text').describe('"text" (HTML is made from it) or "html" (the text part is made from it)'),
  previewText: z.string().trim().max(200).default('').describe('Optional line that inboxes show after the subject'),
  from: z.string().trim().toLowerCase().optional().describe("One of the domain's mailboxes (see get_domain); the default mailbox when left out"),
  name: z.string().trim().max(200).optional().describe('Name in the dashboard; the subject when left out'),
}

// Which OAuth scope a tool needs, as ChatGPT reads it from the tool list.
const oauthScope = (scope?: ApiScope) => ({ securitySchemes: [{ type: 'oauth2', scopes: scope ? [scope] : [] }] })

const register = (server: McpServer, x: Ctx) => {
  const may = (scope: ApiScope) => x.key.scopes.includes(scope)

  server.registerTool(
    'get_domain',
    {
      title: 'Domain',
      _meta: oauthScope(),
      description: "The domain this key is for, its mailboxes (senders), its segments with how many subscribed contacts each has, and the key's scopes.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const boxes = await x.db.select({ address: mailbox.address, name: mailbox.name, isDefault: mailbox.isDefault }).from(mailbox).where(eq(mailbox.domainId, x.domain.id))
      return text({
        domain: x.domain.name,
        brand: x.domain.brand,
        scopes: x.key.scopes,
        emailSending: emailConfigured(x.env),
        mailboxes: boxes,
        segments: may('contacts') || may('broadcasts') ? await segmentsOf(x) : undefined,
      })
    },
  )

  if (may('contacts')) {
    server.registerTool(
      'list_segments',
      { _meta: oauthScope('contacts'), title: 'Segments', description: 'Segments (lists) of the domain, with how many subscribed contacts each has.', annotations: { readOnlyHint: true } },
      async () => text(await segmentsOf(x)),
    )

    server.registerTool(
      'add_contacts',
      {
        title: 'Add contacts',
        _meta: oauthScope('contacts'),
        description: `Add up to ${MAX_ADD} contacts at once and put them all in the given segments (missing segments are made). Only add people who agreed to receive email from this domain. Someone already on file gets the names given and the segments, but keeps their subscription: an unsubscribed contact stays unsubscribed. Invalid addresses are skipped and listed.`,
        inputSchema: {
          contacts: z
            .array(z.object({ email: z.string().describe('Email address'), firstName: z.string().trim().max(100).optional(), lastName: z.string().trim().max(100).optional() }))
            .min(1)
            .max(MAX_ADD),
          segments: z.array(z.string().trim().min(1).max(100)).max(20).default([]).describe('Segment names, e.g. ["newsletter"]'),
        },
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      async ({ contacts, segments }) => {
        const valid = []
        const invalid = []
        for (const p of contacts) {
          const email = p.email.trim().toLowerCase()
          if (isEmail(email)) valid.push({ ...p, email })
          else invalid.push(p.email)
        }
        const ids = valid.length ? await ensureSegments(x.db, x.domain.id, segments) : []
        const result = valid.length ? await importContacts(x.db, x.domain.id, valid, ids, { fillNames: true }) : { added: 0, existing: 0 }
        return text({ ...result, invalid, segments })
      },
    )

    server.registerTool(
      'list_contacts',
      {
        title: 'List contacts',
        _meta: oauthScope('contacts'),
        description: 'Contacts of the domain, newest first, a page at a time: pass the returned `next` as `after` for the following page.',
        inputSchema: {
          segment: z.string().optional().describe('Only contacts in this segment'),
          status: z.enum(['all', 'subscribed', 'unsubscribed']).default('all'),
          search: z.string().trim().max(100).optional().describe('Part of the address or name'),
          after: z.number().int().positive().optional(),
          limit: z.number().int().min(1).max(200).default(50),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ segment: name, status, search, after, limit }) => {
        const where: (SQL | undefined)[] = [eq(contact.domainId, x.domain.id)]
        if (name) {
          const seg = await findSegment(x, name)
          if (!seg) return unknownSegment(x, name)
          where.push(sql`EXISTS (SELECT 1 FROM contact_segment cs WHERE cs.contact_id = ${contact.id} AND cs.segment_id = ${seg.id})`)
        }
        if (status !== 'all') where.push(eq(contact.unsubscribed, status === 'unsubscribed'))
        if (search) {
          const pattern = `%${search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
          where.push(sql`(${like(contact.email, pattern)} ESCAPE '\\' OR ${like(contact.firstName, pattern)} ESCAPE '\\' OR ${like(contact.lastName, pattern)} ESCAPE '\\')`)
        }
        if (after) where.push(lt(contact.id, after))
        const rows = await x.db
          .select({ id: contact.id, email: contact.email, firstName: contact.firstName, lastName: contact.lastName, unsubscribed: contact.unsubscribed, createdAt: contact.createdAt })
          .from(contact)
          .where(and(...where))
          .orderBy(desc(contact.id))
          .limit(limit + 1)
        const page = rows.slice(0, limit)
        return text({ contacts: page, next: rows.length > limit ? page.at(-1)!.id : null })
      },
    )

    server.registerTool(
      'get_contact',
      { _meta: oauthScope('contacts'), title: 'Contact', description: 'One contact, with their segments.', inputSchema: { email: emailArg }, annotations: { readOnlyHint: true } },
      async ({ email }) => {
        const row = await x.db.query.contact.findFirst({ where: and(eq(contact.domainId, x.domain.id), eq(contact.email, email)) })
        if (!row) return fail('not_found', `${email} is not a contact of ${x.domain.name}`)
        const { token: _, domainId: __, ...view } = row
        return text({ ...view, segments: await segmentNamesOf(x.db, row.id) })
      },
    )

    server.registerTool(
      'unsubscribe_contact',
      {
        title: 'Unsubscribe contact',
        _meta: oauthScope('contacts'),
        description: 'Mark a contact unsubscribed: broadcasts skip them from now on. They stay on file, so adding them again does not resubscribe them.',
        inputSchema: { email: emailArg },
        annotations: { destructiveHint: true, idempotentHint: true },
      },
      async ({ email }) => {
        const rows = await x.db
          .update(contact)
          .set({ unsubscribed: true })
          .where(and(eq(contact.domainId, x.domain.id), eq(contact.email, email)))
          .returning({ id: contact.id })
        return rows.length ? text({ ok: true, email }) : fail('not_found', `${email} is not a contact of ${x.domain.name}`)
      },
    )

    server.registerTool(
      'delete_contact',
      {
        title: 'Delete contact',
        _meta: oauthScope('contacts'),
        description:
          'Forget a contact entirely: their record, segments and unsubscribe status go, and cannot be restored. For test entries and data deletion requests. For someone who no longer wants email, use unsubscribe_contact instead: once deleted, nothing stops them being added back.',
        inputSchema: { email: emailArg },
        annotations: { destructiveHint: true, idempotentHint: true },
      },
      async ({ email }) => {
        const rows = await x.db
          .delete(contact)
          .where(and(eq(contact.domainId, x.domain.id), eq(contact.email, email)))
          .returning({ id: contact.id })
        return rows.length ? text({ ok: true, deleted: email }) : fail('not_found', `${email} is not a contact of ${x.domain.name}`)
      },
    )
  }

  if (may('send')) {
    const list = z.union([z.string(), z.array(z.string())]).optional()
    server.registerTool(
      'send_email',
      {
        title: 'Send an email',
        _meta: oauthScope('send'),
        description:
          'Send one email now, from an address on the domain. All recipients (50 at most) get the same email and see each other in To and Cc. For a mailing to a list of contacts use a broadcast instead (create_broadcast).',
        inputSchema: {
          from: z.string().trim().max(320).optional().describe('"Name <a@domain>" or an address on the domain; the default mailbox when left out'),
          to: list.describe('Address or list of addresses'),
          cc: list,
          bcc: list,
          replyTo: z.string().trim().optional(),
          subject: z.string().trim().min(1).max(998),
          text: z.string().max(400_000).optional().describe('Plain-text body'),
          html: z.string().max(900_000).optional().describe('HTML body; with only html, a text part is made from it'),
        },
        annotations: { destructiveHint: false, openWorldHint: true },
      },
      async (m) => {
        const [to, cc, bcc] = [m.to, m.cc, m.bcc].map((v) => parseAddressList(v ?? ''))
        if (!to || !cc || !bcc) return fail('invalid_recipient', 'An address in to, cc or bcc is not valid')
        const count = to.length + cc.length + bcc.length
        if (!count) return fail('invalid_to', 'Give at least one recipient')
        if (count > 50) return fail('too_many_recipients', 'At most 50 recipients; use a broadcast for a list')
        if (m.replyTo && !isEmail(m.replyTo)) return fail('invalid_reply_to')
        if (!m.text?.trim() && !m.html?.trim()) return fail('invalid_message', 'Give text or html')
        const sent = await sendMail(x.env, x.db, {
          from: m.from,
          domainId: x.domain.id,
          anyAddress: true,
          to,
          cc,
          bcc,
          replyTo: m.replyTo,
          subject: m.subject,
          text: m.text?.trim() ? m.text : htmlToText(m.html ?? ''),
          html: m.html?.trim() ? m.html : undefined,
          source: `mcp:${x.key.name}`,
        })
        return sent.ok ? text({ id: sent.mailId, messageId: sent.messageId }) : fail(sent.error, sent.message)
      },
    )
  }

  if (may('broadcasts')) {
    server.registerTool(
      'list_broadcasts',
      { _meta: oauthScope('broadcasts'), title: 'Broadcasts', description: 'The domain’s latest 50 broadcasts, newest first, with their status and progress.', annotations: { readOnlyHint: true } },
      async () => {
        const rows = await x.db
          .select({ b: broadcast, segment: segment.name })
          .from(broadcast)
          .leftJoin(segment, eq(segment.id, broadcast.segmentId))
          .where(eq(broadcast.domainId, x.domain.id))
          .orderBy(desc(broadcast.id))
          .limit(50)
        return text(rows.map((r) => broadcastView(r.b, r.segment)))
      },
    )

    server.registerTool(
      'get_broadcast',
      {
        title: 'Broadcast',
        _meta: oauthScope('broadcasts'),
        description:
          'One broadcast: its message as written, status (draft, queued, sending, sent, canceled), how many it went to so far, and the first failures. Recipients is how many subscribers its segment has now.',
        inputSchema: { id: broadcastId },
        annotations: { readOnlyHint: true },
      },
      async ({ id }) => {
        const row = await findBroadcast(x, id)
        if (!row) return fail('not_found', `No broadcast ${id} on ${x.domain.name}`)
        const failures = await x.db
          .select({ email: broadcastRecipient.email, error: broadcastRecipient.error })
          .from(broadcastRecipient)
          .where(and(eq(broadcastRecipient.broadcastId, id), eq(broadcastRecipient.status, 'failed')))
          .limit(20)
        return text({
          ...broadcastView(row, await segmentName(x, row.segmentId)),
          message: row.message,
          recipients: row.segmentId ? await subscriberCount(x.db, row.segmentId) : 0,
          failures,
        })
      },
    )

    server.registerTool(
      'create_broadcast',
      {
        title: 'Create a broadcast draft',
        _meta: oauthScope('broadcasts'),
        description:
          'Write a broadcast to the subscribed contacts of a segment. It is saved as a draft and sends nothing; the answer says how many it would reach. Check it with send_test_broadcast, and send it with send_broadcast once the user has approved it.',
        inputSchema: { segment: z.string().trim().min(1).describe('Segment name (see list_segments)'), ...draftFields },
        annotations: { destructiveHint: false },
      },
      async ({ segment: name, from, ...b }) => {
        const seg = await findSegment(x, name)
        if (!seg) return unknownSegment(x, name)
        const sender = await resolveSender(x.db, { address: from, domainId: x.domain.id })
        if (!sender) return fail(from ? 'unknown_sender' : 'no_mailbox', from ? `${from} is not a mailbox of ${x.domain.name}` : `${x.domain.name} has no mailbox to send from`)
        const [row] = await x.db
          .insert(broadcast)
          .values({ ...b, name: b.name || b.subject, domainId: x.domain.id, segmentId: seg.id, fromAddr: sender.email })
          .returning()
        return text({ ...broadcastView(row!, seg.name), recipients: await subscriberCount(x.db, seg.id) })
      },
    )

    server.registerTool(
      'update_broadcast',
      {
        title: 'Change a broadcast draft',
        _meta: oauthScope('broadcasts'),
        description: 'Change fields of a draft; the others stay as they are. Only drafts can change (cancel_broadcast turns a queued one back into a draft).',
        inputSchema: {
          id: broadcastId,
          segment: z.string().trim().min(1).optional().describe('Segment name'),
          ...Object.fromEntries(Object.entries(draftFields).map(([k, v]) => [k, v.optional()])),
        } as { id: typeof broadcastId; segment: z.ZodOptional<z.ZodString> } & { [K in keyof typeof draftFields]: z.ZodOptional<(typeof draftFields)[K]> },
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      async ({ id, segment: name, from, ...b }) => {
        const row = await findBroadcast(x, id)
        if (!row) return fail('not_found', `No broadcast ${id} on ${x.domain.name}`)
        if (row.status !== 'draft') return fail('not_a_draft', `Broadcast ${id} is ${row.status}`)
        const seg = name ? await findSegment(x, name) : undefined
        if (name && !seg) return unknownSegment(x, name)
        const sender = from ? await resolveSender(x.db, { address: from, domainId: x.domain.id }) : undefined
        if (from && !sender) return fail('unknown_sender', `${from} is not a mailbox of ${x.domain.name}`)
        const set = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined))
        const [updated] = await x.db
          .update(broadcast)
          .set({ ...set, ...(seg && { segmentId: seg.id }), ...(sender && { fromAddr: sender.email }), ...(b.subject && !b.name && row.name === row.subject && { name: b.subject }) })
          .where(and(eq(broadcast.id, id), eq(broadcast.status, 'draft')))
          .returning()
        if (!updated) return fail('not_a_draft', `Broadcast ${id} is no longer a draft`)
        return text({
          ...broadcastView(updated, await segmentName(x, updated.segmentId)),
          recipients: updated.segmentId ? await subscriberCount(x.db, updated.segmentId) : 0,
        })
      },
    )

    server.registerTool(
      'send_test_broadcast',
      {
        title: 'Send a test of a broadcast',
        _meta: oauthScope('broadcasts'),
        description: 'Send one copy of a broadcast to a single address (default: its sender), with sample names in the placeholders and "[Test]" before the subject. Not counted as sent.',
        inputSchema: { id: broadcastId, to: z.string().trim().optional().describe('Where to send the test; the broadcast’s sender when left out') },
        annotations: { destructiveHint: false, openWorldHint: true },
      },
      async ({ id, to }) => {
        const row = await findBroadcast(x, id)
        if (!row) return fail('not_found', `No broadcast ${id} on ${x.domain.name}`)
        const sent = await sendTestBroadcast(x.env, x.db, row, { from: row.fromAddr || undefined, domainId: x.domain.id, to, source: `mcp:${x.key.name}` })
        return sent.ok ? text({ ok: true, to: sent.to }) : fail(sent.error, 'message' in sent ? sent.message : undefined)
      },
    )

    server.registerTool(
      'send_broadcast',
      {
        title: 'Send a broadcast',
        _meta: oauthScope('broadcasts'),
        description:
          'Queue a draft to go out to every subscribed contact of its segment, now or at `scheduledAt`. This emails real people and cannot be undone once they have it: call it only after the user has approved this draft and its number of recipients. `expectedRecipients` must equal the current count (from create_broadcast or get_broadcast); if the segment changed, the call is refused with the new count. It goes out within a minute, a batch at a time; follow it with get_broadcast.',
        inputSchema: {
          id: broadcastId,
          expectedRecipients: z.number().int().positive().describe('How many subscribers the user approved sending to'),
          scheduledAt: z.iso.datetime({ offset: true }).optional().describe('ISO 8601 time to send at, e.g. 2026-12-01T09:00:00+08:00; now when left out'),
        },
        annotations: { destructiveHint: true, openWorldHint: true },
      },
      async ({ id, expectedRecipients, scheduledAt }) => {
        if (!emailConfigured(x.env)) return fail('email_not_configured', 'Email Sending is not set up on this deployment')
        const row = await findBroadcast(x, id)
        if (!row) return fail('not_found', `No broadcast ${id} on ${x.domain.name}`)
        const now = row.segmentId ? await subscriberCount(x.db, row.segmentId) : 0
        if (row.status === 'draft' && now && now !== expectedRecipients)
          return fail('recipients_changed', `The segment now has ${now} subscribed contacts, not ${expectedRecipients}. Confirm the new number with the user before sending.`)
        // As the cron compares it: UTC, with milliseconds.
        const at = scheduledAt ? new Date(scheduledAt).toISOString() : undefined
        const queued = await queueBroadcast(x.db, row, at, x.env.PUBLIC_URL || x.origin)
        if (queued.error) return fail(queued.error, queued.error === 'not_a_draft' ? `Broadcast ${id} is ${row.status}` : undefined)
        return text({ id, status: 'queued', recipients: queued.recipients, scheduledAt: at ?? null })
      },
    )

    server.registerTool(
      'cancel_broadcast',
      {
        title: 'Cancel a broadcast',
        _meta: oauthScope('broadcasts'),
        description: 'A queued broadcast goes back to being a draft. One that is going out stops: whoever has not received it yet never will.',
        inputSchema: { id: broadcastId },
        annotations: { destructiveHint: true },
      },
      async ({ id }) => {
        if (!(await findBroadcast(x, id))) return fail('not_found', `No broadcast ${id} on ${x.domain.name}`)
        const done = await cancelBroadcast(x.db, id)
        return done ? text({ id, status: done.status }) : fail('not_cancelable', `Broadcast ${id} is neither queued nor sending`)
      },
    )
  }
}

const segmentsOf = async (x: Ctx) =>
  x.db
    .select({
      name: segment.name,
      // "segment"."id" is spelled out: Drizzle would write it as a bare "id", which in here is the contact's.
      subscribers: sql<number>`(SELECT COUNT(*) FROM contact_segment cs JOIN contact c ON c.id = cs.contact_id WHERE cs.segment_id = "segment"."id" AND c.unsubscribed = 0)`,
    })
    .from(segment)
    .where(eq(segment.domainId, x.domain.id))
    .orderBy(asc(segment.name))

// last_used_at of a grant is written at most this often.
const TOUCH_MS = 60_000

// An API key (mr_…) or an OAuth access token (mro_…). Without either, the
// 401 says where to sign in (RFC 9728), which is how an OAuth client starts.
const mcpAuth = createMiddleware<AppEnv>(async (c, next) => {
  const origin = new URL(c.req.url).origin
  const header = c.req.header('Authorization') || ''
  const token = header.match(/^Bearer\s+(\S+)$/i)?.[1]
  const db = getDb(c.env.DB)
  let caller: Caller | null = null
  if (token && API_KEY.test(`Bearer ${token}`)) {
    const row = await findApiKey(c, db, token)
    if (row) {
      c.set('domain', row.domain)
      caller = { name: row.key.name, scopes: row.key.scopes }
    }
  } else if (token) {
    const row = await verifyAccessToken(db, token)
    const own = row && (await db.query.domain.findFirst({ where: (d, { eq }) => eq(d.id, row.grant.domainId) }))
    if (row && own) {
      c.set('domain', own)
      caller = { name: row.clientName || 'oauth', scopes: row.grant.scopes }
      if (!row.grant.lastUsedAt || Date.now() - Date.parse(row.grant.lastUsedAt) > TOUCH_MS) {
        c.executionCtx.waitUntil(db.update(oauthGrant).set({ lastUsedAt: new Date().toISOString() }).where(eq(oauthGrant.id, row.grant.id)).then(() => {}))
      }
    }
  }
  if (!caller) {
    return c.json(
      { error: 'unauthorized', message: token ? 'Unknown, expired or revoked token' : 'Sign in with OAuth, or send an API key as Authorization: Bearer mr_…' },
      401,
      { 'WWW-Authenticate': wwwAuthenticate(origin, token ? 'invalid_token' : undefined) },
    )
  }
  c.set('db', db)
  c.set('caller', caller)
  return next()
})

// Without sessions there is no stream to open (GET) or end (DELETE).
const notAllowed = () => new Response(null, { status: 405, headers: { Allow: 'POST' } })

export const mcpRoutes = new Hono<AppEnv>()
  .get('/', notAllowed)
  .delete('/', notAllowed)
  .use(mcpAuth)
  .post('/', async (c) => {
    const server = new McpServer({ name: 'mailroom', version: '0.1.0' }, { instructions: INSTRUCTIONS, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() })
    register(server, { env: c.env, db: c.var.db, domain: c.var.domain!, key: c.var.caller, origin: new URL(c.req.url).origin })
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    return transport.handleRequest(c.req.raw)
  })
