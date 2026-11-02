import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendBark } from '../src/worker/lib/bark'
import { broadcastBodies, footerText, unsubscribeUrl } from '../src/worker/lib/broadcast'
import { newApiKey, sha256Hex, signWebhook } from '../src/worker/lib/crypto'
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
    await deleteAttachments(bucket(del), Array.from({ length: 2001 }, (_, i) => `k${i}`))
    expect(del.mock.calls.map(([keys]) => keys.length)).toEqual([1000, 1000, 1])
  })

  it('makes no call without keys or a bucket', async () => {
    const del = vi.fn(async (_keys: string[]) => {})
    await deleteAttachments(bucket(del), [])
    expect(del).not.toHaveBeenCalled()
    await expect(deleteAttachments({}, ['k'])).resolves.toBeUndefined()
  })

  it('logs a failure instead of throwing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(deleteAttachments(bucket(() => Promise.reject(new Error('down'))), ['k'])).resolves.toBeUndefined()
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
