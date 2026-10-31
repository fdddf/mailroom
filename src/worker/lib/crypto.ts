// WebCrypto helpers: the admin session, stored secrets, API keys and webhook
// signatures.

const encoder = new TextEncoder()

export const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
export const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const toBase64Url = (bytes: Uint8Array) => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromBase64Url = (s: string) =>
  fromBase64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))

const hmacKey = (raw: Uint8Array<ArrayBuffer> | string, usages: KeyUsage[]) =>
  crypto.subtle.importKey('raw', typeof raw === 'string' ? encoder.encode(raw) : raw, { name: 'HMAC', hash: 'SHA-256' }, false, usages)

const equalBytes = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

// Compare two secrets without leaking where they differ.
export const secretsMatch = async (given: string, expected: string) => {
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  return equalBytes(new Uint8Array(a), new Uint8Array(b))
}

// ---- Admin session ----------------------------------------------------------
// One password (ADMIN_PASSWORD), no user table. A session is an HttpOnly
// cookie holding `<expiry>.<HMAC(expiry)>`, keyed by the password itself, so
// changing the password signs everyone out.

export const SESSION_COOKIE = 'mz_admin'
export const SESSION_SECONDS = 7 * 24 * 60 * 60

export const signSession = async (password: string, expires: number) => {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(password, ['sign']), encoder.encode(`admin:${expires}`))
  return `${expires}.${toBase64Url(new Uint8Array(sig))}`
}

export const verifySession = async (password: string, value: string | undefined) => {
  if (!value) return false
  const [expStr, sig] = value.split('.')
  const expires = Number(expStr)
  if (!expires || !sig || expires < Date.now() / 1000) return false
  try {
    return await crypto.subtle.verify(
      'HMAC',
      await hmacKey(password, ['verify']),
      fromBase64Url(sig),
      encoder.encode(`admin:${expires}`),
    )
  } catch {
    return false
  }
}

// ---- Stored secrets ---------------------------------------------------------
// API keys kept in D1 are encrypted (AES-GCM) with a key derived from
// ADMIN_PASSWORD, so a copy of the database alone does not reveal them.
// Changing the password makes them unreadable; they are then entered again.

const secretKey = async (password: string, usages: KeyUsage[]) =>
  crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(`mz-secret:${password}`)), 'AES-GCM', false, usages)

export const encryptSecret = async (password: string, plain: string) => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await secretKey(password, ['encrypt']), encoder.encode(plain)))
  return `v1.${toBase64(iv)}.${toBase64(data)}`
}

// null if it cannot be read (wrong password, damaged value).
export const decryptSecret = async (password: string, stored: string) => {
  const [version, iv, data] = stored.split('.')
  if (version !== 'v1' || !iv || !data) return null
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, await secretKey(password, ['decrypt']), fromBase64(data))
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

// ---- API keys and webhooks --------------------------------------------------

const toHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

export const sha256Hex = async (s: string) => toHex(await crypto.subtle.digest('SHA-256', encoder.encode(s)))

// Random URL-safe text with `bytes` bytes of entropy.
export const randomToken = (bytes = 24) => toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))

// A new /v1 key: what to show once, what to keep, and how to recognise it.
export const newApiKey = async () => {
  const key = `mr_${randomToken(24)}`
  return { key, prefix: key.slice(0, 11), hash: await sha256Hex(key) }
}

// The webhook signature: HMAC-SHA256 of "<timestamp>.<body>" with the
// webhook's secret, hex (docs/api.md#webhooks).
export const signWebhook = async (secret: string, timestamp: number, body: string) =>
  toHex(await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), encoder.encode(`${timestamp}.${body}`)))
