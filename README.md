# Mailroom

A self-hosted mail center for your own domains, running entirely on your Cloudflare account. One deployment handles as many domains as you like: each gets its own mailboxes, inbox, contacts, broadcasts, API keys and webhooks.

- **Inbox**: mail to your domains arrives through Cloudflare Email Routing and is kept in D1 (attachments in R2). Read, reply, archive, search.
- **Sending**: compose and reply from any of your mailboxes through Cloudflare Email Sending, with delivery status (delivered, bounced, …).
- **Broadcasts**: contacts and segments per domain, scheduled sends in batches, per-recipient unsubscribe links (including one-click, RFC 8058), automatic suppression of hard bounces and complaints.
- **Editor**: plain text or HTML with a visual editor, an image library, templates, and an optional AI writing assistant (Claude or any OpenAI-compatible API).
- **Integration API**: per-domain API keys to send email and manage contacts from your other systems (`/v1`), and signed webhooks when mail arrives or a delivery status changes.

Everything is one Worker: the dashboard is served as static assets, and there is no server to run.

## What you need

- A Cloudflare account with your domains on it (DNS managed by Cloudflare)
- Workers Paid plan, for Email Sending ([pricing](https://developers.cloudflare.com/email-service/))
- Node.js 20+

## Install

```bash
git clone <this repo> mailroom && cd mailroom
npm install
npx wrangler login
```

Create the resources and put the database id into `wrangler.jsonc`:

```bash
npx wrangler d1 create mailroom          # copy the database_id into wrangler.jsonc
npx wrangler r2 bucket create mailroom
npx wrangler queues create mailroom-events
```

In `wrangler.jsonc`, set `PUBLIC_URL` to where the Worker will be reachable (its `*.workers.dev` address, or a custom domain under `routes`). Unsubscribe links and email images point there, so it must be public.

Then create the tables, set the dashboard password, and deploy:

```bash
npm run db:migrate
npx wrangler secret put ADMIN_PASSWORD
npm run deploy
```

Open `PUBLIC_URL`, sign in, and add your first domain under **Domains**. It is strongly recommended to also put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front of the dashboard (paths `/` and `/api/admin/*`; leave `/v1/*`, `/u/*` and `/media/*` public).

## Adding a domain

Adding a domain in the dashboard is the Mailroom side. The Cloudflare side is three commands, which the domain's page shows ready to copy, along with a live DNS check and a test-send button:

1. `npx wrangler email sending enable example.com` — onboards it for sending (SPF, DKIM, bounce records)
2. `npx wrangler email routing enable example.com`, then point the catch-all at this Worker — mail for the domain arrives here
3. Subscribe the `mailroom-events` queue to the domain's sending events — for delivery status

Details and troubleshooting: [docs/domains.md](docs/domains.md).

## Using it from other systems

Make an API key on the domain's page, then:

```bash
curl https://mailroom.example.com/v1/send \
  -H "Authorization: Bearer mr_…" \
  -H "Content-Type: application/json" \
  -d '{"from": "Example <hello@example.com>", "to": "ann@gmail.com", "subject": "Welcome", "html": "<p>Hi Ann</p>"}'
```

Sending, contacts and webhooks are documented in [docs/api.md](docs/api.md).

## Development

```bash
cp .dev.vars.example .dev.vars   # ADMIN_PASSWORD for local sign-in
npm run db:migrate:local
npm run dev                      # dashboard and Worker at http://localhost:5173
```

Locally, sent email is simulated (add `"remote": true` to the `send_email` binding to send for real). Simulate incoming mail with:

```bash
curl -X POST "http://localhost:5173/cdn-cgi/handler/email?from=ann@gmail.com&to=hello@example.com" --data-binary @message.eml
```

and run the broadcast cron with `curl "http://localhost:5173/cdn-cgi/handler/scheduled"`.

Other scripts: `npm run typecheck`, `npm test`, and `npm run db:generate` after changing `src/worker/db/schema.ts`.

### Layout

| Path | What |
| --- | --- |
| `src/worker/index.ts` | Worker entry: `fetch`, `email` (receiving), `scheduled` (broadcasts), `queue` (delivery events) |
| `src/worker/routes/admin/` | The dashboard's API (`/api/admin`) |
| `src/worker/routes/v1.ts` | The integration API (`/v1`) |
| `src/worker/routes/public.ts` | Unsubscribe pages (`/u/…`) and email images (`/media/…`) |
| `src/worker/lib/` | Sending and receiving, broadcasts, webhooks, DNS checks, AI |
| `src/worker/db/schema.ts` | The D1 schema; migrations in `migrations/` |
| `src/web/` | The dashboard (React, Mantine) |

## Limits worth knowing

- Cloudflare Email Service is meant for transactional mail. Broadcasts work, but send only to people who asked for your mail and keep bounces and complaints low, or your sending may be limited.
- New accounts start at a daily sending quota that grows with reputation; broadcasts pause when it is reached and continue later without sending twice.
- One email: at most 50 recipients and 5 MiB. Received bodies are trimmed to fit D1's row limit; attachments over 20 MB are listed but not stored.

## License

MIT — see [LICENSE](LICENSE).
