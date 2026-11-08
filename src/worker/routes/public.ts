// Public pages: the unsubscribe link in every broadcast, the images
// uploaded for HTML email, and the files sent as download links.

import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { getDb } from '../db'
import { contact, domain, file } from '../db/schema'
import type { AppEnv } from '../env'
import { countDownload, fileKey, parseRange } from '../lib/files'
import { IMAGE_TYPES, MEDIA_PREFIX } from './admin/media'

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const TOKEN = /^[0-9a-f]{20,64}$/

// The public pages (unsubscribing, confirming a subscription): small,
// self-contained, no scripts.
export const page = (title: string, brand: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}${brand ? ` · ${escapeHtml(brand)}` : ''}</title>
<style>body{font:16px/1.6 system-ui,-apple-system,sans-serif;color:#141413;background:#faf9f5;margin:0;padding:15vh 24px;text-align:center}
main{max-width:420px;margin:auto}h1{font-size:22px;margin:0 0 8px}p{color:#68685f;margin:0 0 24px}
button{font:inherit;font-weight:600;color:#fff;background:#2563eb;border:0;border-radius:8px;padding:10px 20px;cursor:pointer}
@media (prefers-color-scheme:dark){body{color:#f4f3ee;background:#1f1e1b}p{color:#b5b3a8}}</style>
</head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`

// Whose list a token is on, for the page's wording.
const brandOf = async (db: ReturnType<typeof getDb>, token: string) => {
  const [row] = await db
    .select({ brand: domain.brand, name: domain.name })
    .from(contact)
    .innerJoin(domain, eq(domain.id, contact.domainId))
    .where(eq(contact.token, token))
  return row ? row.brand || row.name : ''
}

export const publicRoutes = new Hono<AppEnv>()
  // The link at the end of every broadcast. Opening it only asks; the
  // button — or a mail client's one-click unsubscribe, which POSTs here
  // directly (RFC 8058) — does it. Link scanners that follow every URL in an
  // email therefore unsubscribe nobody.
  .get('/u/:token', async (c) => {
    const token = c.req.param('token')
    if (!TOKEN.test(token)) return c.html(page('This link is not valid', '', '<p>It may have been cut off. Try the link in a more recent email.</p>'), 400)
    const brand = await brandOf(getDb(c.env.DB), token)
    return c.html(
      page(
        brand ? `Unsubscribe from ${brand}?` : 'Unsubscribe?',
        brand,
        `<p>You will not get these emails any more.</p><form method="post" action="/u/${token}"><button>Unsubscribe</button></form>`,
      ),
    )
  })
  .post('/u/:token', async (c) => {
    const token = c.req.param('token')
    const db = getDb(c.env.DB)
    let brand = ''
    if (TOKEN.test(token)) {
      brand = await brandOf(db, token)
      await db.update(contact).set({ unsubscribed: true }).where(eq(contact.token, token))
    }
    // The same answer whether or not the token exists.
    return c.html(page('You are unsubscribed', brand, `<p>Sorry to see you go. You will not hear from ${brand ? escapeHtml(brand) : 'us'} again.</p>`))
  })

  // An image uploaded for an HTML email (admin/media.ts). Only that prefix of
  // the bucket is reachable here; received attachments are not.
  .get('/media/:name', async (c) => {
    const name = c.req.param('name')
    if (!/^[0-9a-f]{32}\.[a-z]+$/.test(name)) return c.notFound()
    const object = await c.env.BUCKET?.get(MEDIA_PREFIX + name)
    const type = object?.httpMetadata?.contentType
    if (!object || !type || !(type in IMAGE_TYPES)) return c.notFound()
    return c.body(object.body as unknown as ReadableStream, 200, {
      'Content-Type': type,
      'Content-Length': String(object.size),
      // Names are never reused.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Access-Control-Allow-Origin': '*',
    })
  })

  // A file from the library, sent as a download link (admin/files.ts). The
  // token is the secret; the name after it is only for the browser. Always a
  // download, never shown on this origin (the dashboard's). Range requests
  // let a big download resume.
  .get('/f/:token/:name?', async (c) => {
    const token = c.req.param('token')
    const gone = () => c.html(page('This file is not available', '', '<p>It may have been removed. Ask whoever sent you the link for a new one.</p>'), 404)
    const bucket = c.env.BUCKET
    if (!/^[0-9a-f]{40}$/.test(token) || !bucket) return gone()
    const db = getDb(c.env.DB)
    const row = await db.query.file.findFirst({ columns: { name: true, size: true }, where: and(eq(file.token, token), eq(file.status, 'ready')) })
    if (!row) return gone()

    const filename = row.name.replace(/[\r\n"\\]/g, '_')
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
    }
    if (c.req.method === 'HEAD') return c.body(null, 200, { ...headers, 'Content-Length': String(row.size) })

    const range = parseRange(c.req.header('Range'), row.size)
    if (range === 'unsatisfiable') return c.body(null, 416, { 'Content-Range': `bytes */${row.size}` })
    const object = await bucket.get(fileKey(token), range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined)
    if (!object) return gone()

    // Count a download once, not for every piece a download manager asks for.
    if (!range || range.start === 0) {
      try {
        c.executionCtx.waitUntil(countDownload(db, token).catch((err) => console.error('download count failed', err)))
      } catch {
        // No execution context (tests).
      }
    }
    return c.body(object.body as unknown as ReadableStream, range ? 206 : 200, {
      ...headers,
      'Content-Length': String(range ? range.end - range.start + 1 : object.size),
      ETag: object.httpEtag,
      ...(range && { 'Content-Range': `bytes ${range.start}-${range.end}/${object.size}` }),
    })
  })
