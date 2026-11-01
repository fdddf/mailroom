// Typed client for /api/admin, inferred from the Hono routes in src/worker.
import { DetailedError, hc, parseResponse, type ClientResponse } from 'hono/client'
import type { AdminApi } from '../worker/app'
import { domainHeaders } from './domain'

// Every request says which domain the dashboard is looking at.
export const api = hc<AdminApi>('/api/admin', { headers: domainHeaders })

export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
    public detail = '',
  ) {
    super(code)
  }
}

// Await a call; a failure becomes an ApiError carrying the server's error code.
export async function call<R extends ClientResponse<unknown>>(request: Promise<R>) {
  try {
    return await parseResponse(request)
  } catch (err) {
    if (err instanceof DetailedError) {
      const data = (err.detail as { data?: { error?: string; message?: string } } | undefined)?.data
      const status = Number(err.statusCode) || 0
      // A body without our { error } (e.g. a proxy error page) still shows its status.
      throw new ApiError(data?.error ?? 'request_failed', status, data?.message ?? (data?.error ? '' : `HTTP ${status}`))
    }
    throw new ApiError('network_error', 0)
  }
}

const MESSAGES: Record<string, string> = {
  network_error: 'Network error. Please try again.',
  request_failed: 'The request failed.',
  unauthorized: 'Your session expired. Please sign in again.',
  wrong_password: 'Wrong password.',
  email_not_configured: 'Sending is not set up: add the send_email binding named EMAIL (wrangler.jsonc).',
  unknown_sender: 'That sender is not one of this domain’s mailboxes.',
  no_mailbox: 'This domain has no mailbox to send from yet (see Mailboxes).',
  unknown_domain: 'That address is not on one of your domains. Add the domain first.',
  domain_required: 'Pick a domain at the top first.',
  domain_exists: 'That domain is already here.',
  invalid_domain: 'That is not a domain name (e.g. example.com).',
  unknown_segment: 'That segment is not one of this domain’s.',
  segment_exists: 'This domain already has a segment with that name.',
  scope_required: 'Pick at least one permission.',
  event_required: 'Pick at least one event.',
  too_many_webhooks: 'A domain can have at most 10 webhooks.',
  mailbox_exists: 'That mailbox already exists.',
  default_mailbox: 'Make another mailbox of this domain the default first.',
  admin_not_configured: 'The dashboard is disabled: add the secret ADMIN_PASSWORD under this Worker\'s Settings → Variables and Secrets in the Cloudflare dashboard.',
  send_failed: 'The email could not be sent',
  not_a_draft: 'Only a draft can be changed or sent.',
  broadcast_in_progress: 'Stop the broadcast before deleting it.',
  not_cancelable: 'This broadcast is not waiting or sending.',
  empty_segment: 'Nobody in that segment is subscribed.',
  ai_not_configured: 'No AI provider is set up yet (see AI).',
  key_unreadable: 'The stored API key cannot be read (the admin password changed since). Enter the key again under AI.',
  key_required: 'Enter the API key.',
  invalid_url: 'The URL must start with https://',
  instruction_required: 'Say what you want written.',
  ai_auth: 'The AI provider rejected the API key',
  ai_model: 'The AI provider does not know that model',
  ai_rate_limited: 'The AI provider is rate limiting',
  ai_refused: 'The model declined',
  ai_too_long: 'The draft was cut off',
  ai_empty: 'The model returned nothing',
  ai_bad_response: 'The model answered in an unexpected format',
  ai_unreachable: 'The AI provider could not be reached',
  ai_error: 'The AI provider returned an error',
  storage_not_configured: 'Storage is not set up: add the R2 binding named BUCKET (wrangler.jsonc).',
  unsupported_image: 'Use a PNG, JPEG, GIF or WebP image.',
  image_too_large: 'That image is over 5 MB.',
  empty_file: 'That file is empty.',
  too_many_contacts: 'Import at most 5,000 contacts at a time.',
  empty_reply: 'Write something first.',
  too_long: 'That is too long.',
  not_found: 'This no longer exists.',
  invalid_to: 'Check the To address.',
  invalid_cc: 'Check the Cc address.',
  invalid_subject: 'Add a subject.',
  invalid_message: 'Add a message.',
  invalid_email: 'That email address is not valid.',
  invalid_name: 'Add a name.',
  segment_required: 'Choose a segment.',
  attachment_unavailable: 'The attachment is not available right now.',
}

export const errorText = (err: unknown) => {
  if (!(err instanceof ApiError)) return MESSAGES.network_error
  const base = MESSAGES[err.code] ?? `Error: ${err.code}`
  return err.detail ? `${base} (${err.detail})` : base
}

// Upload an image for an HTML email; resolves to its public address.
export async function uploadImage(file: Blob) {
  let res: Response
  try {
    res = await fetch('/api/admin/media', { method: 'PUT', headers: { ...domainHeaders(), 'Content-Type': file.type }, body: file })
  } catch {
    throw new ApiError('network_error', 0)
  }
  const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
  if (!res.ok || !data.url) throw new ApiError(data.error ?? 'request_failed', res.status, data.error ? '' : `HTTP ${res.status}`)
  return data.url
}

// POST and read a server-sent-event answer, calling `on` for each event.
export async function stream(path: string, json: unknown, on: (event: string, data: unknown) => void, signal?: AbortSignal) {
  let res: Response
  try {
    res = await fetch(path, { method: 'POST', headers: { ...domainHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(json), signal })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new ApiError('network_error', 0)
  }
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
    throw new ApiError(data.error ?? 'request_failed', res.status, data.message ?? (data.error ? '' : `HTTP ${res.status}`))
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // Events are separated by a blank line.
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const block of events) {
      let event = 'message'
      const data: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (!data.length) continue
      try {
        on(event, JSON.parse(data.join('\n')))
      } catch {
        // Not ours to read.
      }
    }
  }
}
