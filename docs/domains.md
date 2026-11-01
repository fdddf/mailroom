# Adding a domain

A domain needs two things: an entry in Mailroom (dashboard → **Domains** → Add a domain), and its Cloudflare side. The domain's page in the dashboard shows every command below filled in for that domain, a live DNS check, and a test-send button.

All commands assume `npx wrangler login` with the Cloudflare account that holds the domain.

## 1. Sending

```bash
npx wrangler email sending enable example.com
npx wrangler email sending dns get example.com   # what it added
```

This adds SPF, DKIM and the bounce subdomain (`cf-bounce.example.com`). After that, Mailroom can send from **any** address on the domain: its mailboxes in the dashboard, and any address through the API (e.g. `noreply@`).

Check: the dashboard's "Onboarded to Email Sending" turns green, and **Send test** reaches your inbox (not spam).

## 2. Receiving

```bash
npx wrangler email routing enable example.com
npx wrangler email routing rules update example.com catch-all --action-type worker --action-value mailroom --enabled true
```

The catch-all hands every address on the domain to the Worker (named `mailroom` in `wrangler.jsonc`; use your name if you changed it). The Worker then decides:

| Recipient | What happens |
| --- | --- |
| A mailbox | Kept in the inbox; also forwarded if the mailbox has "Forwards to" set |
| Another address, catch-all on (default) | Kept in the inbox |
| Another address, catch-all off | Refused (the sender gets a bounce) |
| A domain not added in Mailroom | Refused |

Want one address to go elsewhere and never reach Mailroom? Add a specific Email Routing rule for it (`wrangler email routing rules create`); specific rules take precedence over the catch-all.

Forwarding ("Forwards to" on a mailbox) only works to a [verified destination address](https://developers.cloudflare.com/email-routing/setup/email-routing-addresses/): `npx wrangler email routing addresses create you@gmail.com`, then confirm the email Cloudflare sends.

Check: "Mail is routed to Cloudflare (MX)" and "SPF allows Cloudflare" are green; mail sent to the domain shows up in the inbox within seconds.

## 3. Delivery status

Email Sending reports what happened to each email (delivered, deferred, bounced, …) as events. Subscribe the queue once per domain:

```bash
npx wrangler queues subscription create mailroom-events \
  --source email.sending --zone-id <ZONE_ID> --domain example.com \
  --events message.delivered,message.deferred,message.bounced,message.failed,message.rejected,message.complained \
  --name example-com-delivery
```

The zone id is on the domain's overview page in the Cloudflare dashboard. With this, Sent shows each email's status, `mail.status` webhooks fire, and contacts who hard-bounce or mark mail as spam are unsubscribed from that domain's broadcasts.

Without it everything else works; sent mail just stays at "Sent".

## 4. Optional but recommended: DMARC

Mail providers trust domains with a DMARC policy more. A gentle start is a TXT record at `_dmarc.example.com`:

```
v=DMARC1; p=none; rua=mailto:dmarc@example.com
```

Tighten `p=` to `quarantine` or `reject` once reports show all your mail passes.

## Settings per domain

- **Brand**: the name on its unsubscribe page and in the default broadcast footer
- **Catch-all**: whether mail to addresses without a mailbox is kept
- **Broadcast footer**: replaces the default "You are receiving this because …" line
- **About, for the writing assistant**: context the AI gets with every draft for this domain

## Removing a domain

Deleting a domain in the dashboard removes everything Mailroom has for it (mail, attachments, contacts, broadcasts, templates, keys, webhooks). Its Cloudflare side stays; to stop mail reaching the Worker, change or delete the catch-all rule, and remove the queue subscription with `wrangler queues subscription delete`.

## Troubleshooting

- **Mail does not arrive**: `npx wrangler tail mailroom` while sending a message. "Unknown recipient" means the domain is not added in Mailroom; "No such mailbox" means catch-all is off and the address has no mailbox. Nothing at all means Email Routing is not sending it to the Worker: check the catch-all rule.
- **Sending fails with `E_SENDER_NOT_VERIFIED`** (or similar): the domain is not onboarded to Email Sending yet, or DNS has not propagated (allow a few minutes).
- **Status stays at "Sent"**: the queue subscription for that domain is missing. Mail to destination addresses verified in Email Routing never produces events; test with another address.
