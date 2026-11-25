import { createHash, createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendBark } from '../src/worker/lib/bark'
import { broadcastBodies, footerText, unsubscribeUrl } from '../src/worker/lib/broadcast'
import { newApiKey, sha256Hex, signWebhook } from '../src/worker/lib/crypto'
import { composeBody } from '../src/worker/lib/compose'
import { decodeEntities, leavePage, linkSigned, linkWarnings, signLink, webUrl } from '../src/worker/lib/links'
import { embedImages, mediaImages, pointToInline } from '../src/worker/lib/inline'
import { MAX_FILE_BYTES, PART_SIZE, cleanFileName, fileUrl, formatBytes, partBytes, partCount, parseRange } from '../src/worker/lib/files'
import { checkClientMetadata, isMetadataUrl, mcpPathDomain, parseScopes, pickRedirectUri, protectedResourceMetadata, resourceDomain, resourceMatches, validRedirectUri, verifyPkce, wwwAuthenticate } from '../src/worker/lib/oauth'
import { findBlockRule } from '../src/worker/lib/spam'
import { deleteAttachments, parseSender } from '../src/worker/lib/mailer'
import { confirmationEmail, normalizeOrigin, turnstileSecretAccepted, verifyTurnstile } from '../src/worker/lib/subscribe'
import { bareAddress, domainOf, fillVariables, isDomainName, parseAddressList } from '../src/worker/lib/text'

describe('text', () => {
  it('reads addresses and domains', () => {
    expect(bareAddress('Ann Lee <Ann@Example.COM>')).toBe('ann@example.com')
    expect(domainOf('Ann <ann@Mail.Example.com>')).toBe('mail.example.com')
    expect(parseAddressList('a@b.co, Ann <c@d.io>; e@f.dev')).toEqual(['a@b.co', 'Ann <c@d.io>', 'e@f.dev'])
    expect(parseAddressList('a@b.co, nope')).toBeNull()
    expect(parseSender('"Robot" <noreply@example.com>')).toEqual({ email: 'noreply@example.com', name: 'Robot' })
  })

  it('tells domain names apart', () => {
    for (const ok of ['example.com', 'mail.example.co.uk', 'xn--bcher-kva.de']) expect(isDomainName(ok)).toBe(true)
    for (const bad of ['example', 'http://example.com', '-a.com', 'a..com', 'Example.com']) expect(isDomainName(bad)).toBe(false)
  })

  it('fills known placeholders only', () => {
    expect(fillVariables('Hi {{ first_name }}, {{other}}', { first_name: 'Ann' })).toBe('Hi Ann, {{other}}')
  })
})

describe('deleteAttachments', () => {
  const bucket = (del: (keys: string[]) => Promise<void>) => ({ BUCKET: { delete: del } }) as unknown as Parameters<typeof deleteAttachments>[0]

  it('stays within what R2 takes in one delete', async () => {
    const del = vi.fn(async (_keys: string[]) => {})
    await deleteAttachments(bucket(del), Array.from({ length: 2001 }, (_, i) => `mail/1/x/${i}`))
    expect(del.mock.calls.map(([keys]) => keys.length)).toEqual([1000, 1000, 1])
  })

  it('makes no call without keys or a bucket', async () => {
    const del = vi.fn(async (_keys: string[]) => {})
    await deleteAttachments(bucket(del), [])
    expect(del).not.toHaveBeenCalled()
    await expect(deleteAttachments({}, ['mail/k'])).resolves.toBeUndefined()
  })

  it('never deletes files of the library that sent mail lists', async () => {
    const del = vi.fn(async (_keys: string[]) => {})
    await deleteAttachments(bucket(del), ['files/abc', 'media/x.png', 'mail/1/u/0'])
    expect(del.mock.calls).toEqual([[['mail/1/u/0']]])
    del.mockClear()
    await deleteAttachments(bucket(del), ['files/abc'])
    expect(del).not.toHaveBeenCalled()
  })

  it('logs a failure instead of throwing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(deleteAttachments(bucket(() => Promise.reject(new Error('down'))), ['mail/k'])).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledOnce()
    log.mockRestore()
  })
})

