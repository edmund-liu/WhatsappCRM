// Broadcast campaign engine.
//
// Campaigns target all contacts or a tag segment, render an approved template
// per contact, and send with basic rate limiting. A polling loop also picks up
// scheduled campaigns whose time has arrived. Delivery/read stats update via
// the webhook status pipeline (real or sandbox).
import db from '../db.js';
import { emit } from './events.js';
import { sendTemplate, renderTemplate, buildTemplateParams } from './whatsapp.js';

const SEND_INTERVAL_MS = 150; // ~6-7 msgs/sec, well under Cloud API limits
const running = new Set();

export function audienceForBroadcast(broadcast) {
  const contacts = db.prepare('SELECT * FROM contacts WHERE opted_out = 0').all();
  if (!broadcast.audience_tag) return contacts;
  return contacts.filter((c) => {
    try { return JSON.parse(c.tags).includes(broadcast.audience_tag); } catch { return false; }
  });
}

export function startBroadcast(broadcastId) {
  if (running.has(broadcastId)) return;
  running.add(broadcastId);
  runBroadcast(broadcastId)
    .catch((err) => console.error(`Broadcast ${broadcastId} failed:`, err))
    .finally(() => running.delete(broadcastId));
}

async function runBroadcast(broadcastId) {
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(broadcastId);
  if (!broadcast || ['completed', 'cancelled'].includes(broadcast.status)) return;
  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(broadcast.template_id);
  if (!template) return;

  db.prepare("UPDATE broadcasts SET status = 'sending', started_at = COALESCE(started_at, datetime('now')) WHERE id = ?").run(broadcastId);
  emit('broadcast_progress', { broadcast_id: broadcastId });

  // Materialize the recipient list once (skip if resuming).
  const existing = db.prepare('SELECT COUNT(*) AS c FROM broadcast_recipients WHERE broadcast_id = ?').get(broadcastId).c;
  if (existing === 0) {
    const insert = db.prepare('INSERT INTO broadcast_recipients (broadcast_id, contact_id) VALUES (?, ?)');
    for (const contact of audienceForBroadcast(broadcast)) insert.run(broadcastId, contact.id);
  }

  const variables = JSON.parse(broadcast.variables || '[]');
  const queued = db.prepare(
    "SELECT br.id AS recipient_id, c.* FROM broadcast_recipients br JOIN contacts c ON c.id = br.contact_id WHERE br.broadcast_id = ? AND br.status = 'queued'"
  ).all(broadcastId);

  for (const contact of queued) {
    // Re-check status so a cancel takes effect mid-send.
    const current = db.prepare('SELECT status FROM broadcasts WHERE id = ?').get(broadcastId);
    if (!current || current.status === 'cancelled') return;
    try {
      // Positional params for Meta (via param_map); local rendering keeps
      // {{name}}/{{n}} semantics for the conversation-thread copy.
      const params = buildTemplateParams(template, contact, variables);
      const waMessageId = await sendTemplate(contact.wa_id, template, params);
      const renderedVars = variables.map((v) => renderTemplate(v, contact));
      db.prepare("UPDATE broadcast_recipients SET status = 'sent', wa_message_id = ?, sent_at = datetime('now') WHERE id = ?")
        .run(waMessageId, contact.recipient_id);
      recordBroadcastMessage(broadcastId, contact, renderTemplate(template.body, contact, renderedVars), waMessageId);
    } catch (err) {
      db.prepare("UPDATE broadcast_recipients SET status = 'failed', error = ? WHERE id = ?")
        .run(String(err.message).slice(0, 300), contact.recipient_id);
    }
    emit('broadcast_progress', { broadcast_id: broadcastId });
    await new Promise((r) => setTimeout(r, SEND_INTERVAL_MS));
  }

  db.prepare("UPDATE broadcasts SET status = 'completed', completed_at = datetime('now') WHERE id = ? AND status = 'sending'").run(broadcastId);
  emit('broadcast_progress', { broadcast_id: broadcastId });
}

// Broadcast sends also appear in the contact's conversation thread.
function recordBroadcastMessage(broadcastId, contact, renderedBody, waMessageId) {
  let conv = db.prepare('SELECT id FROM conversations WHERE contact_id = ? ORDER BY id DESC LIMIT 1').get(contact.id);
  if (!conv) {
    const info = db.prepare("INSERT INTO conversations (contact_id, status, last_message_at) VALUES (?, 'resolved', datetime('now'))").run(contact.id);
    conv = { id: info.lastInsertRowid };
  }
  db.prepare(
    "INSERT INTO messages (conversation_id, direction, sender_type, type, body, wa_message_id, status) VALUES (?, 'out', 'broadcast', 'template', ?, ?, 'sent')"
  ).run(conv.id, renderedBody, waMessageId);
  db.prepare("UPDATE conversations SET last_message_at = datetime('now'), last_message_preview = ? WHERE id = ?")
    .run(`📣 ${renderedBody}`.slice(0, 120), conv.id);
  emit('message_created', { conversation_id: conv.id });
}

export function broadcastStats(broadcastId) {
  return db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(status = 'queued') AS queued,
      SUM(status = 'sent') AS sent,
      SUM(status = 'delivered') AS delivered,
      SUM(status = 'read') AS read,
      SUM(status = 'failed') AS failed
    FROM broadcast_recipients WHERE broadcast_id = ?
  `).get(broadcastId);
}

// Scheduler: fire scheduled campaigns whose time has arrived.
export function startScheduler() {
  setInterval(() => {
    const due = db.prepare(
      "SELECT id FROM broadcasts WHERE status = 'scheduled' AND scheduled_at <= datetime('now')"
    ).all();
    for (const b of due) startBroadcast(b.id);
  }, 10000);
}
