// Webhooks: a domain's URLs are POSTed a signed JSON event when mail arrives
// (mail.received) or a sent email's delivery status changes (mail.status).
// Delivery is best effort: one retry, and the outcome is kept on the webhook
// for the dashboard. The format is in docs/api.md#webhooks.

import { and, eq } from 'drizzle-orm'
import type { Db } from '../db'
import { webhook, type Webhook, type WebhookEvent } from '../db/schema'
import { signWebhook } from './crypto'

const TIMEOUT_MS = 10_000

export type WebhookResult = { ok: boolean; status: number | null; error: string }

const post = async (url: string, body: string, headers: Record<string, string>): Promise<WebhookResult> => {
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' })
    return { ok: res.ok, status: res.status, error: res.ok ? '' : (await res.text().catch(() => '')).slice(0, 300) }
  } catch (err) {
    return { ok: false, status: null, error: String(err).slice(0, 300) }
  }
}

// One event to one webhook, recording how it went.
export const deliverWebhook = async (db: Db, hook: Webhook, type: WebhookEvent | 'ping', data: unknown) => {
  const id = crypto.randomUUID()
  const timestamp = Math.floor(Date.now() / 1000)
  const body = JSON.stringify({ id, type, created: new Date(timestamp * 1000).toISOString(), data })
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mailroom-Webhook/1',
    'X-Mailroom-Event': type,
    'X-Mailroom-Delivery': id,
    'X-Mailroom-Signature': `t=${timestamp},v1=${await signWebhook(hook.secret, timestamp, body)}`,
  }
  let result = await post(hook.url, body, headers)
  // Once more for a network error or a 5xx; a 4xx is the receiver's answer.
  if (!result.ok && (result.status === null || result.status >= 500)) result = await post(hook.url, body, headers)
  await db
    .update(webhook)
    .set({ lastAt: new Date().toISOString(), lastStatus: result.status, lastError: result.error })
    .where(eq(webhook.id, hook.id))
  return result
}

// An event to every enabled webhook of the domain that wants it.
export const emitEvent = async (db: Db, domainId: number, type: WebhookEvent, data: unknown) => {
  const hooks = await db.select().from(webhook).where(and(eq(webhook.domainId, domainId), eq(webhook.enabled, true)))
  await Promise.all(hooks.filter((h) => h.events.includes(type)).map((h) => deliverWebhook(db, h, type, data)))
}