describe('bark', () => {
  const env = { BARK_SERVER_URL: 'https://bark.test/', BARK_DEVICE_KEY: 'secretkey' } as Parameters<typeof sendBark>[0]
  const push = { title: 't', body: 'b' }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('says which setting is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await sendBark({ ...env, BARK_DEVICE_KEY: undefined }, push)).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.any(String), 'BARK_DEVICE_KEY')
  })

  it('posts to the device key', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    expect(await sendBark(env, push)).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('https://bark.test/secretkey', expect.objectContaining({ method: 'POST' }))
  })

  it('logs a refusal and a network error without the key', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', async () => new Response('no device secretkey', { status: 400 }))
    expect(await sendBark(env, push)).toBe(false)
    vi.stubGlobal('fetch', async () => {
      throw new Error('cannot reach https://bark.test/secretkey')
    })
    expect(await sendBark(env, push)).toBe(false)
    expect(error).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(error.mock.calls)).not.toContain('secretkey')
  })
})

describe('broadcasts', () => {
  const domain = { name: 'example.com', brand: 'Example Studio', footer: '' }

  it('uses the domain for the footer', () => {
    expect(footerText(domain)).toBe('You are receiving this because you subscribed to Example Studio updates.')
    expect(footerText({ ...domain, brand: '' })).toContain('example.com updates')
    expect(footerText({ ...domain, footer: 'Our own line.' })).toBe('Our own line.')
  })

  it('adds the footer and unsubscribe link unless the message has its own', () => {
    const url = unsubscribeUrl('https://mail.example.com/', 'abc123')
    expect(url).toBe('https://mail.example.com/u/abc123')
    const plain = broadcastBodies({ message: 'Hello {{first_name}}', format: 'text', subject: 'Hi' }, 'Footer <line>', url, { email: 'a@b.co', firstName: 'Ann' })
    expect(plain.text).toBe(`Hello Ann\n\n—\nFooter <line>\nUnsubscribe: ${url}`)
    expect(plain.html).toContain('Footer &lt;line&gt;')
    expect(plain.html).toContain(`href="${url}"`)

    const own = broadcastBodies({ message: '<p><a href="{{unsubscribe_url}}">Leave</a></p>', format: 'html', subject: 'Hi' }, 'Footer', url)
    expect(own.html).toBe(`<p><a href="${url}">Leave</a></p>`)
    expect(own.text).not.toContain('Footer')
  })

  it('drops a bare unsubscribe placeholder and adds the footer instead', () => {
    const url = unsubscribeUrl('https://mail.example.com', 'abc123')
    // What an assistant wrote: the placeholder alone on the last line.
    const bare = broadcastBodies({ message: 'Hi there,\n\nNews.\n\nThe team\n\n{{unsubscribe_url}}', format: 'text', subject: 'Hi' }, 'Why you get this.', url)
    expect(bare.text).toBe(`Hi there,\n\nNews.\n\nThe team\n\n—\nWhy you get this.\nUnsubscribe: ${url}`)
    expect(bare.html).toContain('Why you get this.')
    expect(bare.html.match(new RegExp(url, 'g'))).toHaveLength(1)

    const bareHtml = broadcastBodies({ message: '<p>News</p><p> {{ unsubscribe_url }} </p>', format: 'html', subject: 'Hi' }, 'Why you get this.', url)
    expect(bareHtml.html).toContain('Why you get this.')
    expect(bareHtml.html).not.toContain('<p> ')

    // Worded by the author: left as it is, without a second link.
    const worded = broadcastBodies({ message: 'News.\nUnsubscribe here: {{unsubscribe_url}}', format: 'text', subject: 'Hi' }, 'Why you get this.', url)
    expect(worded.text).toBe(`News.\nUnsubscribe here: ${url}`)
  })
})

