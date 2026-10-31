// D1 schema, the source of truth for Drizzle queries and for new migrations
// (`npm run db:generate` writes the SQL into migrations/, applied with
// `wrangler d1 migrations apply`).
//
// Everything except the AI providers belongs to a domain: its mailboxes, the
// mail sent and received at them, its contacts, segments and broadcasts, its
// API keys and webhooks. Templates can also be shared by every domain.

import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`

// A domain of ours. Sending needs it onboarded to Cloudflare Email Sending;
// receiving needs its Email Routing pointed at this Worker (docs/domains.md).
export const domain = sqliteTable('domain', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // Bare and lowercase: example.com
  name: text('name').notNull().unique(),
  // Who the mail is from, in words: the unsubscribe page, the broadcast
  // footer and the writing assistant use it.
  brand: text('brand').notNull().default(''),
  // Mail to an address with no mailbox is kept (true) or refused (false).
  catchAll: integer('catch_all', { mode: 'boolean' }).notNull().default(true),
  // Under every broadcast, before the unsubscribe link; empty for the default.
  footer: text('footer').notNull().default(''),
  // What the writing assistant should know about who writes these emails.
  about: text('about').notNull().default(''),
  createdAt: text('created_at').notNull().default(now),
})

export type Attachment = { id: string; filename: string | null; size: number; content_type: string }

// Our own addresses: what mail can be sent from, and what the inbox groups by.
export const mailbox = sqliteTable(
  'mailbox',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    domainId: integer('domain_id')
      .notNull()
      .references(() => domain.id, { onDelete: 'cascade' }),
    // Bare and lowercase, on its domain: hello@example.com
    address: text('address').notNull().unique(),
    // Display name in the From header.
    name: text('name').notNull().default(''),
    // Its domain's sender when nothing else is chosen.
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    // A verified Email Routing destination that also gets a copy of its mail.
    forwardTo: text('forward_to').notNull().default(''),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('mailbox_domain').on(t.domainId)],
)

// Every email sent or received here.
export const mail = sqliteTable(
  'mail',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    domainId: integer('domain_id')
      .notNull()
      .references(() => domain.id, { onDelete: 'cascade' }),
    direction: text('direction', { enum: ['in', 'out'] }).notNull(),
    // Unique per email: Email Sending's id for sent mail, a delivery key for
    // received mail, so a second delivery is ignored.
    key: text('key').unique(),
    // Which of our addresses sent or received it (bare, lowercase).
    mailbox: text('mailbox').notNull().default(''),
    // Sent mail: 'dashboard', or 'api:<key name>'.
    source: text('source').notNull().default(''),
    createdAt: text('created_at').notNull().default(now),
    fromAddr: text('from_addr').notNull().default(''),
    toAddrs: text('to_addrs', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    ccAddrs: text('cc_addrs', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    replyTo: text('reply_to').notNull().default(''),
    subject: text('subject').notNull().default(''),
    text: text('text'),
    html: text('html'),
    // RFC 5322 Message-ID, for threading replies.
    messageId: text('message_id').notNull().default(''),
    attachments: text('attachments', { mode: 'json' }).$type<Attachment[]>().notNull().default(sql`'[]'`),
    // Outgoing: the last delivery event (sent, delivered, bounced, …).
    status: text('status').notNull().default(''),
    // Incoming only.
    readAt: text('read_at'),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    index('mail_inbox').on(t.domainId, t.direction, t.archived, sql`${t.id} DESC`),
    index('mail_mailbox').on(t.mailbox, sql`${t.id} DESC`),
    check('mail_direction_check', sql`${t.direction} IN ('in', 'out')`),
  ],
)

// ---- Marketing: contacts, segments, broadcasts -------------------------------

// People who asked for a domain's emails. The same person on two domains is
// two contacts, each with their own subscription.
export const contact = sqliteTable(
  'contact',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    domainId: integer('domain_id')
      .notNull()
      .references(() => domain.id, { onDelete: 'cascade' }),
    // Bare and lowercase.
    email: text('email').notNull(),
    firstName: text('first_name').notNull().default(''),
    lastName: text('last_name').notNull().default(''),
    // Set by the link in every broadcast, by a hard bounce or spam complaint,
    // through the API, or by hand; broadcasts skip them.
    unsubscribed: integer('unsubscribed', { mode: 'boolean' }).notNull().default(false),
    // The secret in their unsubscribe link.
    token: text('token').notNull().unique(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('contact_domain_email').on(t.domainId, t.email)],
)

export const segment = sqliteTable(
  'segment',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    domainId: integer('domain_id')
      .notNull()
      .references(() => domain.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('segment_domain_name').on(t.domainId, t.name)],
)

export const contactSegment = sqliteTable(
  'contact_segment',
  {
    contactId: integer('contact_id')
      .notNull()
      .references(() => contact.id, { onDelete: 'cascade' }),
    segmentId: integer('segment_id')
      .notNull()
      .references(() => segment.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.segmentId] }), index('contact_segment_segment').on(t.segmentId)],
)

// draft -> queued (waiting for its time, or for the next cron run) ->
// sending -> sent. A queued one can go back to draft; a sending one can be
// stopped (canceled).
export const BROADCAST_STATUSES = ['draft', 'queued', 'sending', 'sent', 'canceled'] as const
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number]

export const BODY_FORMATS = ['text', 'html'] as const
export type BodyFormat = (typeof BODY_FORMATS)[number]

export const broadcast = sqliteTable(
  'broadcast',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    domainId: integer('domain_id')
      .notNull()
      .references(() => domain.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default(''),
    segmentId: integer('segment_id').references(() => segment.id, { onDelete: 'set null' }),
    // One of the domain's mailboxes; its default mailbox when empty.
    fromAddr: text('from_addr').notNull().default(''),
    subject: text('subject').notNull().default(''),
    previewText: text('preview_text').notNull().default(''),
    // As written: plain text (HTML is made from it when sending) or HTML,
    // per `format`. The unsubscribe footer is added when sending.
    message: text('message').notNull().default(''),
    format: text('format', { enum: BODY_FORMATS }).notNull().default('text'),
    status: text('status', { enum: BROADCAST_STATUSES }).notNull().default('draft'),
    scheduledAt: text('scheduled_at'),
    sentAt: text('sent_at'),
    createdAt: text('created_at').notNull().default(now),
    // Filled in as it goes out.
    total: integer('total').notNull().default(0),
    sent: integer('sent').notNull().default(0),
    failed: integer('failed').notNull().default(0),
  },
  (t) => [index('broadcast_status').on(t.status), index('broadcast_domain').on(t.domainId)],
)

// Who a broadcast goes to, fixed when sending starts, so a run that stops
// (daily quota, a crash) picks up where it left off without sending twice.
export const broadcastRecipient = sqliteTable(
  'broadcast_recipient',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    broadcastId: integer('broadcast_id')
      .notNull()
      .references(() => broadcast.id, { onDelete: 'cascade' }),
    contactId: integer('contact_id').notNull(),
    email: text('email').notNull(),
    token: text('token').notNull(),
    // pending -> claimed (a run is sending it) -> sent | failed
    status: text('status', { enum: ['pending', 'claimed', 'sent', 'failed'] }).notNull().default('pending'),
    claimedAt: text('claimed_at'),
    error: text('error').notNull().default(''),
  },
  (t) => [uniqueIndex('broadcast_recipient_unique').on(t.broadcastId, t.contactId), index('broadcast_recipient_status').on(t.broadcastId, t.status)],
)

// ---- Templates and AI -------------------------------------------------------

// Reusable emails: a starting point for Compose and Broadcasts. Without a
// domain, every domain can use it.
export const template = sqliteTable(
  'template',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    domainId: integer('domain_id').references(() => domain.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    subject: text('subject').notNull().default(''),
    format: text('format', { enum: BODY_FORMATS }).notNull().default('html'),
    body: text('body').notNull().default(''),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [index('template_domain').on(t.domainId)],
)

// Where the writing assistant sends its requests. 'anthropic' is the Claude
// API; 'openai' is any service with an OpenAI-compatible /chat/completions.
export const AI_KINDS = ['anthropic', 'openai'] as const
export type AiKind = (typeof AI_KINDS)[number]

export const aiProvider = sqliteTable('ai_provider', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  kind: text('kind', { enum: AI_KINDS }).notNull(),
  // Empty means the service's own endpoint.
  baseUrl: text('base_url').notNull().default(''),
  model: text('model').notNull(),
  // Encrypted with a key derived from ADMIN_PASSWORD (lib/crypto); never sent
  // to the dashboard.
  apiKey: text('api_key').notNull().default(''),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(now),
})

// ---- Integration: API keys and webhooks ---------------------------------------

// What an API key may do through /v1 (docs/api.md).
export const API_SCOPES = ['send', 'contacts'] as const
export type ApiScope = (typeof API_SCOPES)[number]

// A key for /v1, good for one domain. Only its hash is kept; the key itself
// is shown once, when it is made.
export const apiKey = sqliteTable(
  'api_key',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    domainId: integer('domain_id')
      .notNull()
      .references(() => domain.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // The start of the key, to tell keys apart: mr_ab12cd34
    prefix: text('prefix').notNull(),
    // SHA-256 of the whole key, hex.
    hash: text('hash').notNull().unique(),
    scopes: text('scopes', { mode: 'json' }).$type<ApiScope[]>().notNull(),
    lastUsedAt: text('last_used_at'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('api_key_domain').on(t.domainId)],
)

// What a webhook can be told about.
export const WEBHOOK_EVENTS = ['mail.received', 'mail.status'] as const
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

// A URL that is POSTed a signed JSON event when something happens on a
// domain (docs/api.md#webhooks).
export const webhook = sqliteTable(
  'webhook',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    domainId: integer('domain_id')
      .notNull()
      .references(() => domain.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    events: text('events', { mode: 'json' }).$type<WebhookEvent[]>().notNull(),
    // For the HMAC signature; readable, since every delivery needs it.
    secret: text('secret').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    // The last delivery, for the dashboard.
    lastAt: text('last_at'),
    lastStatus: integer('last_status'),
    lastError: text('last_error').notNull().default(''),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('webhook_domain').on(t.domainId)],
)

export type Domain = typeof domain.$inferSelect
export type Mail = typeof mail.$inferSelect
export type Mailbox = typeof mailbox.$inferSelect
export type Contact = typeof contact.$inferSelect
export type Segment = typeof segment.$inferSelect
export type Broadcast = typeof broadcast.$inferSelect
export type Template = typeof template.$inferSelect
export type AiProvider = typeof aiProvider.$inferSelect
export type ApiKey = typeof apiKey.$inferSelect
export type Webhook = typeof webhook.$inferSelect
