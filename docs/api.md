# Integration API

For your other systems (a website's backend, an app server, a billing system) to send email from one of your domains and manage its contacts, and to hear about mail through webhooks.

Base URL: your `PUBLIC_URL`, e.g. `https://mailroom.example.com/v1`.

## Authentication

Make a key on the domain's page in the dashboard (**Domains** → the domain → API keys). It is shown once; Mailroom keeps only a hash.

```
Authorization: Bearer mr_…
```

A key works for **one domain** and the permissions (scopes) it was given:

| Scope | Allows |
| --- | --- |
| `send` | `POST /v1/send`, `GET /v1/mail/:id` |
| `contacts` | the `/v1/contacts` endpoints |

Keys are secrets: use them from servers only, never in a browser or a shipped app. Revoking a key takes effect immediately.

Errors are JSON with a machine-readable code, sometimes with a `message`:

```json
{ "error": "unknown_sender", "message": "…" }
```

| Status | Meaning |
| --- | --- |
| 400 | The request is not valid (`invalid_to`, `invalid_subject`, `invalid_message`, `too_many_recipients`, `header_not_allowed`, `unknown_sender`, `no_mailbox`, …) |
| 401 | Missing, unknown or revoked key |
| 403 | The key lacks the scope (`forbidden`) |
| 404 | Not found, or not this domain's |
| 424 | Email Sending refused the email (`send_failed`; `message` has Cloudflare's code, e.g. `E_DAILY_LIMIT_EXCEEDED`) |
| 503 | Sending is not configured on this deployment |

## `GET /v1/domain`

Which domain the key is for. Handy to check a key.

```json
{ "domain": "example.com", "brand": "Example Studio", "scopes": ["send", "contacts"],
  "mailboxes": [{ "address": "hello@example.com", "name": "Example Studio", "isDefault": true }] }
```

## `POST /v1/send`

Send one email.

| Field | Type | |
| --- | --- | --- |
| `from` | string | Optional. `"Name <a@example.com>"` or `"a@example.com"`, any address on the key's domain. Default: the domain's default mailbox, with its display name |
| `to`, `cc`, `bcc` | string or string[] | Comma-separated string or array; at least one recipient, 50 in total at most |
| `replyTo` | string | Optional |
| `subject` | string | Required |
| `text` | string | Plain-text body |
| `html` | string | HTML body. With only `html`, a text part is made from it. One of `text`/`html` is required |
| `headers` | object | Optional. Only `X-…`, `In-Reply-To`, `References`, `List-Id`, `List-Unsubscribe`, `List-Unsubscribe-Post` |
| `record` | boolean | Default `true`: keep a copy in the dashboard's Sent. `false` for mail you do not want stored (e.g. one-time codes) |

```bash
curl https://mailroom.example.com/v1/send \
  -H "Authorization: Bearer $MAILROOM_KEY" -H "Content-Type: application/json" \
  -d '{
    "from": "Example Studio <noreply@example.com>",
    "to": "ann@gmail.com",
    "replyTo": "hello@example.com",
    "subject": "Your receipt",
    "html": "<p>Thanks for your order, Ann.</p>"
  }'
```

```json
{ "id": 42, "messageId": "<…@example.com>" }
```

`id` is the email in Mailroom (`null` with `record: false`); `messageId` is its Message-ID header, which replies will reference.

## `GET /v1/mail/:id`

One email of this domain's, sent or received; mostly to read a sent email's delivery `status`: `sent`, `delivered`, `delivery_delayed`, `bounced`, `failed`, `suppressed`, `complained`. (Updated only when the domain's delivery events are subscribed, see docs/domains.md.) Prefer the `mail.status` webhook to polling.

## Contacts

Contacts belong to a domain; broadcasts in the dashboard go to a segment of them.

### `POST /v1/contacts`

Add someone, or update their name and segments.

| Field | Type | |
| --- | --- | --- |
| `email` | string | Required |
| `firstName`, `lastName` | string | Optional; only set fields are changed |
| `segments` | string[] | Segment names to add them to; missing segments are created |
| `resubscribe` | boolean | Default `false`: someone who unsubscribed stays unsubscribed. Set `true` only when they just asked again (e.g. signed up anew) |

```bash
curl https://mailroom.example.com/v1/contacts \
  -H "Authorization: Bearer $MAILROOM_KEY" -H "Content-Type: application/json" \
  -d '{"email": "ann@gmail.com", "firstName": "Ann", "segments": ["newsletter"]}'
```

```json
{ "id": 7, "email": "ann@gmail.com", "firstName": "Ann", "lastName": "", "unsubscribed": false,
  "segments": ["newsletter"], "createdAt": "2026-10-31T09:00:00.000Z" }
```

Only add people who asked for your email.

### `GET /v1/contacts/:email`

The contact, as above; 404 if not on this domain's list.

### `POST /v1/contacts/:email/unsubscribe`

Marks them unsubscribed (they stay on file, so an import cannot add them back).

### `DELETE /v1/contacts/:email`

Forgets them entirely, e.g. for a data deletion request.

## Public sign-up forms

For a website to collect subscribers with no server of its own. No API key is involved: the form's address is public, and these guard it:

- **Allowed websites:** only the `Origin`s listed on the form are accepted.
- **Turnstile:** every submission needs a fresh token; its action must be `subscribe` and its hostname one of the allowed websites.
- **Double opt-in:** a submission only sends a confirmation email. The person joins the form's segment when they click its button, and the time is kept as `confirmedAt` on the contact. Unconfirmed submissions expire after 7 days. Confirming also resubscribes someone who had unsubscribed: that is their own click.
- **Limits:** one confirmation email per address per 10 minutes, and 10 unconfirmed submissions per IP address per hour.

### Setting one up

1. In the Cloudflare dashboard, add a widget under **Turnstile** with your website's hostnames (managed mode is fine), and note its site key and secret key.
2. In Mailroom, go to **Contacts** → **Sign-up forms** → **New form**: the segment, the websites (`https://example.com`; `www` is a separate one) and both keys. The domain needs a default mailbox to send from.
3. Paste its **Embed code** into your website.

To try it locally, list `http://localhost:<port>` as a website and use Cloudflare's [test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/). Test keys are refused from any other website, so they cannot be left on by accident. Take `localhost` off the form before going live.

### `POST /subscribe/:publicId`

`multipart/form-data`, `application/x-www-form-urlencoded` or JSON:

| Field | | |
| --- | --- | --- |
| `email` | string | Required |
| `cf-turnstile-response` | string | Required: the widget adds it to the form by itself. It works once; reset the widget after every attempt |
| `firstName`, `lastName` | string | Optional |

With `text/html` in `Accept` (a plain form post) the answer is a page. Otherwise it is JSON, with CORS for the allowed websites:

```json
{ "ok": true }
```

The answer is the same whether the address is new, waiting to confirm or already subscribed, so the form cannot be used to find out who is on the list. It only means an email is on its way if one is due; a failure to send it shows on the form in the dashboard.

| Status | `error` | |
| --- | --- | --- |
| 400 | `invalid_email`, `turnstile_failed`, `invalid_request` | Check the fields |
| 403 | `origin_not_allowed`, `turnstile_failed` | Not an allowed website, or Turnstile did not pass |
| 404 | `not_found` | No such form |
| 429 | `rate_limited` | Too many from this IP address |
| 503 | `form_unavailable` | Switched off, or misconfigured: the dashboard says why |

## Webhooks

Add a webhook on the domain's page: an `https://` URL and the events it wants. Mailroom POSTs JSON:

```json
{
  "id": "1f6c…",                      // unique per delivery
  "type": "mail.received",
  "created": "2026-10-31T09:00:00.000Z",
  "data": { … }
}
```

### Events

`mail.received` — mail arrived at the domain (after it is stored):

```json
{ "id": 42, "domain": "example.com", "mailbox": "hello@example.com", "envelopeFrom": "ann@gmail.com",
  "from": "Ann Lee <ann@gmail.com>", "to": ["hello@example.com"], "cc": [], "replyTo": "",
  "subject": "Re: Your receipt", "text": "…", "html": "…",
  "messageId": "<…@gmail.com>", "inReplyTo": "<…@example.com>", "references": ["<…@example.com>"],
  "date": "2026-10-31T09:00:00.000Z",
  "attachments": [{ "filename": "photo.jpg", "size": 182734, "contentType": "image/jpeg" }] }
```

`inReplyTo`/`references` let you thread replies to email you sent (match them against the `messageId` from `/v1/send`); a tag in the subject such as `[#123]` works too, since mail clients keep it.

`mail.status` — a sent email's delivery status changed:

```json
{ "id": 41, "messageId": "<…@example.com>", "mailbox": "noreply@example.com", "to": ["ann@gmail.com"],
  "subject": "Your receipt", "status": "bounced", "recipient": "ann@gmail.com", "bounce": { "type": "hard" } }
```

`ping` — sent by "Send a test event" in the dashboard: `{ "domain": "example.com" }`.

### Verifying the signature

Every delivery has

```
X-Mailroom-Signature: t=1761901200,v1=5d41402abc4b2a76b9719d911017c592…
```

`v1` is the hex HMAC-SHA256 of `"<t>.<raw request body>"` with the webhook's signing secret (`whsec_…`, shown on the domain's page). Check it against the raw body, before parsing, and reject old timestamps:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function verify(rawBody, header, secret, toleranceSeconds = 300) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')))
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  return v1.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected))
}
```

### Delivery

- Answer with any 2xx within 10 seconds. A network error or a 5xx is retried once, right away; a 4xx is not retried.
- Delivery is best effort: there is no queue of missed events. The domain's page shows each webhook's last delivery and error. Use the `id` field to ignore duplicates.
- Other headers: `X-Mailroom-Event` (the type), `X-Mailroom-Delivery` (the id).
