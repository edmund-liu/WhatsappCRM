# WhatsApp CRM

A Zoko-style WhatsApp Cloud CRM: shared team inbox, broadcast campaigns, round-robin chat
assignment, staff sign-in, and Claude-powered AI agents that auto-reply and hand off to humans.

## Features

- **Team inbox** — WhatsApp-style 3-pane inbox. Staff sign in (JWT auth, admin/agent roles)
  and reply to customers. Live updates via Server-Sent Events. Filters: All / Mine /
  Unassigned / AI-handled. Resolve/reopen, manual reassignment, unread counts,
  delivery/read ticks.
- **Round-robin assignment** — new inbound conversations are automatically distributed
  across active, available teammates using a persistent round-robin cursor. Staff toggle
  their availability from the sidebar; away members are skipped.
- **Broadcasts** — template campaigns to all contacts or a tag segment, sent immediately or
  scheduled. Per-recipient delivery tracking (queued → sent → delivered → read / failed),
  live progress bars, cancel mid-send, opt-out respected, rate-limited sending.
- **AI agents** — configurable bots (name, system prompt, model, handoff keywords) that pick
  up new conversations and auto-reply using the Anthropic API. When the customer asks for a
  human (or the AI decides it can't help), the chat is handed off round-robin to a teammate.
  A human replying always takes over from the AI. Without an API key a built-in rule-based
  responder is used, so the flow is fully demoable offline.
- **Contacts & tags** — contact book with tags (used as broadcast audiences), custom
  attributes, opt-out flag.
- **Templates** — reusable message templates with `{{name}}` personalization and `{{1}}`,
  `{{2}}`… variables, categorized MARKETING / UTILITY / AUTHENTICATION like Meta's.
- **Analytics** — live counters (open chats, inbound/outbound/AI replies in 24h), 14-day
  message volume chart, open chats per teammate.
- **WhatsApp Cloud API integration** — real Meta Graph API sending + webhook receiver
  (`/webhook/whatsapp`, verification handshake included). Ships in **sandbox mode** by
  default: outbound messages are simulated with fake receipts and a built-in **customer
  simulator** (floating button) lets you play the customer end-to-end.

## Quick start

```bash
npm install
npm start          # http://localhost:3000
```

Demo accounts (seeded on first run):

| Role  | Email             | Password |
|-------|-------------------|----------|
| Admin | admin@example.com | admin123 |
| Agent | ava@example.com   | agent123 |
| Agent | ben@example.com   | agent123 |

Try it: sign in as admin → click **📱 Simulate customer** → send "Hi, where is my order?" —
watch the AI agent pick it up and reply. Send "I want to talk to a human" — watch the
handoff and round-robin assignment. Create a broadcast from the Broadcasts page and watch
the delivery stats fill in live.

## Going live with the real WhatsApp Cloud API

1. Create a Meta app with the WhatsApp product and get a **Phone Number ID** and permanent
   **access token**.
2. In **Settings** (admin): uncheck *Sandbox mode*, paste the Phone Number ID, access token,
   and choose a webhook verify token.
3. In Meta's app dashboard, set the webhook callback URL to
   `https://your-domain/webhook/whatsapp` with the same verify token, subscribed to
   `messages`.
4. Create your templates in Meta's Business Manager (names must match the templates here).

## AI configuration

Add an Anthropic API key in **Settings** (or set `ANTHROPIC_API_KEY`). Each AI agent has its
own system prompt, model (defaults to Claude Haiku), and handoff keywords. The AI appends a
`[HANDOFF]` token when it decides a human is needed, which triggers round-robin assignment.

## Stack

Node.js + Express + better-sqlite3 (zero external services), vanilla-JS SPA, SSE for
real-time. Data lives in `data/crm.sqlite`.

## Environment variables (all optional)

| Variable            | Purpose                                  |
|---------------------|------------------------------------------|
| `PORT`              | HTTP port (default 3000)                 |
| `DATA_DIR`          | SQLite directory (default `./data`)      |
| `JWT_SECRET`        | Auth token secret (auto-generated)       |
| `ANTHROPIC_API_KEY` | AI replies (or set via Settings UI)      |
