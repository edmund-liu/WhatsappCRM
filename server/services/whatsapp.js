// WhatsApp Cloud API client.
//
// Two modes:
//  - Live mode: sends via Meta's Graph API using credentials from Settings.
//  - Sandbox mode (default): simulates the Cloud API locally so the whole
//    product can be exercised without a Meta business account. Outbound
//    messages get fake message IDs and delivery/read receipts are simulated
//    through the same webhook status pipeline the live API would use.
import db, { getSetting } from '../db.js';
import { emit } from './events.js';

const GRAPH_VERSION = 'v21.0';

export function isSandbox() {
  return getSetting('sandbox_mode', '1') === '1' || !getSetting('wa_access_token');
}

async function graphSend(payload) {
  const token = getSetting('wa_access_token');
  const phoneNumberId = getSetting('wa_phone_number_id');
  if (!token || !phoneNumberId) throw new Error('WhatsApp Cloud API credentials not configured');
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `Graph API error ${res.status}`);
  return json.messages?.[0]?.id;
}

function fakeMessageId() {
  return 'wamid.SBX' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Simulate delivery + read receipts in sandbox mode, driving the same
// status-update path the real webhook would.
function simulateReceipts(waMessageId) {
  setTimeout(() => applyStatusUpdate(waMessageId, 'delivered'), 800 + Math.random() * 1200);
  setTimeout(() => applyStatusUpdate(waMessageId, 'read'), 3000 + Math.random() * 4000);
}

export async function sendText(toWaId, text) {
  if (isSandbox()) {
    const id = fakeMessageId();
    simulateReceipts(id);
    return id;
  }
  return graphSend({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toWaId,
    type: 'text',
    text: { body: text },
  });
}

export async function sendTemplate(toWaId, template, bodyParams) {
  if (isSandbox()) {
    const id = fakeMessageId();
    simulateReceipts(id);
    return id;
  }
  return graphSend({
    messaging_product: 'whatsapp',
    to: toWaId,
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.language },
      components: bodyParams.length
        ? [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: t })) }]
        : [],
    },
  });
}

// Render a template body: {{name}} -> contact name, {{1}},{{2}}... -> variables.
export function renderTemplate(body, contact, variables = []) {
  let out = body.replaceAll('{{name}}', contact?.name || 'there');
  variables.forEach((v, i) => { out = out.replaceAll(`{{${i + 1}}}`, v); });
  return out;
}

// Shared by the live webhook and the sandbox receipt simulator.
export function applyStatusUpdate(waMessageId, status) {
  const rank = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
  const msg = db.prepare('SELECT id, conversation_id, status FROM messages WHERE wa_message_id = ?').get(waMessageId);
  if (msg && (rank[status] ?? 0) > (rank[msg.status] ?? 0)) {
    db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, msg.id);
    emit('message_status', { message_id: msg.id, conversation_id: msg.conversation_id, status });
  }
  const recip = db.prepare('SELECT id, broadcast_id, status FROM broadcast_recipients WHERE wa_message_id = ?').get(waMessageId);
  if (recip && (rank[status] ?? 0) > (rank[recip.status] ?? 0)) {
    db.prepare('UPDATE broadcast_recipients SET status = ? WHERE id = ?').run(status, recip.id);
    emit('broadcast_progress', { broadcast_id: recip.broadcast_id });
  }
}
