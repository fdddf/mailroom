// Images for HTML email, kept in R2 under media/ and served publicly at
// /media/<name> (routes/public.ts): recipients' mail clients load them from
// there, so they cannot sit behind the admin login. One library for all
// domains.

import { Hono } from 'hono'
import type { AppEnv, Env } from '../../env'
import { publicBase } from '../../lib/files'

export const MEDIA_PREFIX = 'media/'
const MAX_BYTES = 5 * 1024 * 1024
// What mail clients show. No SVG: they do not render it, and it can carry script.
export const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

// On PUBLIC_URL, which is where recipients can reach it.
const mediaUrl = (env: Env, requestUrl: string, name: string) => `${publicBase(env, requestUrl)}/media/${name}`

export const mediaRoutes = new Hono<AppEnv>()
  // The raw image as the request body (PUT, so the JSON-only rule for POST
  // does not apply; the session cookie is SameSite=Strict either way).
  .put('/', async (c) => {
    const bucket = c.env.BUCKET
    if (!bucket) return c.json({ error: 'storage_not_configured' }, 503)
    const type = (c.req.header('Content-Type') || '').split(';')[0]!.trim().toLowerCase()
    const extension = IMAGE_TYPES[type]
    if (!extension) return c.json({ error: 'unsupported_image' }, 415)
    const body = await c.req.arrayBuffer()
    if (!body.byteLength) return c.json({ error: 'empty_file' }, 400)
    if (body.byteLength > MAX_BYTES) return c.json({ error: 'image_too_large' }, 413)

    // Unguessable, and never reused: the address is cached for a year.
    const name = `${crypto.randomUUID().replaceAll('-', '')}.${extension}`
    await bucket.put(MEDIA_PREFIX + name, body, { httpMetadata: { contentType: type } })
    return c.json({ url: mediaUrl(c.env, c.req.url, name), name, size: body.byteLength })
  })

  // Newest first, for picking one again.
  .get('/', async (c) => {
    const bucket = c.env.BUCKET
    if (!bucket) return c.json({ items: [], more: false })
    const listed = await bucket.list({ prefix: MEDIA_PREFIX, limit: 500 })
    const items = listed.objects
      .map((o) => ({ name: o.key.slice(MEDIA_PREFIX.length), url: mediaUrl(c.env, c.req.url, o.key.slice(MEDIA_PREFIX.length)), size: o.size, uploadedAt: o.uploaded.toISOString() }))
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
    return c.json({ items, more: listed.truncated })
  })

  // Emails already sent with it show a broken image afterwards.
  .delete('/:name', async (c) => {
    const name = c.req.param('name')
    if (!/^[0-9a-f]{32}\.[a-z]+$/.test(name)) return c.json({ error: 'not_found' }, 404)
    await c.env.BUCKET?.delete(MEDIA_PREFIX + name)
    return c.json({ ok: true })
  })
