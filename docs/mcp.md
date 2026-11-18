# MCP server

Mailroom is also a [Model Context Protocol](https://modelcontextprotocol.io) server, so an AI assistant on your computer can work with one of your domains: add contacts, write a broadcast, test it and send it, or send a single email.

Address: your `PUBLIC_URL` followed by `/mcp/` and the domain, e.g. `https://mailroom.example.com/mcp/example.com` (Streamable HTTP, stateless). Each domain has its own address, shown on its page in the dashboard; with several domains, add one server or connector per domain. Plain `/mcp` works too, for whichever domain the key or connection is for, but apps such as claude.ai allow only one connector per URL, so use the domain's address there.

## Connecting Claude Code

1. In the dashboard, open **Domains** → the domain → **API keys**, and make a key with the permissions the assistant should have (see below).
2. Add the server:

```bash
claude mcp add --transport http mailroom-example https://mailroom.example.com/mcp/example.com \
  --header "Authorization: Bearer mr_…"
```

Add `--scope user` to have it in every project, rather than only the current one. Then ask, for example: *"Add these people to the newsletter segment and draft a broadcast announcing the new pricing."*

Any other MCP client that can send an `Authorization` header connects the same way.

## Connecting ChatGPT, claude.ai and other apps that sign in

Apps that cannot send a header sign in with OAuth instead; Mailroom is its own OAuth server, and there is nothing to set up beforehand.

1. Add the domain's address, e.g. `https://mailroom.example.com/mcp/example.com`, as a custom connector (ChatGPT: with developer mode on, in its apps/connectors settings; claude.ai: in its connectors settings). Choose OAuth if asked.
2. A Mailroom page opens for that domain: untick anything the app should not do, and enter the **dashboard password**. (Connected at plain `/mcp`, the page asks which domain.)
3. The app is connected to that domain. It is listed under **Connected apps** on the domain's page, where **Disconnect** signs it out at once.

One connection is one domain; for another, add a second connector with that domain's address. A key or connection for one domain is turned away at another domain's address. Access tokens last an hour and are renewed by the app; a connection not used for 30 days lapses.

What it implements, for the curious: MCP authorization (2025-11-25): protected resource metadata at `/.well-known/oauth-protected-resource/mcp/<domain>` (and `/mcp`, and the root), authorization server metadata at `/.well-known/oauth-authorization-server`, client ID metadata documents (what ChatGPT prefers) and dynamic client registration at `/oauth/register` (what Claude uses), authorization code with PKCE S256 only, `resource` checked, `iss` in every authorization response, and refresh tokens rotated on every use. Codes and tokens are random and kept only as hashes.

If ChatGPT says the client metadata cannot be read, choose dynamic client registration in its connector settings instead.

## Keys and permissions

The same API keys as the [integration API](api.md), or an app's OAuth connection: either works for **one domain**, and the assistant only sees the tools its scopes allow. To work with several domains, add one server per domain at its own address (`mailroom-example` at `/mcp/example.com`, `mailroom-shop` at `/mcp/shop.example`, …), each with its own key or connection. Each server names its domain in its title, in what it tells the assistant, and at the start of every tool's description, so the assistant can tell them apart; naming the domain in a request (*"…for shop.example"*) helps it pick.

| Scope | Tools |
| --- | --- |
| *(any key)* | `get_domain` |
| `contacts` | `list_segments`, `add_contacts`, `list_contacts`, `get_contact`, `unsubscribe_contact`, `delete_contact` |
| `send` | `send_email` |
| `broadcasts` | `list_broadcasts`, `get_broadcast`, `list_broadcast_recipients`, `create_broadcast`, `update_broadcast`, `send_test_broadcast`, `send_broadcast`, `cancel_broadcast` |

A key with only `contacts` lets an assistant manage the list without being able to send anything.

## Tools

| Tool | |
| --- | --- |
| `get_domain` | The domain, its mailboxes (senders), its segments with their subscriber counts, and the key's scopes |
| `list_segments` | Segments with how many subscribed contacts each has |
| `add_contacts` | Up to 1,000 contacts in one call, put in the given segments (made if missing). Someone already on file gets the names given and the segments, but keeps their subscription: an unsubscribed contact stays unsubscribed. Invalid addresses are skipped and listed |
| `list_contacts` | Newest first, by segment, status (`subscribed`, `unsubscribed`) or part of the address or name, a page at a time |
| `get_contact` | One contact, with their segments |
| `unsubscribe_contact` | Broadcasts skip them from now on |
| `delete_contact` | Forget them entirely, e.g. a test entry or a data deletion request. Their unsubscribe goes too, so prefer `unsubscribe_contact` for someone who opted out |
| `send_email` | One email now, to at most 50 recipients who all see each other. Not for mailings |
| `list_broadcasts`, `get_broadcast` | Status (`draft`, `queued`, `sending`, `sent`, `canceled`), progress, failures, and how many emails were delivered, bounced or complained about |
| `list_broadcast_recipients` | Who it went to and what became of each email; filter by state, e.g. `bounced` |
| `create_broadcast` | A draft for the subscribed contacts of a segment; sends nothing, and says how many it would reach |
| `update_broadcast` | Change fields of a draft |
| `send_test_broadcast` | One copy to a single address (default: the sender), with sample names and `[Test]` in the subject |
| `send_broadcast` | Queue a draft, now or at `scheduledAt`. Needs `expectedRecipients`: the count the user approved |
| `cancel_broadcast` | A queued broadcast goes back to draft; one going out stops |

Contacts and broadcasts are the same ones the dashboard shows; anything the assistant does there can be checked, changed or stopped in **Contacts** and **Broadcasts**.

## Mailings: how sending to many people works

Bulk email always goes out as a **broadcast**, as it does from the dashboard: each subscriber gets their own copy with their own unsubscribe link (and one-click unsubscribe), unsubscribed, hard-bounced and complaining contacts are skipped, and the Worker's cron sends 100 a minute within your account's sending quota.

The tools are built so that nothing goes out by accident:

1. `create_broadcast` only saves a draft and reports the number of recipients.
2. `send_test_broadcast` sends one copy to you.
3. `send_broadcast` must name that number (`expectedRecipients`). If the segment has grown or shrunk since, it is refused with the new count, to be confirmed again.

The server tells the assistant to send only after you approve; Claude Code also asks before each tool call unless you allow it. Keep `send_broadcast` on "ask".

Placeholders in a broadcast's subject and message: `{{first_name}}`, `{{last_name}}`, `{{email}}`, `{{unsubscribe_url}}`. Every email ends with a footer saying why the person gets it, and an Unsubscribe link. A message that words the link itself (`Unsubscribe: {{unsubscribe_url}}`, or `<a href="{{unsubscribe_url}}">…</a>`) goes without the footer; a bare `{{unsubscribe_url}}` on a line of its own is dropped and the footer added.

## Delivery status

Broadcasts made here show in the dashboard under **Broadcasts** (with the domain or "All domains" selected), marked with the app or key that made them. Each recipient's email is followed through Email Sending's delivery events: delivered, delayed, bounced, complained. This needs the domain's events subscribed to the `mailroom-events` queue (step 3 in [domains.md](domains.md)); without it, recipients stay at "sent".

Only add people who asked for your email: the law, and Cloudflare's terms for Email Sending, expect it.

## Cloudflare Access

If Cloudflare Access protects the dashboard, leave `/mcp`, `/oauth/register`, `/oauth/token` and `/.well-known/*` public as you do `/v1/*`: apps call them directly, and keys and tokens protect them. `/oauth/authorize` is the page you approve apps on, and can stay behind Access.
