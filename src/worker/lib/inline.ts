// Images from the library (admin/media.ts) embedded in the email itself, as
// inline parts referenced by cid:, rather than loaded from /media/ when the
// email is opened. Mail apps that block remote images (Outlook, most
// corporate mail) then still show a logo in a signature.

import type { EmailAttachment, R2Bucket } from '@cloudflare/workers-types'
import { IMAGE_TYPES, MEDIA_PREFIX } from '../routes/admin/media'

// <img src="https://…/media/<32 hex>.<ext>">. The host is not checked: the
// name is looked up in our bucket, and one that is not there stays as it is.
const MEDIA_IMG = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(https?:\/\/[^"'\s>]+?\/media\/([0-9a-f]{32}\.[a-z]+))\2/gi

// The library images an email shows, each once, in order.
export const mediaImages = (html: string) => [...new Set(Array.from(html.matchAll(MEDIA_IMG), (m) => m[4]!))]

export const contentIdOf = (name: string) => `mr-${name}`

// Point the given images at their inline parts.
export const pointToInline = (html: string, names: Set<string>) =>
  html.replace(MEDIA_IMG, (whole, pre: string, q: string, _url: string, name: string) => (names.has(name) ? `${pre}${q}cid:${contentIdOf(name)}${q}` : whole))

export type Embedded = { html: string; images: EmailAttachment[]; bytes: number }

// Embed what fits in `budget` bytes, in order of appearance; the rest stay
// remote. Never throws: an image that cannot be read stays remote too.
export async function embedImages(bucket: Pick<R2Bucket, 'get'> | undefined, html: string, budget: number): Promise<Embedded> {
  const images: EmailAttachment[] = []
  const embedded = new Set<string>()
  let bytes = 0
  if (bucket) {
    for (const name of mediaImages(html)) {
      try {
        const object = await bucket.get(MEDIA_PREFIX + name)
        const type = object?.httpMetadata?.contentType
        if (!object || !type || !(type in IMAGE_TYPES) || bytes + object.size > budget) continue
        images.push({ disposition: 'inline', contentId: contentIdOf(name), filename: name, type, content: await object.arrayBuffer() })
        embedded.add(name)
        bytes += object.size
      } catch (err) {
        console.error('could not embed image', name, err)
      }
    }
  }
  return { html: embedded.size ? pointToInline(html, embedded) : html, images, bytes }
}
