// Links in received HTML mail go through a warning page (/api/leave) that
// shows where they really lead before you go there. Each rewritten link is
// signed with ADMIN_PASSWORD, so the page only vouches for links this Worker
// put there and is no open redirect for anyone else.

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

import type { HTMLRewriter as Rewriter, Response as WorkerResponse } from '@cloudflare/workers-types'

const encoder = new TextEncoder()

// The Workers runtime's; looked up on use so the pure helpers here load in Node.
const rewriter = () => new (globalThis as unknown as { HTMLRewriter: typeof Rewriter }).HTMLRewriter()
const asResponse = (html: string) => new Response(html) as unknown as WorkerResponse

const key = (password: string, usages: KeyUsage[]) =>
  crypto.subtle.importKey('raw', encoder.encode(`mz-link:${password}`), { name: 'HMAC', hash: 'SHA-256' }, false, usages)

const toHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

export const signLink = async (password: string, url: string, text: string) =>
  toHex(await crypto.subtle.sign('HMAC', await key(password, ['sign']), encoder.encode(`${url}\n${text}`)))

export const linkSigned = async (password: string, url: string, text: string, sig: string) => {
  if (!/^[0-9a-f]{64}$/.test(sig)) return false
  const bytes = Uint8Array.from(sig.match(/../g)!, (h) => parseInt(h, 16))
  return crypto.subtle.verify('HMAC', await key(password, ['verify']), bytes, encoder.encode(`${url}\n${text}`))
}

// HTMLRewriter hands over attributes and text as written, entities and all.
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== '#') return NAMED[name.toLowerCase()] ?? whole
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })

