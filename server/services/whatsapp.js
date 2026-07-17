// WhatsApp Cloud API client.
//
// Two modes:
//  - Live mode: sends via Meta's Graph API using credentials from Settings.
//  - Sandbox mode (default): simulates the Cloud API locally so the whole
//    product can be exercised without a Meta business account. Outbound
//    messages get fake message IDs and delivery/read receipts are simulated
//    through the same webhook status pipeline the live API would use.
import db, { getSetting, computeParamMap } from '../db.js';
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

// Positional body params for the Cloud API, resolved via the template's
// param_map ({{name}} tokens become the contact's name, {{n}} tokens pull
// from the campaign variables, which may themselves contain {{name}}).
export function buildTemplateParams(template, contact, variables = []) {
  let map = [];
  try { map = JSON.parse(template.param_map || '[]'); } catch { /* ignore */ }
  return map.map((tok) => tok === 'name'
    ? (contact?.name || 'there')
    : renderTemplate(String(variables[Number(tok) - 1] ?? ''), contact));
}

// Meta only accepts sequential positional placeholders: convert
// "Hi {{name}}, order {{1}}" -> "Hi {{1}}, order {{2}}".
export function toMetaBody(body) {
  let i = 0;
  return String(body).replace(/\{\{(name|\d+)\}\}/g, () => `{{${++i}}}`);
}

// Sync the customer's "read" state back to Meta (blue ticks on their phone).
// WhatsApp marks everything up to the given message as read, so marking the
// latest inbound message covers the whole conversation.
export async function markConversationRead(conversationId) {
  if (isSandbox()) return;
  const last = db.prepare(
    "SELECT wa_message_id FROM messages WHERE conversation_id = ? AND direction = 'in' AND wa_message_id IS NOT NULL ORDER BY id DESC LIMIT 1"
  ).get(conversationId);
  if (!last) return;
  await graphSend({ messaging_product: 'whatsapp', status: 'read', message_id: last.wa_message_id });
}

// ---- Template sync with Meta (WhatsApp Business Management API) ----

function wabaConfig() {
  const token = getSetting('wa_access_token');
  const wabaId = getSetting('wa_waba_id');
  if (!token || !wabaId) throw new Error('Configure the access token and WhatsApp Business Account (WABA) ID in Settings first');
  return { token, wabaId };
}

// Pull the WABA's template library into the local table (upsert by name).
export async function pullTemplatesFromMeta() {
  const { token, wabaId } = wabaConfig();
  const upsert = db.prepare(`
    INSERT INTO templates (name, language, category, body, status, param_map, meta_id) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET language = excluded.language, category = excluded.category,
      body = excluded.body, status = excluded.status, param_map = excluded.param_map, meta_id = excluded.meta_id
  `);
  let url = `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates?fields=name,status,category,language,components&limit=100`;
  let count = 0;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || `Template fetch failed (${res.status})`);
    for (const t of json.data || []) {
      const bodyComp = (t.components || []).find((c) => c.type === 'BODY');
      if (!bodyComp?.text) continue;
      const category = ['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(t.category) ? t.category : 'MARKETING';
      upsert.run(t.name, t.language || 'en', category, bodyComp.text, t.status || 'APPROVED',
        JSON.stringify(computeParamMap(bodyComp.text)), t.id || null);
      count++;
    }
    url = json.paging?.next || null;
  }
  return count;
}

// Submit a locally created template to Meta for approval. The local body keeps
// its {{name}} token; Meta receives the positional version, and param_map
// bridges the two at send time.
export async function pushTemplateToMeta(template) {
  const { token, wabaId } = wabaConfig();
  const metaBody = toMetaBody(template.body);
  const map = computeParamMap(template.body);
  const component = { type: 'BODY', text: metaBody };
  if (map.length) {
    component.example = { body_text: [map.map((tok, i) => (tok === 'name' ? 'Alex' : `example ${i + 1}`))] };
  }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: template.name,
      language: template.language,
      category: template.category,
      components: [component],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.error_user_msg || json.error?.message || `Template submission failed (${res.status})`);
  db.prepare('UPDATE templates SET status = ?, meta_id = ? WHERE id = ?')
    .run(json.status || 'PENDING', json.id || null, template.id);
  return json;
}

// Shared by the live webhook and the sandbox receipt simulator.
export function applyStatusUpdate(waMessageId, status, error = null) {
  const rank = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
  const msg = db.prepare('SELECT id, conversation_id, status FROM messages WHERE wa_message_id = ?').get(waMessageId);
  if (msg && (rank[status] ?? 0) > (rank[msg.status] ?? 0)) {
    db.prepare('UPDATE messages SET status = ?, error = COALESCE(?, error) WHERE id = ?').run(status, error, msg.id);
    emit('message_status', { message_id: msg.id, conversation_id: msg.conversation_id, status });
  }
  const recip = db.prepare('SELECT id, broadcast_id, status FROM broadcast_recipients WHERE wa_message_id = ?').get(waMessageId);
  if (recip && (rank[status] ?? 0) > (rank[recip.status] ?? 0)) {
    db.prepare('UPDATE broadcast_recipients SET status = ?, error = COALESCE(?, error) WHERE id = ?').run(status, error, recip.id);
    emit('broadcast_progress', { broadcast_id: recip.broadcast_id });
  }
}
