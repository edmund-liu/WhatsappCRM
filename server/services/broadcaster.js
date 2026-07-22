// Broadcast campaign engine.
//
// Campaigns target all contacts or a tag segment, render an approved template
// per contact, and send with basic rate limiting. A polling loop also picks up
// scheduled campaigns whose time has arrived. Delivery/read stats update via
// the webhook status pipeline (real or sandbox).
import db from '../db.js';
import { emit } from './events.js';
import { sendTemplate, renderTemplate, buildTemplateParams } from './whatsapp.js';
import { getOrCreateConversation } from './conversations.js';

// ~6-7 msgs/sec, well under Cloud API limits. No pacing delay on serverless,
// where the whole run must fit inside one request's execution window.
const SEND_INTERVAL_MS = process.env.VERCEL ? 0 : 150;
const running = new Set();

export async function audienceForBroadcast(broadcast) {
  const contacts = await db.prepare('SELECT * FROM contacts WHERE opted_out = 0').all();
  if (!broadcast.audience_tag) return contacts;
  return contacts.filter((c) => {
    try { return JSON.parse(c.tags).includes(broadcast.audience_tag); } catch { return false; }
  });
}

export function startBroadcast(broadcastId) {
  if (running.has(broadcastId)) return Promise.resolve();
  running.add(broadcastId);
  return runBroadcast(broadcastId)
    .catch((err) => console.error(`Broadcast ${broadcastId} failed:`, err))
    .finally(() => running.delete(broadcastId));
}

async function runBroadcast(broadcastId) {
  const broadcast = await db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(broadcastId);
  if (!broadcast || ['completed', 'cancelled'].includes(broadcast.status)) return;
  const template = await db.prepare('SELECT * FROM templates WHERE id = ?').get(broadcast.template_id);
  if (!template) return;

  await db.prepare("UPDATE broadcasts SET status = 'sending', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?").run(broadcastId);
  emit('broadcast_progress', { broadcast_id: broadcastId });

  // Materialize the recipient list once (skip if resuming).
  const existing = (await db.prepare('SELECT COUNT(*) AS c FROM broadcast_recipients WHERE broadcast_id = ?').get(broadcastId)).c;
  if (existing === 0) {
    const insert = db.prepare('INSERT INTO broadcast_recipients (broadcast_id, contact_id) VALUES (?, ?)');
    for (const contact of await audienceForBroadcast(broadcast)) await insert.run(broadcastId, contact.id);
  }

  const variables = JSON.parse(broadcast.variables || '[]');
  const queued = await db.prepare(
    "SELECT br.id AS recipient_id, c.* FROM broadcast_recipients br JOIN contacts c ON c.id = br.contact_id WHERE br.broadcast_id = ? AND br.status = 'queued'"
  ).all(broadcastId);

  for (const contact of queued) {
    // Re-check status so a cancel takes effect mid-send.
    const current = await db.prepare('SELECT status FROM broadcasts WHERE id = ?').get(broadcastId);
    if (!current || current.status === 'cancelled') return;
    try {
      // Positional params for Meta (via param_map); local rendering keeps
      // {{name}}/{{n}} semantics for the conversation-thread copy.
      const params = buildTemplateParams(template, contact, variables);
      const headerImageUrl = broadcast.header_image_url || template.header_image_url || null;
      const waMessageId = await sendTemplate(contact.wa_id, template, params, { headerImageUrl });
      const renderedVars = variables.map((v) => renderTemplate(v, contact));
      await db.prepare("UPDATE broadcast_recipients SET status = 'sent', wa_message_id = ?, sent_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(waMessageId, contact.recipient_id);
      await recordBroadcastMessage(broadcastId, contact, renderTemplate(template.body, contact, renderedVars), waMessageId,
        { mediaUrl: headerImageUrl, buttons: template.buttons });
    } catch (err) {
      await db.prepare("UPDATE broadcast_recipients SET status = 'failed', error = ? WHERE id = ?")
        .run(String(err.message).slice(0, 300), contact.recipient_id);
    }
    emit('broadcast_progress', { broadcast_id: broadcastId });
    if (SEND_INTERVAL_MS) await new Promise((r) => setTimeout(r, SEND_INTERVAL_MS));
  }

  await db.prepare("UPDATE broadcasts SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'sending'").run(broadcastId);
  emit('broadcast_progress', { broadcast_id: broadcastId });
}

// Broadcast sends also appear in the contact's single conversation thread
// (created as resolved if the contact has never had one, so it stays out of
// the active inbox until the customer replies).
async function recordBroadcastMessage(broadcastId, contact, renderedBody, waMessageId, { mediaUrl = null, buttons = '[]' } = {}) {
  const { conv } = await getOrCreateConversation(contact.id, { status: 'resolved' });
  await db.prepare(
    "INSERT INTO messages (conversation_id, direction, sender_type, type, body, wa_message_id, status, media_url, buttons) VALUES (?, 'out', 'broadcast', 'template', ?, ?, 'sent', ?, ?)"
  ).run(conv.id, renderedBody, waMessageId, mediaUrl, buttons || '[]');
  await db.prepare("UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = ? WHERE id = ?")
    .run(`📣 ${renderedBody}`.slice(0, 120), conv.id);
  emit('message_created', { conversation_id: conv.id });
}

export async function broadcastStats(broadcastId) {
  return db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN status = 'read' THEN 1 ELSE 0 END) AS read,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM broadcast_recipients WHERE broadcast_id = ?
  `).get(broadcastId);
}

// Scheduler: fire scheduled campaigns whose time has arrived.
export function startScheduler() {
  setInterval(async () => {
    try {
      const due = await db.prepare(
        "SELECT id FROM broadcasts WHERE status = 'scheduled' AND scheduled_at <= CURRENT_TIMESTAMP"
      ).all();
      for (const b of due) startBroadcast(b.id);
    } catch (err) {
      console.error('Scheduler error:', err);
    }
  }, 10000);
}