describe('keys and signatures', () => {
  it('makes API keys that are only kept as a hash', async () => {
    const { key, prefix, hash } = await newApiKey()
    expect(key).toMatch(/^mr_[A-Za-z0-9_-]{32}$/)
    expect(key.startsWith(prefix)).toBe(true)
    expect(hash).toBe(await sha256Hex(key))
  })

  it('signs webhooks the way docs/api.md tells receivers to check them', async () => {
    const body = JSON.stringify({ id: '1', type: 'ping', data: {} })
    const expected = createHmac('sha256', 'whsec_test').update(`1700000000.${body}`).digest('hex')
    expect(await signWebhook('whsec_test', 1700000000, body)).toBe(expected)
  })
})

describe('sign-up forms', () => {
  const answer = (body: object) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))))
  const options = { hostnames: ['example.com'], allowTestKeys: false }
  const good = { success: true, action: 'subscribe', hostname: 'example.com' }

  afterEach(() => vi.unstubAllGlobals())

  it('takes only a website address as an origin', () => {
    expect(normalizeOrigin('https://Example.com/')).toBe('https://example.com')
    expect(normalizeOrigin('http://localhost:5173')).toBe('http://localhost:5173')
    for (const bad of ['http://example.com', 'https://example.com/form', 'https://example.com?a=1', 'example.com', 'ftp://example.com']) expect(normalizeOrigin(bad)).toBeNull()
  })

  it('needs success, the action and an allowed hostname from Turnstile', async () => {
    answer(good)
    expect(await verifyTurnstile('s', 'token', options)).toBe('ok')
    for (const bad of [{ ...good, success: false }, { ...good, action: 'login' }, { ...good, hostname: 'evil.test' }, { success: true }]) {
      answer(bad)
      expect(await verifyTurnstile('s', 'token', options)).toBe('refused')
    }
  })

  it('fails closed', async () => {
    const fetchMock = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'error').mockImplementationOnce(() => {})
    expect(await verifyTurnstile('s', 'token', options)).toBe('refused')
    fetchMock.mockClear()
    expect(await verifyTurnstile('s', 'x'.repeat(2049), options)).toBe('refused')
    expect(await verifyTurnstile('s', undefined, options)).toBe('refused')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('takes test keys only from a local page', async () => {
    answer({ success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } })
    expect(await verifyTurnstile('s', 'token', options)).toBe('refused')
    expect(await verifyTurnstile('s', 'token', { ...options, allowTestKeys: true })).toBe('ok')
  })

  it('tells a bad secret from a bad token', async () => {
    // As Cloudflare really answers: HTTP 400, with the reason in the JSON.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-secret'] }), { status: 400 })))
    expect(await verifyTurnstile('s', 'token', options)).toBe('bad_secret')
    expect(await turnstileSecretAccepted('s')).toBe(false)
    answer({ success: false, 'error-codes': ['invalid-input-response'] })
    expect(await verifyTurnstile('s', 'token', options)).toBe('refused')
    expect(await turnstileSecretAccepted('s')).toBe(true)
  })

  it('escapes the brand in the confirmation email', () => {
    const mail = confirmationEmail('A <b> & Co', 'https://m.example.com/c/abc')
    expect(mail.subject).toContain('A <b> & Co')
    expect(mail.html).toContain('A &lt;b&gt; &amp; Co')
    expect(mail.html).toContain('href="https://m.example.com/c/abc"')
    expect(mail.text).toContain('https://m.example.com/c/abc')
  })
})

