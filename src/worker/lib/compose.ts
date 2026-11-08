// The body of an email written here, as it goes out: what was written, then
// the download links for files sent that way, then (in a reply) the quoted
// original. A signature is part of what was written (the editor puts it in
// the message). Plain text stays plain text; HTML always gets a text version.

import type { BodyFormat } from '../db/schema'
import { formatBytes } from './files'
import { escapeHtml, htmlToText, textToHtml } from './text'

export type Link = { name: string; size: number; url: string }
export type Part = { format: BodyFormat; body: string }

const muted = 'color:#6b6b63'

export const linksText = (links: Link[]) => (links.length ? ['Files:', ...links.map((l) => `- ${l.name} (${formatBytes(l.size)}): ${l.url}`)].join('\n') : '')

export const linksHtml = (links: Link[]) =>
  links.length
    ? `<div style="margin:16px 0;padding:12px 14px;border:1px solid #e3e2dc;border-radius:8px;font-size:14px;line-height:1.7">${links
        .map((l) => `<div><a href="${escapeHtml(l.url)}">${escapeHtml(l.name)}</a> <span style="${muted}">· ${formatBytes(l.size)}</span></div>`)
        .join('')}</div>`
    : ''

const asText = (p: Part) => (p.format === 'html' ? htmlToText(p.body) : p.body.trim())

export type Composed = { text: string; html?: string }

export function composeBody({
  message,
  links = [],
  quote,
}: {
  message: Part
  links?: Link[]
  // In a reply: who wrote what is being answered, and what they wrote.
  quote?: { attribution: string; text: string }
}): Composed {
  const html = message.format === 'html'

  const quoted = quote ? `${quote.attribution}\n${quote.text.split(/\r?\n/).map((l) => `> ${l}`).join('\n')}` : ''
  const text = [asText(message), linksText(links), quoted].filter(Boolean).join('\n\n')
  if (!html) return { text }

  const extras = [
    linksHtml(links),
    quote
      ? `<div style="margin-top:20px"><div style="${muted}">${escapeHtml(quote.attribution)}</div><blockquote style="margin:6px 0 0;padding-left:12px;border-left:2px solid #d6d5ce;${muted}">${textToHtml(quote.text, '', false)}</blockquote></div>`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
  // Written as text: everything goes inside the one styled wrapper.
  return { text, html: message.format === 'html' ? [message.body, extras].filter(Boolean).join('\n') : textToHtml(message.body, extras && `\n${extras}`) }
}
