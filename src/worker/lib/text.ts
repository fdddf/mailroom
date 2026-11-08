// String helpers shared by the routes.

export const isEmail = (s: string) => /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(s)

// "Name <a@b.c>" -> "a@b.c"
export const bareAddress = (s: string | null | undefined) =>
  ((s || '').match(/<([^>]+)>/)?.[1] || s || '').trim().toLowerCase()

// "a@Example.com" -> "example.com"
export const domainOf = (address: string) => bareAddress(address).split('@').pop() ?? ''

// A domain name as people write it: lowercase, no scheme, no trailing dot.
export const isDomainName = (s: string) => /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s)

// "a@b.c, d@e.f; …" -> ["a@b.c", "d@e.f"], or null if any entry is not an address.
export const parseAddressList = (value: string | string[] | undefined, max = 50) => {
  const list = (Array.isArray(value) ? value : String(value || '').split(/[,;\n]/)).map((s) => s.trim()).filter(Boolean)
  if (list.length > max || !list.every((s) => isEmail(bareAddress(s)))) return null
  return list
}

// For LIKE … ESCAPE '\'.
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

// Clip to a UTF-8 byte budget without splitting a character.
export const clipBytes = (str: string, maxBytes: number, suffix = '… (truncated)') => {
  const encoder = new TextEncoder()
  if (encoder.encode(str).length <= maxBytes) return str
  let out = ''
  let used = 0
  const budget = maxBytes - encoder.encode(suffix).length
  for (const ch of str) {
    const size = encoder.encode(ch).length
    if (used + size > budget) break
    out += ch
    used += size
  }
  return out + suffix
}

export const quote = (text: string | null | undefined) =>
  (text || '')
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n')

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// Plain text -> minimal HTML: paragraphs, line breaks, bare links made
// clickable. `wrap` false gives just the paragraphs, for inside other HTML.
export const textToHtml = (text: string, footer = '', wrap = true) => {
  const paragraphs = text
    .trim()
    .split(/\r?\n\s*\r?\n/)
    .map((p) =>
      escapeHtml(p)
        .replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (url) => `<a href="${url}">${url}</a>`)
        .replace(/\r?\n/g, '<br>'),
    )
    .map((p) => `<p style="margin:0 0 16px">${p}</p>`)
    .join('\n')
  if (!wrap) return paragraphs + footer
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#141413;max-width:600px">
${paragraphs}${footer}
</div>`
}

// HTML -> a readable plain-text version, for the text part of an HTML email.
export const htmlToText = (html: string) =>
  html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, '').trim()
      return !text || text === href ? href : `${text} (${href})`
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol|blockquote)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

// Fill {{name}} placeholders; unknown ones are left as written.
export const fillVariables = (text: string, values: Record<string, string>) =>
  text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, name: string) => values[name.toLowerCase()] ?? whole)
