import { eq, sql } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { Context } from 'hono'
import { z } from 'zod'
import { mail } from '../../db/schema'
import type { AppEnv } from '../../env'

export const PAGE_SIZE = 50

export const idParam = z.object({ id: z.coerce.number({ error: 'invalid_id' }).int('invalid_id').positive('invalid_id') })

// Narrow a query to the domain picked in the dashboard; nothing when it shows
// all of them.
export const inDomain = (c: Context<AppEnv>, column: SQLiteColumn) => (c.var.domain ? eq(column, c.var.domain.id) : undefined)

// For creating things that must belong to one domain.
export const domainRequired = (c: Context<AppEnv>) => c.json({ error: 'domain_required' }, 400)

// What a thread or mail view needs. Text bodies are included; HTML is
// fetched on demand from /mail/:id/html.
export const threadColumns = {
  id: mail.id,
  domainId: mail.domainId,
  direction: mail.direction,
  mailbox: mail.mailbox,
  source: mail.source,
  createdAt: mail.createdAt,
  fromAddr: mail.fromAddr,
  toAddrs: mail.toAddrs,
  ccAddrs: mail.ccAddrs,
  replyTo: mail.replyTo,
  subject: mail.subject,
  text: mail.text,
  hasRaw: sql<boolean>`${mail.rawKey} IS NOT NULL`.mapWith(Boolean),
  hasHtml: sql<boolean>`${mail.html} IS NOT NULL`.mapWith(Boolean),
  attachments: mail.attachments,
  status: mail.status,
  readAt: mail.readAt,
  archived: mail.archived,
}

export const snippet = (column: typeof mail.text | typeof mail.subject) => sql<string | null>`substr(${column}, 1, 160)`
