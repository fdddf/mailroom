import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { broadcastBodies, footerText, unsubscribeUrl } from '../src/worker/lib/broadcast'
import { newApiKey, sha256Hex, signWebhook } from '../src/worker/lib/crypto'
import { parseSender } from '../src/worker/lib/mailer'
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
