// The file library (table `file`): uploaded in parts straight into R2, sent
// attached when small enough, else as a public download link.

import { and, eq, lt, sql } from 'drizzle-orm'
import type { Db } from '../db'
import { file } from '../db/schema'
import type { Env } from '../env'

export const FILES_PREFIX = 'files/'
export const fileKey = (token: string) => FILES_PREFIX + token

// Every part but the last is exactly this big (R2 wants equal parts of at
// least 5 MiB), well under the 100 MB a request to a Worker may carry.
export const PART_SIZE = 10 * 1024 * 1024
// R2 allows 10,000 parts.
export const MAX_PARTS = 10_000
export const MAX_FILE_BYTES = PART_SIZE * MAX_PARTS

// Email Sending takes 25 MiB a message, attachments included, and they grow
// by a third (and a little) as base64 on the way: what is attached must stay
// under this, the rest goes as links.
export const ATTACH_LIMIT = 17 * 1024 * 1024

// What one email may carry, attached and linked together.
export const MAX_FILES_PER_EMAIL = 20

export const partCount = (size: number) => Math.max(1, Math.ceil(size / PART_SIZE))
// How big part `n` (from 1) of a file of `size` must be.
export const partBytes = (size: number, n: number) => (n < partCount(size) ? PART_SIZE : size - PART_SIZE * (partCount(size) - 1))

// Where recipients reach this Worker: PUBLIC_URL, else the address the
// dashboard is open on.
export const publicBase = (env: Pick<Env, 'PUBLIC_URL'>, requestUrl: string) => (env.PUBLIC_URL || new URL(requestUrl).origin).replace(/\/$/, '')

// The name is only there so the download is saved under it; the token alone
// finds the file.
export const fileUrl = (base: string, f: { token: string; name: string }) => `${base}/f/${f.token}/${encodeURIComponent(f.name)}`

// What a file name may be: no paths, no control characters.
export const cleanFileName = (name: string) =>
  name
    .replace(/[\\/]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 200) || 'file'

export const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`
}

// How often a file was downloaded, counted by its public route.
export const countDownload = (db: Db, token: string) =>
  db
    .update(file)
    .set({ downloads: sql`${file.downloads} + 1`, lastDownloadAt: new Date().toISOString() })
    .where(eq(file.token, token))

// Uploads nobody finished within a day: their parts in R2 and their rows go.
// (R2 would drop the parts itself after a week.)
export async function purgeStaleUploads(db: Db, env: Pick<Env, 'BUCKET'>) {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const stale = await db
    .select({ id: file.id, token: file.token, uploadId: file.uploadId })
    .from(file)
    .where(and(eq(file.status, 'uploading'), lt(file.createdAt, cutoff)))
    .limit(100)
  for (const f of stale) {
    if (env.BUCKET && f.uploadId) {
      await env.BUCKET.resumeMultipartUpload(fileKey(f.token), f.uploadId)
        .abort()
        .catch(() => {})
    }
    await db.delete(file).where(eq(file.id, f.id))
  }
}

// A Range header against a file of `size`: the bytes asked for, null to send
// the whole file (no header, or one we do not do, such as several ranges),
// or 'unsatisfiable'.
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'unsatisfiable' {
  const m = header?.trim().match(/^bytes=(\d*)-(\d*)$/)
  if (!m || (!m[1] && !m[2])) return null
  if (!m[1]) {
    // The last n bytes.
    const n = Number(m[2])
    if (n === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  if (start >= size || end < start) return 'unsatisfiable'
  return { start, end }
}
