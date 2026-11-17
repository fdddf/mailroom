// Mailroom as an OAuth 2.1 authorization server for its own MCP server, so
// MCP clients that only sign in with OAuth (ChatGPT, claude.ai) can use
// /mcp. What the MCP authorization spec (2025-11-25) asks for:
//
//   - discovery: protected resource metadata (RFC 9728) pointing at this
//     Worker as the authorization server, and its metadata (RFC 8414);
//   - clients known by a metadata document URL (CIMD, what ChatGPT prefers)
//     or registered on the spot (RFC 7591, what Claude uses);
//   - authorization code with PKCE S256 only, `resource` checked (RFC 8707),
//     `iss` on every authorization response (RFC 9207);
//   - short access tokens, refresh tokens rotated on every use.
//
// Approving an app takes the dashboard password and picks one domain and
// its scopes; the grant then works like an API key with those scopes.
// Tokens are random and kept only as SHA-256 hashes. Routes: routes/oauth.ts.

import { and, eq, gt, inArray, isNull, lt, notExists, sql } from 'drizzle-orm'
import type { Db } from '../db'
import { API_SCOPES, oauthClient, oauthGrant, oauthToken, type ApiScope, type OauthClient } from '../db/schema'
import { pkceChallenge, randomToken, sha256Hex } from './crypto'

export const CODE_SECONDS = 10 * 60
export const ACCESS_SECONDS = 60 * 60
export const REFRESH_SECONDS = 30 * 24 * 60 * 60
// A metadata document is read again after this.
const CIMD_MAX_AGE_MS = 24 * 60 * 60 * 1000
const CIMD_MAX_BYTES = 64 * 1024

export const MCP_PATH = '/mcp'
export const ACCESS_PREFIX = 'mro_'
const REFRESH_PREFIX = 'mrr_'

