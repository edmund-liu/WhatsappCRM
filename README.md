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
- **SLA tracking** — set a first-response target (minutes) in Settings; every conversation
  gets a live "customer waiting" clock that starts on an inbound message and stops on any
  reply. The inbox shows a "⏳ SLA 12m" / "⏰ Overdue 5m" badge (ticking in place, no
  flicker), and Analytics reports average first-response time, % answered within target,
  average resolution time, and the count of currently-breaching conversations. After-hours
  away replies and STOP/START confirmations clear the clock without counting toward the
  metric, so teams aren't penalized for overnight messages or automated acknowledgements.
- **24-hour session window & STOP/START compliance** — WhatsApp only allows free-form
  replies within 24 hours of the customer's last message (or never, if they haven't
  messaged at all); this is now enforced everywhere, with a banner in the thread (closed,
  or a "closes in ~X min" warning) and the composer swapping to a template-send picker
  once the window closes, so agents can reopen the conversation instead of hitting a
  silent failure. Separately, a message whose entire text exactly matches a configurable
  keyword ("STOP", "UNSUBSCRIBE", etc.) automatically opts the contact out of broadcasts
  with a confirmation reply — no AI/routing noise — and "START" opts back in.
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
- **Handoff with full context** — the receiving agent sees the entire past conversation
  (customer, AI, and team messages) in the thread, plus a **handoff summary card** pinned
  at the transfer point recapping what the customer needs and the details they gave
  (AI-written when an Anthropic key is set, digest-based otherwise). An ℹ️ contact panel
  shows the latest summary, topic, assignment, and history stats at a glance.
- **Working hours & holidays** — configure a weekly schedule (per-day open/close times,
  supports overnight windows) in any IANA timezone, plus a holiday calendar, from Settings.
  When enabled, messages that arrive outside those hours or on a holiday get a
  **configurable away reply** (tokens: `{{name}}`, `{{reason}}`, `{{next_open}}` — e.g. "back
  tomorrow at 9:00 AM") instead of AI/round-robin routing, sent at most once per business
  day per conversation; the conversation is still queued to a human for when hours resume.
  Live preview while editing.
- **Contacts & tags** — contact book with tags (used as broadcast audiences), custom
  attributes, opt-out flag. **Bulk import** from CSV or Excel (.xlsx) with a downloadable
  template: new numbers are created, existing ones have their tags merged, and a summary
  reports imported / updated / skipped rows. The .xlsx reader is dependency-free (parses
  the workbook directly), so no native or flagged packages are added.
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

## Database backends

The app picks its database automatically:

- **No configuration** → built-in SQLite (`node:sqlite`), file in `./data`. Perfect for
  local use and always-on hosts.
- **`DATABASE_URL` (or `POSTGRES_URL`) set** → Postgres. Required for serverless hosting:
  the schema is created and seeded automatically on first start.

## Deploying to Vercel

The repo includes `api/index.js` + `vercel.json`, so importing the project into Vercel
works out of the box (set the project's Node.js version to 22.x). Configure two
environment variables in the project settings:

1. **`DATABASE_URL`** — a Postgres connection string. Free options: [Neon](https://neon.tech),
   Vercel Postgres/Marketplace, or Supabase. **Without this, Vercel falls back to SQLite in
   `/tmp`, which is wiped on cold starts and NOT shared between function instances — data
   will appear and disappear randomly (e.g. simulated messages never showing up).**
2. **`JWT_SECRET`** — any long random string, so logins survive across instances.

Remaining serverless caveats:

- **Scheduled broadcasts don't fire** (no background scheduler); "Send now" works — the
  send completes within the request (60s max, so keep audiences modest).
- Live updates use polling on serverless (SSE can't span function instances); on
  always-on hosts SSE is used automatically.
- Uploaded media lives on ephemeral disk unless you add object storage; the database
  itself is fully persistent with Postgres.

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
