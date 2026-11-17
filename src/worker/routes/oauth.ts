// OAuth for MCP clients (lib/oauth.ts says what and why):
//
//   /.well-known/oauth-protected-resource[/mcp]   which server signs in for /mcp
//   /.well-known/oauth-authorization-server       this server's endpoints
//   POST /oauth/register                           dynamic client registration
//   GET|POST /oauth/authorize                      the approval page
//   POST /oauth/token                              codes and refresh tokens -> tokens
//
// The approval page is the only one a person sees; it may sit behind
// Cloudflare Access like the dashboard. The others are called by the apps
// themselves and stay public.

import { asc } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { getDb } from '../db'
import { API_SCOPES, domain, type ApiScope, type OauthClient } from '../db/schema'
import type { AppEnv } from '../env'
import { secretsMatch } from '../lib/crypto'
import {
  approve,
  authenticateClient,
  authorizationServerMetadata,
  exchangeCode,
  findClient,
  parseScopes,
  pickRedirectUri,
  protectedResourceMetadata,
  refreshTokens,
  registerClient,
  resourceMatches,
} from '../lib/oauth'
import { escapeHtml } from './public'

const SCOPE_TEXT: Record<ApiScope, string> = {
  contacts: 'Manage contacts: add, list and unsubscribe them',
  send: 'Send single emails from this domain',
  broadcasts: 'Write broadcasts, and send them to your contacts',
}

const origin = (c: Context<AppEnv>) => new URL(c.req.url).origin

// The query of an authorization request, or the same fields posted back
// from the page.
type AuthRequest = {
  response_type?: string
  client_id?: string
  redirect_uri?: string
  state?: string
  scope?: string
  code_challenge?: string
  code_challenge_method?: string
  resource?: string
}
const FIELDS = ['response_type', 'client_id', 'redirect_uri', 'state', 'scope', 'code_challenge', 'code_challenge_method', 'resource'] as const

const noStore = { 'Cache-Control': 'no-store', Pragma: 'no-cache' }

const tokenError = (c: Context<AppEnv>, error: string, description: string, status: 400 | 401 | 429 = 400) =>
  c.json({ error, error_description: description }, status, noStore)

// Back to the app, with the answer and who gave it (RFC 9207).
const redirectBack = (c: Context<AppEnv>, redirectUri: string, params: Record<string, string | undefined>) => {
  const url = new URL(redirectUri)
  for (const [k, v] of Object.entries({ ...params, iss: origin(c) })) if (v !== undefined) url.searchParams.set(k, v)
  return c.redirect(url.toString(), 302)
}