describe('composeBody', () => {
  const link = { name: 'video.mp4', size: 3 * 1024 ** 3, url: 'https://m.example.com/f/abc/video.mp4' }

  it('leaves plain text alone without extras', () => {
    expect(composeBody({ message: { format: 'text', body: ' Hi there \n' } })).toEqual({ text: 'Hi there' })
  })

  it('adds links, then the quote, in plain text', () => {
    const { text, html } = composeBody({
      message: { format: 'text', body: 'Here it is.' },
      links: [link],
      quote: { attribution: 'On 2026-11-01, Bob wrote:', text: 'Send it?\nThanks' },
    })
    expect(html).toBeUndefined()
    expect(text).toBe(
      'Here it is.\n\nFiles:\n- video.mp4 (3.0 GB): https://m.example.com/f/abc/video.mp4\n\nOn 2026-11-01, Bob wrote:\n> Send it?\n> Thanks',
    )
  })

  it('escapes a plain message inside HTML links', () => {
    const { text, html } = composeBody({ message: { format: 'html', body: '<p>Hello</p>' }, links: [{ ...link, name: '<x>.zip' }] })
    expect(html!.startsWith('<p>Hello</p>')).toBe(true)
    expect(html).toContain('&lt;x&gt;.zip')
    expect(text).toContain('- <x>.zip (3.0 GB): https://m.example.com/f/abc/video.mp4')
  })
})

describe('files', () => {
  it('splits uploads into equal parts but the last', () => {
    expect(partCount(1)).toBe(1)
    expect(partCount(PART_SIZE)).toBe(1)
    expect(partCount(PART_SIZE + 1)).toBe(2)
    expect(partBytes(PART_SIZE + 1, 1)).toBe(PART_SIZE)
    expect(partBytes(PART_SIZE + 1, 2)).toBe(1)
    expect(partBytes(5, 1)).toBe(5)
    expect(partCount(MAX_FILE_BYTES)).toBe(10_000)
  })

  it('reads Range headers', () => {
    expect(parseRange(undefined, 100)).toBeNull()
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=9-3', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable')
    // Several ranges, other units, nonsense: the whole file.
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull()
    expect(parseRange('items=0-1', 100)).toBeNull()
    expect(parseRange('bytes=-', 100)).toBeNull()
  })

  it('names and links files safely', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('.._.._etc_passwd')
    expect(cleanFileName('a\u0000b\nc.txt')).toBe('abc.txt')
    expect(cleanFileName('   ')).toBe('file')
    expect(fileUrl('https://m.example.com', { token: 'abc', name: 'Q3 report #2.pdf' })).toBe('https://m.example.com/f/abc/Q3%20report%20%232.pdf')
    expect(formatBytes(500)).toBe('500 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB')
  })
})

describe('inline images', () => {
  const a = 'a'.repeat(32) + '.png'
  const b = 'b'.repeat(32) + '.jpg'
  const html = `<p><img src="https://m.example.com/media/${a}" width="120"></p><img alt="x" src='https://other.host/media/${b}'><img src="https://m.example.com/media/${a}"><img src="https://cdn.example.org/logo.png">`
  const bucket = (objects: Record<string, { size: number; type: string }>) => ({
    get: vi.fn(async (key: string) => {
      const o = objects[key]
      return o ? { size: o.size, httpMetadata: { contentType: o.type }, arrayBuffer: async () => new ArrayBuffer(o.size) } : null
    }),
  }) as unknown as Parameters<typeof embedImages>[0]

  it('finds library images once each, in order', () => {
    expect(mediaImages(html)).toEqual([a, b])
    expect(mediaImages('<img src="https://x.com/media/short.png"><a href="https://m.example.com/media/' + a + '">')).toEqual([])
  })

  it('points only the embedded ones at cid:', () => {
    const out = pointToInline(html, new Set([a]))
    expect(out.match(/cid:mr-a+\.png/g)).toHaveLength(2)
    expect(out).toContain(`src='https://other.host/media/${b}'`)
    expect(out).toContain('width="120"')
  })

  it('embeds what fits and is really an image of ours', async () => {
    const r = await embedImages(bucket({ ['media/' + a]: { size: 100, type: 'image/png' }, ['media/' + b]: { size: 50, type: 'image/jpeg' } }), html, 1000)
    expect(r.images.map((i) => [i.disposition, i.contentId, i.type])).toEqual([
      ['inline', `mr-${a}`, 'image/png'],
      ['inline', `mr-${b}`, 'image/jpeg'],
    ])
    expect(r.bytes).toBe(150)
    expect(r.html).not.toContain('/media/')

    // Over budget, missing, or not an image type: stays remote.
    const tight = await embedImages(bucket({ ['media/' + a]: { size: 100, type: 'image/png' }, ['media/' + b]: { size: 50, type: 'text/html' } }), html, 99)
    expect(tight.images).toEqual([])
    expect(tight.html).toBe(html)
    expect((await embedImages(undefined, html, 1000)).html).toBe(html)
  })
})

