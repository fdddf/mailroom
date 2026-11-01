// Public sign-up forms: the checks on a submission and the confirmation email.
// The routes are in routes/subscribe.ts; docs/api.md says how to use them.

import { lt } from 'drizzle-orm'
import type { Db } from '../db'
import { pendingSubscription } from '../db/schema'
import { escapeHtml } from './broadcast'

// What the widget on the page is told, and Cloudflare must report back.
export const TURNSTILE_ACTION = 'subscribe'

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const MAX_TOKEN = 2048

const isLocalHost = (hostname: string) => hostname === 'localhost' || hostname === '127.0.0.1'

// "https://Example.com/" -> "https://example.com". null unless it is only a
// website's address, on https (http for a local test page).
export const normalizeOrigin = (value: string) => {
  try {
    const url = new URL(value.trim())
    const secure = url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHost(url.hostname))
    return secure && url.pathname === '/' && !url.search && !url.hash && !url.username ? url.origin : null
  } catch {
    return null
  }
}

export const isLocalOrigin = (origin: string) => isLocalHost(new URL(origin).hostname)

type Siteverify = { success?: boolean; action?: string; hostname?: string; 'error-codes'?: string[]; metadata?: { result_with_testing_key?: boolean } }

const siteverify = async (secret: string, token: string, ip?: string) => {
  const r = await fetch(SITEVERIFY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({ secret, response: token, ...(ip && { remoteip: ip }) }),
  })
  // A refusal is a 400 with the reasons in its JSON; no JSON means no answer.
  return (await r.json()) as Siteverify
}

const secretRefused = (result: Siteverify) => (result['error-codes'] ?? []).some((code) => code === 'invalid-input-secret' || code === 'missing-input-secret')

export type TurnstileCheck = 'ok' | 'refused' | 'bad_secret'

// Whether a visitor's token is good for this form, failing closed: a network
// error or an odd answer is a refusal. Cloudflare's published test keys pass any
// token, so they count only from a local test page and never from a website.
export const verifyTurnstile = async (
  secret: string,
  token: unknown,
  { ip, hostnames, allowTestKeys }: { ip?: string; hostnames: string[]; allowTestKeys: boolean },
): Promise<TurnstileCheck> => {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN || !hostnames.length) return 'refused'
  let result: Siteverify
  try {
    result = await siteverify(secret, token, ip)
  } catch (err) {
    console.error('siteverify failed', err)
    return 'refused'
  }
  if (secretRefused(result)) return 'bad_secret'
  if (result.success !== true) return 'refused'
  if (result.metadata?.result_with_testing_key === true) return allowTestKeys ? 'ok' : 'refused'
  return result.action === TURNSTILE_ACTION && hostnames.includes(result.hostname ?? '') ? 'ok' : 'refused'
}

// For the dashboard. False only when Cloudflare says so: if it cannot be asked,
// the form's own errors will show a bad secret soon enough.
export const turnstileSecretAccepted = async (secret: string) => {
  try {
    return !secretRefused(await siteverify(secret, 'XXXX.DUMMY.TOKEN.XXXX'))
  } catch (err) {
    console.error('siteverify failed', err)
    return true
  }
}

export const confirmUrl = (publicUrl: string, token: string) => `${publicUrl.replace(/\/$/, '')}/c/${token}`

export const confirmationEmail = (brand: string, url: string) => {
  const name = escapeHtml(brand)
  return {
    subject: `Confirm your subscription to ${brand}`,
    text: `Please confirm that you want to receive emails from ${brand}:\n\n${url}\n\nIf you did not ask for this, ignore this email and you will not hear from us again. The link works for 7 days.`,
    html: `<p>Please confirm that you want to receive emails from ${name}.</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 20px;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;text-decoration:none">Confirm subscription</a></p>
<p style="font-size:12px;color:#68685f">If you did not ask for this, ignore this email and you will not hear from us again. The link works for 7 days.</p>`,
  }
}

export const purgeExpiredSubscriptions = (db: Db) => db.delete(pendingSubscription).where(lt(pendingSubscription.expiresAt, new Date().toISOString()))
