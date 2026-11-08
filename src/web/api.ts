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
  invalid_origin: 'Enter each website as its address, e.g. https://example.com (no path; http only for localhost).',
  origin_required: 'Add at least one website.',
  invalid_site_key: 'That does not look like a Turnstile site key.',
  invalid_secret: 'That does not look like a Turnstile secret key.',
  turnstile_secret_rejected: 'Cloudflare does not recognise that Turnstile secret key.',
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
  file_too_large: 'That file is too big to upload.',
  attachments_too_large: 'Too much to attach to one email: send some of the files as links.',
  too_many_files: 'One email can carry at most 20 files.',
  unknown_file: 'One of the files is no longer in the library.',
  file_unavailable: 'One of the files could not be read from storage.',
  upload_incomplete: 'The upload did not complete. Please try again.',
  bad_part: 'Part of the upload arrived damaged. Please try again.',
  upload_canceled: 'Upload canceled.',
  unknown_signature: 'That signature no longer exists.',
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

// ---- The file library: any size, uploaded in parts ---------------------------

export type LibraryFile = Awaited<ReturnType<typeof call<Awaited<ReturnType<typeof api.files.$get>>>>>['items'][number]

// One part, with upload progress (fetch has none), retried a couple of times.
function putPart(id: number, n: number, body: Blob, onProgress: (loaded: number) => void, signal: AbortSignal) {
  const once = () =>
    new Promise<{ partNumber: number; etag: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', `/api/admin/files/${id}/parts/${n}`)
      for (const [k, v] of Object.entries(domainHeaders())) xhr.setRequestHeader(k, v)
      xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      xhr.upload.onprogress = (e) => onProgress(e.loaded)
      xhr.onload = () => {
        let data: { partNumber?: number; etag?: string; error?: string } = {}
        try {
          data = JSON.parse(xhr.responseText)
        } catch {
          // Not ours (a proxy page): the status says enough.
        }
        if (xhr.status >= 200 && xhr.status < 300 && data.etag) resolve({ partNumber: data.partNumber ?? n, etag: data.etag })
        else reject(new ApiError(data.error ?? 'request_failed', xhr.status, data.error ? '' : `HTTP ${xhr.status}`))
      }
      xhr.onerror = () => reject(new ApiError('network_error', 0))
      xhr.onabort = () => reject(new ApiError('upload_canceled', 0))
      signal.addEventListener('abort', () => xhr.abort(), { once: true })
      xhr.send(body)
    })
  return (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await once()
      } catch (err) {
        const retry = err instanceof ApiError && (err.status === 0 || err.status >= 500) && err.code !== 'upload_canceled'
        if (!retry || attempt >= 3 || signal.aborted) throw err
        onProgress(0)
        await new Promise((r) => setTimeout(r, 1000 * attempt))
      }
    }
  })()
}

// Upload a file into the library, a few parts at a time; `onProgress` gets
// the bytes sent so far. A failed or canceled upload is cleared away.
export async function uploadFile(file: File, onProgress: (sent: number) => void, outer: AbortSignal) {
  // One part failing stops the others.
  const stop = new AbortController()
  const signal = stop.signal
  outer.addEventListener('abort', () => stop.abort(), { once: true })
  const { id, partSize, parts } = await call(api.files.$post({ json: { name: file.name, type: file.type || 'application/octet-stream', size: file.size } }))
  const param = { id: String(id) }
  const sent = new Array<number>(parts).fill(0)
  const done: { partNumber: number; etag: string }[] = []
  let next = 1
  const lane = async () => {
    while (next <= parts && !signal.aborted) {
      const n = next++
      const blob = file.slice((n - 1) * partSize, Math.min(file.size, n * partSize))
      done.push(
        await putPart(id, n, blob, (loaded) => {
          sent[n - 1] = loaded
          onProgress(sent.reduce((a, b) => a + b, 0))
        }, signal),
      )
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(3, parts) }, lane))
    if (signal.aborted) throw new ApiError('upload_canceled', 0)
    return await call(api.files[':id'].complete.$post({ param, json: { parts: done } }))
  } catch (err) {
    stop.abort()
    await call(api.files[':id'].$delete({ param })).catch(() => {})
    throw outer.aborted ? new ApiError('upload_canceled', 0) : err
  }
}