// Everything is named after the address the client used, so that the
// resource it was told to connect to and the metadata agree.
export const resourceUrl = (origin: string) => origin + MCP_PATH
export const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`

export const protectedResourceMetadata = (origin: string) => ({
  resource: resourceUrl(origin),
  authorization_servers: [origin],
  scopes_supported: [...API_SCOPES],
  bearer_methods_supported: ['header'],
  resource_name: 'Mailroom',
  resource_documentation: 'https://github.com/fdddf/mailroom/blob/main/docs/mcp.md',
})

export const authorizationServerMetadata = (origin: string) => ({
  issuer: origin,
  authorization_endpoint: `${origin}/oauth/authorize`,
  token_endpoint: `${origin}/oauth/token`,
  registration_endpoint: `${origin}/oauth/register`,
  scopes_supported: [...API_SCOPES],
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
})

// What a 401 from /mcp says, so a client finds where to sign in.
export const wwwAuthenticate = (origin: string, error?: 'invalid_token') =>
  `Bearer resource_metadata="${resourceMetadataUrl(origin)}", scope="${API_SCOPES.join(' ')}"${error ? `, error="${error}"` : ''}`

// ---- Checks -----------------------------------------------------------------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

// Where codes may be sent: https, or http on this computer (for desktop
// clients), and never with a fragment.
export const validRedirectUri = (uri: string) => {
  try {
    const u = new URL(uri)
    if (u.hash || u.username || u.password) return false
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname))
  } catch {
    return false
  }
}

// The scopes asked for that exist; all of them when none are named.
export const parseScopes = (scope: string | undefined | null): ApiScope[] => {
  const asked = (scope || '').split(/\s+/).filter(Boolean)
  if (!asked.length) return [...API_SCOPES]
  return API_SCOPES.filter((s) => asked.includes(s))
}

// `resource`, when given, must be this server: the MCP endpoint, or the
// origin, which some clients send instead.
export const resourceMatches = (resource: string | undefined | null, origin: string) => {
  if (!resource) return true
  const r = resource.replace(/\/$/, '')
  return r === resourceUrl(origin) || r === origin
}

export const verifyPkce = async (verifier: string, challenge: string) =>
  /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) && (await pkceChallenge(verifier)) === challenge

// ---- Clients ----------------------------------------------------------------

export type ClientResult = { ok: true; client: OauthClient } | { ok: false; error: string }

// A client metadata document (draft-ietf-oauth-client-id-metadata-document)
// as served from `url`: what it must say for us to trust it.
export const checkClientMetadata = (doc: unknown, url: string): { ok: true; name: string; redirectUris: string[] } | { ok: false; error: string } => {
  if (!doc || typeof doc !== 'object') return { ok: false, error: 'The client metadata is not a JSON object' }
  const d = doc as Record<string, unknown>
  if (d.client_id !== url) return { ok: false, error: 'The client metadata names a different client_id' }
  const uris = d.redirect_uris
  if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === 'string' && validRedirectUri(u)))
    return { ok: false, error: 'The client metadata has no valid redirect_uris' }
  if ('client_secret' in d || 'client_secret_expires_at' in d) return { ok: false, error: 'The client metadata must not hold a secret' }
  const name = typeof d.client_name === 'string' ? d.client_name.trim().slice(0, 100) : ''
  return { ok: true, name, redirectUris: uris as string[] }
}

// A client id that is a URL: https, with a path, and nothing that could
// make it point somewhere unexpected.
export const isMetadataUrl = (clientId: string) => {
  try {
    const u = new URL(clientId)
    return u.protocol === 'https:' && u.pathname !== '/' && !u.hash && !u.username && !u.password && !u.port && !LOOPBACK.has(u.hostname)
  } catch {
    return false
  }
}

const fetchClientMetadata = async (url: string) => {
  let res: Response
  try {
    // Not followed: the document must be at the client_id itself.
    res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mailroom-OAuth/1.0 (+https://github.com/fdddf/mailroom)' }, redirect: 'manual', signal: AbortSignal.timeout(5000) })
  } catch (err) {
    return { ok: false as const, error: `Could not read the client metadata at ${url} (${err instanceof Error ? err.message : 'network error'})` }
  }
  if (res.status >= 300 && res.status < 400) return { ok: false as const, error: `The client metadata at ${url} redirects elsewhere` }
  if (!res.ok) {
    // A bot challenge in front of the document says so in cf-mitigated.
    const why = res.headers.get('cf-mitigated')
    console.warn('client metadata fetch failed', url, res.status, why, (await res.text().catch(() => '')).slice(0, 300))
    return { ok: false as const, error: `Could not read the client metadata at ${url} (HTTP ${res.status}${why ? `, ${why}` : ''})` }
  }
  const body = await res.text()
  if (body.length > CIMD_MAX_BYTES) return { ok: false as const, error: 'The client metadata is too large' }
  try {
    return { ok: true as const, doc: JSON.parse(body) as unknown }
  } catch {
    return { ok: false as const, error: 'The client metadata is not JSON' }
  }
}

// Published metadata documents to fall back on when theirs cannot be read:
// chatgpt.com answers some automated requests (local workerd among them)
// with a bot challenge. Only used when the fetch fails, never instead of a
// document that was read; the redirect is OpenAI's documented stable one.
const KNOWN_CLIENTS: Record<string, { name: string; redirectUris: string[] }> = {
  'https://chatgpt.com/oauth/client.json': { name: 'ChatGPT', redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'] },
}

// The client behind a client_id: a registered one, or one known by its
// metadata document, read (again, once a day) when needed.
export const findClient = async (db: Db, clientId: string, { refresh = true } = {}): Promise<ClientResult> => {
  const known = await db.query.oauthClient.findFirst({ where: eq(oauthClient.clientId, clientId) })
  if (!isMetadataUrl(clientId)) return known && known.kind === 'dcr' ? { ok: true, client: known } : { ok: false, error: 'Unknown client_id' }
  if (known && (!refresh || Date.now() - Date.parse(known.fetchedAt ?? '') < CIMD_MAX_AGE_MS)) return { ok: true, client: known }
  const fetched = await fetchClientMetadata(clientId)
  if (!fetched.ok && known) return { ok: true, client: known }
  const checked = fetched.ok ? checkClientMetadata(fetched.doc, clientId) : KNOWN_CLIENTS[clientId] ? ({ ok: true, ...KNOWN_CLIENTS[clientId] } as const) : fetched
  if (!checked.ok) return checked
  // A fallback is tried again on the next request rather than kept a day.
  const fields = { name: checked.name || new URL(clientId).hostname, redirectUris: checked.redirectUris, fetchedAt: fetched.ok ? new Date().toISOString() : null }
  const [row] = await db
    .insert(oauthClient)
    .values({ clientId, kind: 'cimd', ...fields })
    .onConflictDoUpdate({ target: oauthClient.clientId, set: fields })
    .returning()
  return { ok: true, client: row! }
}

// Dynamic client registration (RFC 7591). A client that asks for
// `token_endpoint_auth_method: none` is public; any other gets a secret.
export const registerClient = async (db: Db, body: Record<string, unknown>) => {
  const uris = body.redirect_uris
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === 'string' && validRedirectUri(u)))
    return { ok: false as const, error: 'invalid_redirect_uri', description: 'redirect_uris must be https (or http://localhost) addresses without a fragment' }
  const method = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'client_secret_basic'
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method))
    return { ok: false as const, error: 'invalid_client_metadata', description: `token_endpoint_auth_method ${method} is not supported` }
  const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code']
  if (!grantTypes.includes('authorization_code')) return { ok: false as const, error: 'invalid_client_metadata', description: 'grant_types must include authorization_code' }
  // Unapproved registrations are cleared after a day (purgeOauth); this
  // keeps anyone from filling the table in the meantime.
  const recent = await db.$count(oauthClient, and(eq(oauthClient.kind, 'dcr'), gt(oauthClient.createdAt, new Date(Date.now() - 3600_000).toISOString())))
  if (recent >= 100) return { ok: false as const, error: 'temporarily_unavailable', description: 'Too many registrations; try again later', status: 429 as const }

  const clientId = `mrc_${randomToken(16)}`
  const secret = method === 'none' ? '' : `mrs_${randomToken(32)}`
  const name = typeof body.client_name === 'string' ? body.client_name.trim().slice(0, 100) : ''
  const [row] = await db
    .insert(oauthClient)
    .values({ clientId, kind: 'dcr', name, redirectUris: uris as string[], secretHash: secret ? await sha256Hex(secret) : '' })
    .returning()
  return {
    ok: true as const,
    client: {
      client_id: clientId,
      ...(secret && { client_secret: secret, client_secret_expires_at: 0 }),
      client_id_issued_at: Math.floor(Date.parse(row!.createdAt) / 1000),
      client_name: name || undefined,
      redirect_uris: uris,
      token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
  }
}

// The redirect_uri of a request, checked against the client's: exactly one
// of them, or the only one when it is left out.
export const pickRedirectUri = (client: OauthClient, given: string | undefined | null) => {
  if (!given) return client.redirectUris.length === 1 ? client.redirectUris[0]! : null
  return client.redirectUris.includes(given) ? given : null
}

// ---- Grants and tokens --------------------------------------------------------

const expires = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()

// Approved: a grant, and the code that the client exchanges for tokens.
export const approve = async (db: Db, a: { clientId: number; domainId: number; scopes: ApiScope[]; redirectUri: string; codeChallenge: string }) => {
  const [grant] = await db.insert(oauthGrant).values({ clientId: a.clientId, domainId: a.domainId, scopes: a.scopes }).returning({ id: oauthGrant.id })
  const code = randomToken(32)
  await db.insert(oauthToken).values({
    hash: await sha256Hex(code),
    grantId: grant!.id,
    kind: 'code',
    expiresAt: expires(CODE_SECONDS),
    redirectUri: a.redirectUri,
    codeChallenge: a.codeChallenge,
  })
  return code
}

const issueTokens = async (db: Db, grantId: number, scopes: ApiScope[]) => {
  const access = ACCESS_PREFIX + randomToken(32)
  const refresh = REFRESH_PREFIX + randomToken(32)
  await db.insert(oauthToken).values([
    { hash: await sha256Hex(access), grantId, kind: 'access', expiresAt: expires(ACCESS_SECONDS) },
    { hash: await sha256Hex(refresh), grantId, kind: 'refresh', expiresAt: expires(REFRESH_SECONDS) },
  ])
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: scopes.join(' ') }
}

type TokenError = { ok: false; error: string; description: string; status?: 400 | 401 }

// Is the client who it says? Public clients have nothing to show but PKCE;
// one registered with a secret must send it.
export const authenticateClient = async (client: OauthClient, secret: string | undefined): Promise<TokenError | null> => {
  if (!client.secretHash) return null
  if (secret && (await sha256Hex(secret)) === client.secretHash) return null
  return { ok: false, error: 'invalid_client', description: 'Wrong or missing client secret', status: 401 }
}

// A token of `kind` taken out of use: codes and refresh tokens work once.
const take = async (db: Db, value: string, kind: 'code' | 'refresh') => {
  const [row] = await db
    .delete(oauthToken)
    .where(and(eq(oauthToken.hash, await sha256Hex(value)), eq(oauthToken.kind, kind)))
    .returning()
  return row && Date.parse(row.expiresAt) > Date.now() ? row : null
}

const grantOf = (db: Db, grantId: number, clientRowId: number) =>
  db.query.oauthGrant.findFirst({ where: and(eq(oauthGrant.id, grantId), eq(oauthGrant.clientId, clientRowId)) })

export const exchangeCode = async (db: Db, client: OauthClient, p: { code: string; redirectUri?: string; codeVerifier?: string }) => {
  const invalid: TokenError = { ok: false, error: 'invalid_grant', description: 'The code is unknown, used or expired' }
  const row = await take(db, p.code, 'code')
  if (!row) return invalid
  const grant = await grantOf(db, row.grantId, client.id)
  // A code that went to another client, or a different redirect: the grant
  // it belongs to is not trustworthy any more.
  if (!grant || (p.redirectUri && p.redirectUri !== row.redirectUri)) {
    await db.delete(oauthGrant).where(eq(oauthGrant.id, row.grantId))
    return invalid
  }
  if (!p.codeVerifier || !(await verifyPkce(p.codeVerifier, row.codeChallenge))) {
    await db.delete(oauthGrant).where(eq(oauthGrant.id, row.grantId))
    return { ok: false as const, error: 'invalid_grant', description: 'PKCE verification failed' }
  }
  return { ok: true as const, tokens: await issueTokens(db, grant.id, grant.scopes) }
}

// Rotation: the refresh token is spent, and a new pair comes back.
export const refreshTokens = async (db: Db, client: OauthClient, p: { refreshToken: string; scope?: string }) => {
  const row = await take(db, p.refreshToken, 'refresh')
  const grant = row && (await grantOf(db, row.grantId, client.id))
  if (!grant) return { ok: false as const, error: 'invalid_grant', description: 'The refresh token is unknown, used or expired' }
  // Asking for fewer scopes narrows the grant; more is not possible here.
  const asked = p.scope ? parseScopes(p.scope).filter((s) => grant.scopes.includes(s)) : grant.scopes
  if (!asked.length) return { ok: false as const, error: 'invalid_scope', description: 'None of those scopes were granted' }
  if (asked.length < grant.scopes.length) await db.update(oauthGrant).set({ scopes: asked }).where(eq(oauthGrant.id, grant.id))
  return { ok: true as const, tokens: await issueTokens(db, grant.id, asked) }
}

// Who an access token is for /mcp: its grant, and the app's name.
export const verifyAccessToken = async (db: Db, token: string) => {
  if (!token.startsWith(ACCESS_PREFIX)) return null
  const [row] = await db
    .select({ grant: oauthGrant, clientName: oauthClient.name, expiresAt: oauthToken.expiresAt })
    .from(oauthToken)
    .innerJoin(oauthGrant, eq(oauthGrant.id, oauthToken.grantId))
    .innerJoin(oauthClient, eq(oauthClient.id, oauthGrant.clientId))
    .where(and(eq(oauthToken.hash, await sha256Hex(token)), eq(oauthToken.kind, 'access')))
  return row && Date.parse(row.expiresAt) > Date.now() ? row : null
}

// Expired codes and tokens; grants with nothing left to use (a code never
// exchanged, or not refreshed in REFRESH_SECONDS); apps that registered or
// were read a day ago and hold no grant.
export const purgeOauth = async (db: Db) => {
  const now = new Date().toISOString()
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString()
  await db.delete(oauthToken).where(lt(oauthToken.expiresAt, now))
  await db.delete(oauthGrant).where(notExists(db.select({ x: sql`1` }).from(oauthToken).where(eq(oauthToken.grantId, oauthGrant.id))))
  const idle = db
    .select({ id: oauthClient.id })
    .from(oauthClient)
    .leftJoin(oauthGrant, eq(oauthGrant.clientId, oauthClient.id))
    .where(and(isNull(oauthGrant.id), lt(oauthClient.createdAt, dayAgo)))
  await db.delete(oauthClient).where(inArray(oauthClient.id, idle))
}
