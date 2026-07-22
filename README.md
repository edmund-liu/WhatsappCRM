# WhatsApp CRM

A Zoko-style WhatsApp Cloud CRM: shared team inbox, broadcast campaigns, round-robin chat
assignment, staff sign-in, and Claude-powered AI agents that auto-reply and hand off to humans.

## Features

- **Team inbox** — WhatsApp-style 3-pane inbox. Staff sign in (JWT auth, admin/agent roles)
  and reply to customers. Live updates via Server-Sent Events. Filters: All / Mine /
  Unassigned / AI-handled. Resolve/reopen, manual reassignment, unread counts,
  delivery/read ticks.
- **Media messages** — paste a screenshot (Ctrl/Cmd+V) or attach an image/audio file in
  the reply box and send it to the customer; inbound customer photos and voice notes are
  downloaded from Meta and shown in the thread (image bubbles, inline audio player). The
  sandbox simulator can send images and voice notes too, so the whole flow is demoable
  offline.
- **Skill-based routing + round-robin assignment** — admins define routing skills
  (e.g. *billing*, *shipping*, *technical*) with keywords on the Team page; each incoming
  conversation is classified against them and routed to a teammate — or AI agent — who has
  the matching skill. Distribution is round-robin *within* each skill pool (persistent
  per-pool cursors), falling back to the general pool when no skill matches or nobody has
  it. Staff toggle their availability from the sidebar; away members are skipped.
- **Broadcasts with rich media** — template campaigns to all contacts or a tag segment,
  sent immediately or scheduled. Templates support **header images**, **quick-reply
  buttons**, and **link (URL) buttons** (up to 3, mirroring Meta's template model), with a
  live preview in the campaign composer and a per-campaign image override. Per-recipient
  delivery tracking (queued → sent → delivered → read / failed), live progress bars, cancel
  mid-send, opt-out respected, rate-limited sending.
- **AI agents** — configurable bots (name, system prompt, model, handoff keywords) that pick
  up new conversations and auto-reply using the Anthropic API. When the customer asks for a
  human (or the AI decides it can't help), the chat is handed off round-robin to a teammate.
  A human replying always takes over from the AI. Without an API key a built-in rule-based
  responder is used, so the flow is fully demoable offline.
- **Contacts & tags** — contact book with tags (used as broadcast audiences), custom
  attributes, opt-out flag.
- **Templates with Meta sync** — reusable message templates with `{{name}}` personalization
  and `{{1}}`, `{{2}}`… variables, categorized MARKETING / UTILITY / AUTHENTICATION.
  Templates sync both ways with your WhatsApp Business Account: pull the approved library
  from Meta (**⟳ Sync from Meta**), submit local templates for approval (**Submit to
  Meta** — `{{name}}` is converted to Meta's positional placeholders automatically), and
  approval/rejection webhooks update local status in real time.
- **Read-receipt sync** — when a teammate opens a conversation, the read state is synced
  back to Meta so the customer sees blue ticks on their phone.
- **Analytics** — live counters (open chats, inbound/outbound/AI replies in 24h), 14-day
  message volume chart, open chats per teammate.
- **WhatsApp Cloud API integration** — real Meta Graph API sending + webhook receiver
  (`/webhook/whatsapp`, verification handshake included). Ships in **sandbox mode** by
  default: outbound messages are simulated with fake receipts and a built-in **customer
  simulator** (floating button) lets you play the customer end-to-end.

## Quick start

Requires **Node.js 22.5+** (uses Node's built-in SQLite — no native modules to compile).

```bash
npm install
npm start          # open http://localhost:3000
```

> Open the app through the Node server at `http://localhost:3000`. Serving `public/`
> from a static file server (VS Code Live Server, `npx serve`, etc.) will load the page
> but every API call — including login — will fail, because the backend isn't there.

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

## Deploying to Vercel

The repo includes `api/index.js` + `vercel.json`, so importing the project into Vercel
works out of the box (set the project's Node.js version to 22.x). Set a `JWT_SECRET`
environment variable in the project settings so logins survive across instances.

Serverless caveats — Vercel is great for demoing, but note:

- **Data is ephemeral.** SQLite lives in `/tmp`, which resets on cold starts and is not
  shared between instances. Every reset reseeds the demo accounts and sample data. For
  real usage run the app on an always-on host (Railway, Render, Fly.io, a VPS) where the
  database file persists.
- **Scheduled broadcasts don't fire** (no background scheduler); "Send now" works — the
  send completes within the request (60s max, so keep audiences modest).
- Live updates automatically fall back from SSE to polling every few seconds.

## Going live with the real WhatsApp Cloud API

1. Create a Meta app with the WhatsApp product and get a **Phone Number ID** and permanent
   **access token**.
2. In **Settings** (admin): uncheck *Sandbox mode*, paste the Phone Number ID, WhatsApp
   Business Account (WABA) ID, access token, and choose a webhook verify token.
3. In Meta's app dashboard, set the webhook callback URL to
   `https://your-domain/webhook/whatsapp` with the same verify token, subscribed to
   `messages` and `message_template_status_update`.
4. On the Templates page, click **⟳ Sync from Meta** to import your approved template
   library, or **Submit to Meta** to send locally created templates for approval.

## AI configuration

Add an Anthropic API key in **Settings** (or set `ANTHROPIC_API_KEY`). Each AI agent has its
own system prompt, model (defaults to Claude Haiku), and handoff keywords. The AI appends a
`[HANDOFF]` token when it decides a human is needed, which triggers round-robin assignment.

## Stack

Node.js (22.5+) + Express + built-in `node:sqlite` (zero external services, zero native
modules), vanilla-JS SPA, SSE for real-time. Data lives in `data/crm.sqlite`.

## Environment variables (all optional)

| Variable            | Purpose                                  |
|---------------------|------------------------------------------|
| `PORT`              | HTTP port (default 3000)                 |
| `DATA_DIR`          | SQLite directory (default `./data`)      |
| `JWT_SECRET`        | Auth token secret (auto-generated)       |
| `ANTHROPIC_API_KEY` | AI replies (or set via Settings UI)      |