const authPage = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Mailroom</title>
<style>body{font:15px/1.55 system-ui,-apple-system,sans-serif;color:#141413;background:#faf9f5;margin:0;padding:10vh 20px}
main{max-width:440px;margin:auto;background:#fff;border:1px solid #e6e4dc;border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 6px}p{color:#68685f;margin:0 0 16px}.err{color:#b42318;background:#fef3f2;border-radius:8px;padding:8px 12px}
label{display:block;font-weight:600;margin:16px 0 6px}.check{display:flex;gap:8px;font-weight:400;margin:6px 0;align-items:flex-start}.check input{margin-top:4px}
select,input[type=password]{font:inherit;width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d6d3c8;border-radius:8px;background:#fff;color:inherit}
.host{font-family:ui-monospace,monospace;background:#f2f1ec;border-radius:4px;padding:1px 5px}
.actions{display:flex;gap:10px;margin-top:22px}button{font:inherit;font-weight:600;border-radius:8px;padding:9px 18px;cursor:pointer;border:1px solid #d6d3c8;background:#fff;color:inherit}
button.primary{color:#fff;background:#2563eb;border-color:#2563eb}
@media (prefers-color-scheme:dark){body{color:#f4f3ee;background:#1f1e1b}main{background:#262522;border-color:#3a3833}p{color:#b5b3a8}
select,input[type=password],button{background:#1f1e1b;border-color:#4a4842}.host{background:#33322d}.err{background:#3b1d1a;color:#fda29b}}</style>
</head><body><main>${body}</main></body></html>`

const PAGE_HEADERS = {
  ...noStore,
  // Not in a frame: approving must be a click on this page itself.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
}

const errorPage = (c: Context<AppEnv>, message: string, status: 400 | 404 = 400) =>
  c.html(authPage('Cannot sign in', `<h1>This app cannot sign in</h1><p class="err">${escapeHtml(message)}</p><p>Go back to the app and try connecting again.</p>`), status, PAGE_HEADERS)

// Check an authorization request. Problems with the client or its
// redirect_uri are shown here (sending anything to an unchecked address
// would be an open redirect); the rest go back to the app.
const checkRequest = async (c: Context<AppEnv>, q: AuthRequest, refresh: boolean) => {
  if (!q.client_id) return { page: errorPage(c, 'The request has no client_id.') }
  const found = await findClient(getDb(c.env.DB), q.client_id, { refresh })
  if (!found.ok) return { page: errorPage(c, found.error) }
  const redirectUri = pickRedirectUri(found.client, q.redirect_uri)
  if (!redirectUri) return { page: errorPage(c, 'The redirect_uri is not one this app registered.') }
  const back = (error: string, description: string) => ({ page: redirectBack(c, redirectUri, { error, error_description: description, state: q.state }) })
  if (q.response_type !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported')
  if (!q.code_challenge || q.code_challenge_method !== 'S256') return back('invalid_request', 'PKCE with code_challenge_method=S256 is required')
  if (!resourceMatches(q.resource, origin(c))) return back('invalid_target', `resource must be ${origin(c)}/mcp`)
  const scopes = parseScopes(q.scope)
  if (!scopes.length) return back('invalid_scope', `Scopes: ${API_SCOPES.join(', ')}`)
  return { client: found.client, redirectUri, scopes, codeChallenge: q.code_challenge }
}

const consentPage = async (c: Context<AppEnv>, q: AuthRequest, client: OauthClient, redirectUri: string, scopes: ApiScope[], error?: string) => {
  const domains = await getDb(c.env.DB).select({ id: domain.id, name: domain.name }).from(domain).orderBy(asc(domain.name))
  if (!domains.length) return errorPage(c, 'Mailroom has no domains yet. Add one in the dashboard first.')
  const host = new URL(redirectUri).host
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host)
  const hidden = FIELDS.map((k) => (q[k] ? `<input type="hidden" name="${k}" value="${escapeHtml(q[k]!)}">` : '')).join('')
  const name = client.name || host
  return c.html(
    authPage(
      `Connect ${name}`,
      `<h1>Connect ${escapeHtml(name)} to Mailroom?</h1>
<p>It will act for you on the domain you choose, through Mailroom's MCP server. After you approve, you go back to <span class="host">${escapeHtml(host)}</span>.</p>
${local ? '<p class="err">This app runs on your own computer (localhost). Only approve it if you started it yourself.</p>' : ''}
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/oauth/authorize">${hidden}
<label for="domain">Domain</label>
<select id="domain" name="domain">${domains.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('')}</select>
<label>It may</label>
${scopes.map((s) => `<div class="check"><input type="checkbox" id="s-${s}" name="scopes" value="${s}" checked><label class="check" for="s-${s}" style="margin:0">${escapeHtml(SCOPE_TEXT[s])}</label></div>`).join('')}
<label for="password">Dashboard password</label>
<input type="password" id="password" name="password" autocomplete="current-password" required autofocus>
<div class="actions"><button class="primary" name="action" value="approve">Approve</button><button name="action" value="deny" formnovalidate>Deny</button></div>
</form>`,
    ),
    error ? 401 : 200,
    PAGE_HEADERS,
  )
}

const metadataCors = cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version'], maxAge: 86400 })

export const oauthRoutes = new Hono<AppEnv>()
  .use('/.well-known/*', metadataCors)
  .use('/oauth/register', metadataCors)
  .use('/oauth/token', metadataCors)

  // Both the path-suffixed address (for /mcp) and the root one; clients try either.
  .get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResourceMetadata(origin(c))))
  .get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(protectedResourceMetadata(origin(c))))
  .get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata(origin(c))))

  .post('/oauth/register', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (!body || typeof body !== 'object') return tokenError(c, 'invalid_client_metadata', 'Send the client metadata as JSON')
    const result = await registerClient(getDb(c.env.DB), body)
    if (!result.ok) return tokenError(c, result.error, result.description, 'status' in result ? result.status : 400)
    return c.json(result.client, 201, noStore)
  })

  .get('/oauth/authorize', async (c) => {
    if (!c.env.ADMIN_PASSWORD) return errorPage(c, 'Mailroom has no dashboard password set (ADMIN_PASSWORD).')
    const q = Object.fromEntries(FIELDS.map((k) => [k, c.req.query(k)])) as AuthRequest
    const checked = await checkRequest(c, q, true)
    if ('page' in checked) return checked.page
    return consentPage(c, q, checked.client, checked.redirectUri, checked.scopes)
  })

  .post('/oauth/authorize', async (c) => {
    if (!c.env.ADMIN_PASSWORD) return errorPage(c, 'Mailroom has no dashboard password set (ADMIN_PASSWORD).')
    const form = await c.req.parseBody({ all: true })
    const one = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : undefined)
    const q = Object.fromEntries(FIELDS.map((k) => [k, one(k)])) as AuthRequest
    const checked = await checkRequest(c, q, false)
    if ('page' in checked) return checked.page
    const { client, redirectUri, scopes } = checked
    if (one('action') !== 'approve') return redirectBack(c, redirectUri, { error: 'access_denied', error_description: 'The request was denied', state: q.state })

    if (!(await secretsMatch(one('password') ?? '', c.env.ADMIN_PASSWORD))) {
      // Slow down guessing a little; the real defence is a long password.
      await new Promise((resolve) => setTimeout(resolve, 800))
      return consentPage(c, q, client, redirectUri, scopes, 'Wrong password.')
    }
    const chosen = ([] as unknown[]).concat(form.scopes ?? []).filter((s): s is ApiScope => scopes.includes(s as ApiScope))
    if (!chosen.length) return consentPage(c, q, client, redirectUri, scopes, 'Choose at least one thing it may do.')
    const db = getDb(c.env.DB)
    const domainId = Number(one('domain'))
    const own = domainId > 0 && (await db.query.domain.findFirst({ columns: { id: true }, where: (d, { eq }) => eq(d.id, domainId) }))
    if (!own) return consentPage(c, q, client, redirectUri, scopes, 'Choose a domain.')

    const code = await approve(db, { clientId: client.id, domainId, scopes: chosen, redirectUri, codeChallenge: checked.codeChallenge })
    return redirectBack(c, redirectUri, { code, state: q.state })
  })

  .post('/oauth/token', async (c) => {
    const type = c.req.header('Content-Type') || ''
    const raw = type.includes('application/json') ? await c.req.json().catch(() => ({})) : await c.req.parseBody().catch(() => ({}))
    const p = (k: string) => {
      const v = (raw as Record<string, unknown>)[k]
      return typeof v === 'string' && v ? v : undefined
    }
    // client_secret_basic, else client_secret_post / a public client's id.
    let clientId = p('client_id')
    let secret = p('client_secret')
    const basic = (c.req.header('Authorization') || '').match(/^Basic\s+(.+)$/i)?.[1]
    if (basic) {
      try {
        const [id, pass] = atob(basic).split(':').map((s) => decodeURIComponent(s))
        clientId = id
        secret = pass
      } catch {
        return tokenError(c, 'invalid_client', 'Malformed Basic credentials', 401)
      }
    }
    if (!clientId) return tokenError(c, 'invalid_client', 'No client_id', 401)
    const db = getDb(c.env.DB)
    const found = await findClient(db, clientId, { refresh: false })
    if (!found.ok) return tokenError(c, 'invalid_client', found.error, 401)
    const denied = await authenticateClient(found.client, secret)
    if (denied) return tokenError(c, denied.error, denied.description, 401)
    if (!resourceMatches(p('resource'), origin(c))) return tokenError(c, 'invalid_target', `resource must be ${origin(c)}/mcp`)

    const grantType = p('grant_type')
    const result =
      grantType === 'authorization_code'
        ? p('code')
          ? await exchangeCode(db, found.client, { code: p('code')!, redirectUri: p('redirect_uri'), codeVerifier: p('code_verifier') })
          : { ok: false as const, error: 'invalid_request', description: 'No code' }
        : grantType === 'refresh_token'
          ? p('refresh_token')
            ? await refreshTokens(db, found.client, { refreshToken: p('refresh_token')!, scope: p('scope') })
            : { ok: false as const, error: 'invalid_request', description: 'No refresh_token' }
          : { ok: false as const, error: 'unsupported_grant_type', description: 'authorization_code or refresh_token' }
    return result.ok ? c.json(result.tokens, 200, noStore) : tokenError(c, result.error, result.description)
  })