// Only web links are sent through the page; mailto:, tel: and the rest stay.
export const webUrl = (href: string) => {
  try {
    const url = new URL(decodeEntities(href).trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

const MAX_TEXT = 200
const cleanText = (s: string) => decodeEntities(s).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)

// A link's text that reads as an address: "paypal.com", "www.x.io/login",
// "https://x.io". Only when that is all the text says.
const textHost = (text: string) => {
  const m = /^(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})\.?(?:[:/?#].*)?$/i.exec(text)
  return m ? m[1]!.toLowerCase() : null
}
const sameSite = (a: string, b: string) => {
  const strip = (h: string) => h.replace(/^www\./, '')
  const [x, y] = [strip(a), strip(b)]
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`)
}

// What is worth pointing out about a link before opening it.
export const linkWarnings = (url: URL, text: string) => {
  const warnings: string[] = []
  const shown = textHost(text)
  if (shown && !sameSite(shown, url.hostname)) {
    warnings.push(`The link says ${shown}, but it goes to ${url.hostname}.`)
  }
  if (url.username || url.password) {
    warnings.push(`The part before “@” is not the site. This link goes to ${url.hostname}.`)
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.startsWith('[')) {
    warnings.push('It goes to a bare IP address, not a named site.')
  }
  if (url.hostname.split('.').some((label) => label.startsWith('xn--'))) {
    warnings.push('The address uses non-Latin characters, which can imitate a familiar name.')
  }
  if (url.protocol === 'http:') warnings.push('The connection is not encrypted (http).')
  return warnings
}

export const leaveHref = (url: string, text: string, sig: string) =>
  `/api/leave?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}&sig=${sig}`

// Points every web link in an email at the warning page. Two passes: the
// first reads each link's text, the second (which has to set href before
// that text comes by) rewrites the links.
export const routeLinks = async (html: string, password: string) => {
  const texts: string[] = []
  let current = -1
  await rewriter()
    .on('a[href]', { element: () => void texts.push(''), text: (t) => void (texts[texts.length - 1] += t.text) })
    .transform(asResponse(html))
    .text()
  return rewriter()
    .on('a[href], area[href]', {
      element: async (el) => {
        const index = el.tagName === 'a' ? ++current : -1
        const url = webUrl(el.getAttribute('href') ?? '')
        if (!url) return
        const text = index >= 0 ? cleanText(texts[index] ?? '') : cleanText(el.getAttribute('alt') ?? '')
        el.setAttribute('href', leaveHref(url.href, text, await signLink(password, url.href, text)))
        el.removeAttribute('ping')
      },
    })
    .transform(asResponse(html))
    .text()
}

// The page itself: small, self-contained, no scripts.
export const leavePage = (url: URL | null, text: string, signed: boolean) => {
  const warnings = url ? linkWarnings(url, text) : []
  const showText = text && text !== url?.href && text !== url?.href.replace(/\/$/, '')
  const body = !url
    ? '<h1>This link can’t be opened</h1><p class="lead">Only web links (http and https) open from here.</p>'
    : `<p class="eyebrow">You are leaving Mailroom</p>
<h1>${escapeHtml(url.hostname)}</h1>
<p class="lead">A link in an email goes to this site. Check the full address before you go.</p>
${warnings.length ? `<ul class="warn">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''}
<p class="label">Full address</p>
<p class="url">${escapeHtml(url.href)}</p>
${showText ? `<p class="label">The email shows it as</p><p class="text">${escapeHtml(text)}</p>` : ''}
${
  signed
    ? `<p class="actions"><a class="btn${warnings.length ? ' risky' : ''}" href="${escapeHtml(url.href)}" rel="noopener noreferrer">Open link</a><span>Not sure? Close this tab.</span></p>`
    : '<p class="lead">This link did not come from an email in Mailroom, so it is not opened from here. Copy the address if you still want to go there.</p>'
}`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${url ? `Open ${escapeHtml(url.hostname)}?` : 'Link'} · Mailroom</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap">
<style>
:root{--canvas:#f8fafc;--card:#fff;--text:#101828;--dimmed:#667085;--border:#e5e9f0;--field:#f8fafc;--blue:#2563eb;--blue-hover:#1d4fd8;
--warn-bg:#fff4e6;--warn-border:#ffd8a8;--warn-text:#a24a0d;--risky:#e8590c;--risky-hover:#d9480f}
@media (prefers-color-scheme:dark){:root{--canvas:#181b22;--card:#1f232b;--text:#d7dce5;--dimmed:#8b93a1;--border:#3a404c;--field:#262b34;
--warn-bg:rgba(232,89,12,.15);--warn-border:rgba(232,89,12,.4);--warn-text:#ffa94d}}
*{box-sizing:border-box}
body{font:15px/1.55 'DM Sans',system-ui,-apple-system,sans-serif;color:var(--text);background:var(--canvas);margin:0;padding:12vh 20px}
main{max-width:560px;margin:auto;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:32px;
box-shadow:0 4px 12px rgba(16,24,40,.08),0 1px 3px rgba(16,24,40,.05)}
.eyebrow{font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--dimmed);margin:0 0 6px}
h1{font-size:24px;font-weight:700;margin:0 0 8px;overflow-wrap:anywhere}
.lead{color:var(--dimmed);margin:0 0 24px}
.warn{background:var(--warn-bg);border:1px solid var(--warn-border);color:var(--warn-text);border-radius:8px;padding:12px 16px 12px 34px;margin:0 0 24px;font-size:14px}
.warn li+li{margin-top:4px}
.label{font-size:13px;font-weight:600;color:var(--dimmed);margin:0 0 6px}
.url,.text{background:var(--field);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin:0 0 20px;overflow-wrap:anywhere;font-size:14px}
.url{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;word-break:break-all}
.actions{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin:28px 0 0}
.actions span{color:var(--dimmed);font-size:14px}
.btn{font-weight:600;font-size:14px;color:#fff;background:var(--blue);border-radius:8px;padding:9px 18px;text-decoration:none}
.btn:hover{background:var(--blue-hover)}
.btn.risky{background:var(--risky)}.btn.risky:hover{background:var(--risky-hover)}
main>:last-child{margin-bottom:0}
</style>
</head><body><main>${body}</main></body></html>`
}
