// The writing assistant: its providers (settings) and the draft endpoint.

import { asc, desc, eq, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { AI_KINDS, BODY_FORMATS, aiProvider, type AiProvider } from '../../db/schema'
import type { AppEnv } from '../../env'
import { DEFAULT_MODELS, DRAFT_PURPOSES, draftEmail, testProvider } from '../../lib/ai'
import { decryptSecret, encryptSecret } from '../../lib/crypto'
import { emptyBody, validate } from '../../lib/validate'
import { idParam } from './shared'

// The key itself never leaves the server.
const view = ({ apiKey, ...p }: AiProvider) => ({ ...p, hasKey: Boolean(apiKey) })

const baseUrl = z
  .string()
  .trim()
  .max(300, 'too_long')
  .refine((v) => !v || /^https:\/\/[^\s]+$/.test(v), 'invalid_url')
const providerInput = z.object({
  name: z.string().trim().min(1, 'invalid_name').max(60, 'invalid_name'),
  kind: z.enum(AI_KINDS, 'invalid_kind'),
  baseUrl: baseUrl.default(''),
  // Empty picks the kind's default.
  model: z.string().trim().max(100, 'too_long').default(''),
  apiKey: z.string().trim().min(1, 'key_required').max(500, 'too_long'),
})

const draftInput = z.object({
  providerId: z.number().int().positive().optional(),
  purpose: z.enum(DRAFT_PURPOSES),
  format: z.enum(BODY_FORMATS),
  // The conversation, oldest first, ending with the new request.
  turns: z
    .array(
      z.union([
        z.object({ role: z.literal('user'), text: z.string().trim().min(1, 'instruction_required').max(4000, 'too_long') }),
        z.object({ role: z.literal('assistant'), draft: z.object({ subject: z.string().max(500), body: z.string().max(200_000) }) }),
      ]),
    )
    .min(1, 'instruction_required')
    .max(40, 'too_long')
    .refine((turns) => turns.at(-1)?.role === 'user', 'instruction_required'),
  current: z.object({ subject: z.string().max(500).optional(), body: z.string().max(200_000).optional() }).optional(),
  context: z.string().max(100_000).optional(),
})

export const aiRoutes = new Hono<AppEnv>()
  .get('/providers', async (c) => {
    const rows = await c.var.db.select().from(aiProvider).orderBy(desc(aiProvider.isDefault), asc(aiProvider.name))
    return c.json({ items: rows.map(view), defaults: DEFAULT_MODELS })
  })

  .post('/providers', validate('json', providerInput), async (c) => {
    const b = c.req.valid('json')
    const db = c.var.db
    const [row] = await db
      .insert(aiProvider)
      .values({
        ...b,
        model: b.model || DEFAULT_MODELS[b.kind],
        apiKey: await encryptSecret(c.env.ADMIN_PASSWORD!, b.apiKey),
        // The first one is the default.
        isDefault: (await db.$count(aiProvider)) === 0,
      })
      .returning()
    return c.json(view(row!))
  })

  // Leaving the key out keeps the stored one.
  .patch('/providers/:id', validate('param', idParam), validate('json', providerInput.partial().extend({ isDefault: z.literal(true).optional() })), async (c) => {
    const { id } = c.req.valid('param')
    const { apiKey, isDefault, ...rest } = c.req.valid('json')
    const db = c.var.db
    const row = await db.query.aiProvider.findFirst({ where: eq(aiProvider.id, id) })
    if (!row) return c.json({ error: 'not_found' }, 404)
    const kind = rest.kind ?? row.kind
    await db
      .update(aiProvider)
      .set({
        ...rest,
        ...(rest.model === '' && { model: DEFAULT_MODELS[kind] }),
        ...(apiKey && { apiKey: await encryptSecret(c.env.ADMIN_PASSWORD!, apiKey) }),
      })
      .where(eq(aiProvider.id, id))
    if (isDefault) {
      await db.batch([
        db.update(aiProvider).set({ isDefault: false }).where(ne(aiProvider.id, id)),
        db.update(aiProvider).set({ isDefault: true }).where(eq(aiProvider.id, id)),
      ])
    }
    return c.json({ ok: true })
  })

  .delete('/providers/:id', validate('param', idParam), async (c) => {
    const { id } = c.req.valid('param')
    const db = c.var.db
    const [gone] = await db.delete(aiProvider).where(eq(aiProvider.id, id)).returning({ isDefault: aiProvider.isDefault })
    if (!gone) return c.json({ error: 'not_found' }, 404)
    // Another one takes over as the default.
    if (gone.isDefault) {
      const next = await db.query.aiProvider.findFirst({ columns: { id: true }, orderBy: asc(aiProvider.id) })
      if (next) await db.update(aiProvider).set({ isDefault: true }).where(eq(aiProvider.id, next.id))
    }
    return c.json({ ok: true })
  })

  // A one-word request, to check the key, endpoint and model.
  .post('/providers/:id/test', validate('param', idParam), emptyBody(), async (c) => {
    const row = await c.var.db.query.aiProvider.findFirst({ where: eq(aiProvider.id, c.req.valid('param').id) })
    if (!row) return c.json({ error: 'not_found' }, 404)
    const key = await decryptSecret(c.env.ADMIN_PASSWORD!, row.apiKey)
    if (!key) return c.json({ error: 'key_unreadable' }, 409)
    const result = await testProvider(row, key)
    return result.ok ? c.json({ ok: true, reply: result.value.slice(0, 200) }) : c.json({ error: result.error, message: result.message }, 424)
  })

  // Write or revise an email, as a conversation. Nothing is sent or saved:
  // each draft goes back to the dashboard for the admin to check. The answer
  // is a stream of server-sent events:
  //   thinking  a piece of the model's reasoning, as it comes
  //   progress  how many characters of the draft have been written
  //   done      { subject, body, provider }
  //   error     { error, message }
  .post('/draft', validate('json', draftInput), async (c) => {
    const { providerId, ...request } = c.req.valid('json')
    const db = c.var.db
    const d = c.var.domain
    const writer = d ? { brand: d.brand || d.name, about: d.about } : undefined
    const row = await db.query.aiProvider.findFirst({ where: providerId ? eq(aiProvider.id, providerId) : eq(aiProvider.isDefault, true) })
    if (!row) return c.json({ error: 'ai_not_configured' }, 409)
    const key = await decryptSecret(c.env.ADMIN_PASSWORD!, row.apiKey)
    if (!key) return c.json({ error: 'key_unreadable' }, 409)

    return streamSSE(c, async (stream) => {
      // Events are written in order, without blocking the model's stream.
      let queue = Promise.resolve()
      const send = (event: string, data: unknown) => {
        queue = queue.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => {})
      }
      let written = 0
      const result = await draftEmail(row, key, { ...request, writer }, {
        onThinking: (delta) => send('thinking', delta),
        onText: (delta) => send('progress', (written += delta.length)),
      })
      if (result.ok) send('done', { ...result.value, provider: row.name })
      else send('error', { error: result.error, message: result.message })
      await queue
    })
  })
