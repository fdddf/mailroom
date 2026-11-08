// The file library, for sending files attached or as download links. A file
// is uploaded in parts so any size gets through:
//
//   POST   /files                  { name, type, size } -> its id and part size
//   PUT    /files/:id/parts/:n     the bytes of part n (from 1)
//   POST   /files/:id/complete     { parts: [{ partNumber, etag }] }
//
// Each part is a request of its own, under what a Worker may receive, and
// goes straight on to R2. A file belongs to the domain picked when it was
// uploaded, or to all of them.

import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Db } from '../../db'
import { file, type Attachment } from '../../db/schema'
import type { AppEnv, Env } from '../../env'
import type { Link } from '../../lib/compose'
import { ATTACH_LIMIT, MAX_FILE_BYTES, MAX_FILES_PER_EMAIL, PART_SIZE, cleanFileName, fileKey, fileUrl, partBytes, partCount, publicBase } from '../../lib/files'
import { validate } from '../../lib/validate'
import { idParam } from './shared'

const columns = {
  id: file.id,
  domainId: file.domainId,
  token: file.token,
  name: file.name,
  contentType: file.contentType,
  size: file.size,
  downloads: file.downloads,
  lastDownloadAt: file.lastDownloadAt,
  createdAt: file.createdAt,
}
const withUrl =
  (base: string) =>
  <T extends { token: string; name: string }>(f: T) => ({ ...f, url: fileUrl(base, f) })

const contentType = z
  .string()
  .trim()
  .toLowerCase()
  .transform((t) => (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t) ? t : 'application/octet-stream'))

export const fileRoutes = new Hono<AppEnv>()
  // Ready ones of the picked domain and the shared ones, newest first.
  .get('/', async (c) => {
    const d = c.var.domain
    const rows = await c.var.db
      .select(columns)
      .from(file)
      .where(and(eq(file.status, 'ready'), d ? or(eq(file.domainId, d.id), isNull(file.domainId)) : undefined))
      .orderBy(desc(file.id))
      .limit(1000)
    return c.json({ items: rows.map(withUrl(publicBase(c.env, c.req.url))), attachLimit: ATTACH_LIMIT })
  })

  .post(
    '/',
    validate(
      'json',
      z.object({
        name: z.string().min(1, 'invalid_name').max(1000, 'invalid_name').transform(cleanFileName),
        type: contentType.default('application/octet-stream'),
        size: z.number().int().positive('empty_file').max(MAX_FILE_BYTES, 'file_too_large'),
      }),
    ),
    async (c) => {
      const bucket = c.env.BUCKET
      if (!bucket) return c.json({ error: 'storage_not_configured' }, 503)
      const { name, type, size } = c.req.valid('json')
      const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '').slice(0, 8)
      const upload = await bucket.createMultipartUpload(fileKey(token), { httpMetadata: { contentType: type } })
      const [row] = await c.var.db
        .insert(file)
        .values({ domainId: c.var.domain?.id ?? null, token, name, contentType: type, size, uploadId: upload.uploadId })
        .returning({ id: file.id })
      return c.json({ id: row!.id, partSize: PART_SIZE, parts: partCount(size) })
    },
  )

  // The raw bytes as the body (PUT, so the JSON-only rule for POST does not
  // apply). Every part but the last is exactly partSize.
  .put('/:id/parts/:n', validate('param', idParam.extend({ n: z.coerce.number().int().min(1).max(10_000) })), async (c) => {
    const bucket = c.env.BUCKET
    if (!bucket) return c.json({ error: 'storage_not_configured' }, 503)
    const { id, n } = c.req.valid('param')
    const row = await c.var.db.query.file.findFirst({ where: and(eq(file.id, id), eq(file.status, 'uploading')) })
    if (!row?.uploadId) return c.json({ error: 'not_found' }, 404)
    if (n > partCount(row.size)) return c.json({ error: 'bad_part' }, 400)
    const body = await c.req.arrayBuffer()
    if (body.byteLength !== partBytes(row.size, n)) return c.json({ error: 'bad_part' }, 400)
    const part = await bucket.resumeMultipartUpload(fileKey(row.token), row.uploadId).uploadPart(n, body)
    return c.json({ partNumber: part.partNumber, etag: part.etag })
  })

  .post(
    '/:id/complete',
    validate('param', idParam),
    validate('json', z.object({ parts: z.array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1) })).min(1).max(10_000) })),
    async (c) => {
      const bucket = c.env.BUCKET
      if (!bucket) return c.json({ error: 'storage_not_configured' }, 503)
      const { id } = c.req.valid('param')
      const db = c.var.db
      const row = await db.query.file.findFirst({ where: and(eq(file.id, id), eq(file.status, 'uploading')) })
      if (!row?.uploadId) return c.json({ error: 'not_found' }, 404)
      const parts = [...c.req.valid('json').parts].sort((a, b) => a.partNumber - b.partNumber)
      if (parts.length !== partCount(row.size) || parts.some((p, i) => p.partNumber !== i + 1)) return c.json({ error: 'upload_incomplete' }, 400)
      try {
        const object = await bucket.resumeMultipartUpload(fileKey(row.token), row.uploadId).complete(parts)
        if (object.size !== row.size) throw new Error(`size ${object.size}, expected ${row.size}`)
      } catch (err) {
        console.error('file upload did not complete', err)
        return c.json({ error: 'upload_incomplete' }, 400)
      }
      await db.update(file).set({ status: 'ready', uploadId: null }).where(eq(file.id, id))
      const [ready] = await db.select(columns).from(file).where(eq(file.id, id))
      return c.json(withUrl(publicBase(c.env, c.req.url))(ready!))
    },
  )

  .patch(
    '/:id',
    validate('param', idParam),
    validate('json', z.object({ name: z.string().min(1, 'invalid_name').max(1000, 'invalid_name').transform(cleanFileName) })),
    async (c) => {
      const rows = await c.var.db
        .update(file)
        .set(c.req.valid('json'))
        .where(eq(file.id, c.req.valid('param').id))
        .returning({ id: file.id })
      return rows.length ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
    },
  )

  // Also stops an upload. Links to it in mail already sent stop working.
  .delete('/:id', validate('param', idParam), async (c) => {
    const [row] = await c.var.db.delete(file).where(eq(file.id, c.req.valid('param').id)).returning()
    if (!row) return c.json({ error: 'not_found' }, 404)
    const bucket = c.env.BUCKET
    if (bucket) {
      if (row.uploadId) await bucket.resumeMultipartUpload(fileKey(row.token), row.uploadId).abort().catch(() => {})
      else await bucket.delete(fileKey(row.token))
    }
    return c.json({ ok: true })
  })