describe('findBlockRule', () => {
  const rules = [
    { id: 1, kind: 'address' as const, value: 'bad@spam.io' },
    { id: 2, kind: 'domain' as const, value: 'kiev.ua' },
    { id: 3, kind: 'keyword' as const, value: 'late husband' },
  ]
  const mail = (from: string, subject = 'hi', text = '') => ({ from, subject, text })

  it('catches by address, domain and keyword', () => {
    expect(findBlockRule(rules, mail('Bad <BAD@spam.io>'))?.id).toBe(1)
    expect(findBlockRule(rules, mail('Mrs S <s@ipp.kiev.ua>'))?.id).toBe(2)
    expect(findBlockRule(rules, mail('x@ok.com', 'Help', 'My Late Husband died'))?.id).toBe(3)
  })

  it('leaves other mail alone', () => {
    expect(findBlockRule(rules, mail('good@spam.io'))).toBeNull()
    expect(findBlockRule(rules, mail('a@notkiev.ua'))).toBeNull()
  })
})

describe('oauth', () => {
  const origin = 'https://mail.example.com'

  it('takes https redirects, or http on this computer only', () => {
    for (const ok of ['https://chatgpt.com/connector_platform_oauth_redirect', 'http://localhost:3334/callback', 'http://127.0.0.1/cb']) expect(validRedirectUri(ok)).toBe(true)
    for (const bad of ['http://evil.com/cb', 'https://a.com/cb#x', 'javascript:alert(1)', 'https://user:pw@a.com/', 'not a url']) expect(validRedirectUri(bad)).toBe(false)
  })

  it('keeps only known scopes, all of them when none are asked for', () => {
    expect(parseScopes('contacts openid broadcasts')).toEqual(['contacts', 'broadcasts'])
    expect(parseScopes('')).toEqual(['send', 'contacts', 'broadcasts'])
    expect(parseScopes('openid')).toEqual([])
  })

  it('accepts this server as the resource, and nothing else', () => {
    expect(resourceMatches(undefined, origin)).toBe(true)
    expect(resourceMatches(`${origin}/mcp`, origin)).toBe(true)
    expect(resourceMatches(`${origin}/`, origin)).toBe(true)
    expect(resourceMatches('https://other.example.com/mcp', origin)).toBe(false)
    expect(resourceMatches(`${origin}/v1`, origin)).toBe(false)
  })

  it("reads a domain's own MCP address", () => {
    expect(resourceDomain(undefined, origin)).toBe('')
    expect(resourceDomain(`${origin}/mcp`, origin)).toBe('')
    expect(resourceDomain(`${origin}/mcp/Example.com`, origin)).toBe('example.com')
    expect(resourceDomain(`${origin}/mcp/example.com/`, origin)).toBe('example.com')
    expect(resourceDomain(`${origin}/mcp/not a domain`, origin)).toBeNull()
    expect(resourceDomain(`${origin}/mcp/a.com/x`, origin)).toBeNull()
    expect(resourceDomain('https://other.example.com/mcp/a.com', origin)).toBeNull()
    expect(mcpPathDomain('/mcp/mzjpg.com')).toBe('mzjpg.com')
    expect(mcpPathDomain('/mcp')).toBeNull()
    expect(protectedResourceMetadata(origin, 'a.com').resource).toBe(`${origin}/mcp/a.com`)
    expect(wwwAuthenticate(origin, undefined, 'a.com')).toContain(`${origin}/.well-known/oauth-protected-resource/mcp/a.com`)
  })

  it('checks PKCE S256', async () => {
    const verifier = 'a'.repeat(20) + '-._~' + 'Z9'.repeat(10)
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    expect(await verifyPkce(verifier, challenge)).toBe(true)
    expect(await verifyPkce(verifier + 'x', challenge)).toBe(false)
    // Too short to be a verifier at all.
    expect(await verifyPkce('abc', createHash('sha256').update('abc').digest('base64url'))).toBe(false)
  })

  it('trusts a client metadata document only for its own URL', () => {
    const url = 'https://chatgpt.com/oauth/client.json'
    const doc = { client_id: url, client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }
    expect(checkClientMetadata(doc, url)).toEqual({ ok: true, name: 'ChatGPT', redirectUris: doc.redirect_uris })
    expect(checkClientMetadata({ ...doc, client_id: 'https://evil.example/client.json' }, url).ok).toBe(false)
    expect(checkClientMetadata({ ...doc, redirect_uris: ['http://evil.example/cb'] }, url).ok).toBe(false)
    expect(checkClientMetadata({ ...doc, client_secret: 'x' }, url).ok).toBe(false)
    expect(checkClientMetadata(null, url).ok).toBe(false)
  })

  it('tells metadata URLs from registered client ids', () => {
    expect(isMetadataUrl('https://chatgpt.com/oauth/client.json')).toBe(true)
    for (const no of ['mrc_abc', 'https://chatgpt.com/', 'http://chatgpt.com/c.json', 'https://localhost/c.json', 'https://a.com:8443/c.json']) expect(isMetadataUrl(no)).toBe(false)
  })

  it('sends codes only to a registered redirect', () => {
    const client = { redirectUris: ['https://a.com/cb'] } as Parameters<typeof pickRedirectUri>[0]
    expect(pickRedirectUri(client, undefined)).toBe('https://a.com/cb')
    expect(pickRedirectUri(client, 'https://a.com/cb')).toBe('https://a.com/cb')
    expect(pickRedirectUri(client, 'https://a.com/cb2')).toBeNull()
    expect(pickRedirectUri({ ...client, redirectUris: ['https://a.com/1', 'https://a.com/2'] }, undefined)).toBeNull()
  })

  it('points a 401 at the resource metadata', () => {
    expect(wwwAuthenticate(origin)).toBe(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="send contacts broadcasts"`)
    expect(wwwAuthenticate(origin, 'invalid_token')).toContain('error="invalid_token"')
  })
})

describe('links', () => {
  it('only takes web links, entities decoded', () => {
    expect(webUrl(' https://a.com/?x=1&amp;y=2 ')?.href).toBe('https://a.com/?x=1&y=2')
    for (const no of ['mailto:a@b.co', 'javascript:alert(1)', '/relative', 'tel:123']) expect(webUrl(no)).toBeNull()
    expect(decodeEntities('&lt;b&gt; &#65;&#x42; &bogus;')).toBe('<b> AB &bogus;')
  })

  it('warns about links that are not what they say', () => {
    const w = (href: string, text = '') => linkWarnings(new URL(href), text)
    expect(w('https://example.com/a', 'Read more')).toEqual([])
    expect(w('https://mail.example.com/', 'www.example.com')).toEqual([])
    expect(w('https://evil.io/login', 'https://paypal.com/login')[0]).toContain('says paypal.com')
    expect(w('https://paypal.com@evil.io/')[0]).toContain('evil.io')
    expect(w('http://10.0.0.1/')).toHaveLength(2)
    expect(w('https://аpple.com/')[0]).toContain('non-Latin')
  })

  it('signs links so the page only vouches for its own', async () => {
    const sig = await signLink('pw', 'https://a.com/', 'A')
    expect(await linkSigned('pw', 'https://a.com/', 'A', sig)).toBe(true)
    expect(await linkSigned('pw', 'https://b.com/', 'A', sig)).toBe(false)
    expect(await linkSigned('other', 'https://a.com/', 'A', sig)).toBe(false)
    expect(leavePage(new URL('https://a.com/'), '', false)).not.toContain('Open link')
    expect(leavePage(new URL('https://a.com/"><x>'), '', true)).not.toContain('"><x>')
  })
})