// Files picked for an email, by id: whether each goes attached or as a link.
export const filePicks = z
  .array(z.object({ fileId: z.number().int().positive(), link: z.boolean().default(false) }))
  .max(MAX_FILES_PER_EMAIL, 'too_many_files')
  .default([])

export type PreparedFiles =
  | { ok: true; files: (Attachment & { content?: ArrayBuffer })[]; links: Link[] }
  | { ok: false; status: 400 | 413 | 424 | 503; error: string }

// What sendMail needs for them: the bytes of the attached ones (together
// under ATTACH_LIMIT), the addresses of the linked ones.
export async function prepareFiles(env: Env, db: Db, base: string, picks: z.infer<typeof filePicks>): Promise<PreparedFiles> {
  if (!picks.length) return { ok: true, files: [], links: [] }
  if (!env.BUCKET) return { ok: false, status: 503, error: 'storage_not_configured' }
  const ids = [...new Set(picks.map((p) => p.fileId))]
  const rows = await db
    .select()
    .from(file)
    .where(and(inArray(file.id, ids), eq(file.status, 'ready')))
  if (rows.length !== ids.length) return { ok: false, status: 400, error: 'unknown_file' }

  const ordered = ids.map((id) => ({ row: rows.find((r) => r.id === id)!, link: picks.find((p) => p.fileId === id)!.link }))
  if (ordered.reduce((sum, { row, link }) => sum + (link ? 0 : row.size), 0) > ATTACH_LIMIT) return { ok: false, status: 413, error: 'attachments_too_large' }

  const files: (Attachment & { content?: ArrayBuffer })[] = []
  const links: Link[] = []
  for (const { row, link } of ordered) {
    const meta = { id: fileKey(row.token), filename: row.name, size: row.size, content_type: row.contentType }
    if (link) {
      const url = fileUrl(base, row)
      links.push({ name: row.name, size: row.size, url })
      files.push({ ...meta, link: url })
    } else {
      const object = await env.BUCKET.get(fileKey(row.token))
      if (!object) return { ok: false, status: 424, error: 'file_unavailable' }
      files.push({ ...meta, content: await object.arrayBuffer() })
    }
  }
  return { ok: true, files, links }
}
