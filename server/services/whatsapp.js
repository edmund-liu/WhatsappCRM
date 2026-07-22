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
import { SERVERLESS } from '../runtime.js';

const GRAPH_VERSION = 'v21.0';

export async function isSandbox() {
  return (await getSetting('sandbox_mode', '1')) === '1' || !(await getSetting('wa_access_token'));
}

async function graphSend(payload) {
  const token = await getSetting('wa_access_token');
  const phoneNumberId = await getSetting('wa_phone_number_id');
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
// status-update path the real webhook would. Serverless platforms freeze the
// process after the response, so timers never fire there — apply immediately.
function simulateReceipts(waMessageId) {
  const apply = (status) => applyStatusUpdate(waMessageId, status).catch((err) => console.error('Receipt sim error:', err));
  if (SERVERLESS) {
    setImmediate(() => { apply('delivered'); setImmediate(() => apply('read')); });
    return;
  }
  setTimeout(() => apply('delivered'), 800 + Math.random() * 1200);
  setTimeout(() => apply('read'), 3000 + Math.random() * 4000);
}

export async function sendText(toWaId, text) {
  if (await isSandbox()) {
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

// Send an image or audio message. `link` must be a publicly reachable URL in
// live mode (relative /uploads paths are resolved against the request host).
export async function sendMedia(toWaId, { type, link, caption = '' }) {
  if (await isSandbox()) {
    const id = fakeMessageId();
    simulateReceipts(id);
    return id;
  }
  const media = { link };
  if (type === 'image' && caption) media.caption = caption;
  return graphSend({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toWaId,
    type,
    [type]: media,
  });
}

// Live mode: resolve a Meta media ID to a local file in the uploads dir.
export async function downloadMediaById(mediaId, uploadsDir) {
  const token = await getSetting('wa_access_token');
  if (!token) throw new Error('No access token configured');
  const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const meta = await metaRes.json();
  if (!metaRes.ok) throw new Error(meta.error?.message || 'Media lookup failed');
  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!fileRes.ok) throw new Error(`Media download failed (${fileRes.status})`);
  const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/amr': 'amr', 'video/mp4': 'mp4' })[meta.mime_type?.split(';')[0]] || 'bin';
  const name = `wa-${mediaId}.${ext}`;
  const fs = await import('fs');
  fs.writeFileSync(`${uploadsDir}/${name}`, Buffer.from(await fileRes.arrayBuffer()));
  return `/uploads/${name}`;
}

export async function sendTemplate(toWaId, template, bodyParams, { headerImageUrl = null } = {}) {
  if (await isSandbox()) {
    const id = fakeMessageId();
    simulateReceipts(id);
    return id;
  }
  const components = [];
  if (headerImageUrl) {
    components.push({ type: 'header', parameters: [{ type: 'image', image: { link: headerImageUrl } }] });
  }
  if (bodyParams.length) {
    components.push({ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: t })) });
  }
  // Static URL and quick-reply buttons live on the approved template itself
  // and need no send-time parameters.
  return graphSend({
    messaging_product: 'whatsapp',
    to: toWaId,
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.language },
      components,
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
  if (await isSandbox()) return;
  const last = await db.prepare(
    "SELECT wa_message_id FROM messages WHERE conversation_id = ? AND direction = 'in' AND wa_message_id IS NOT NULL ORDER BY id DESC LIMIT 1"
  ).get(conversationId);
  if (!last) return;
  await graphSend({ messaging_product: 'whatsapp', status: 'read', message_id: last.wa_message_id });
}

// ---- Template sync with Meta (WhatsApp Business Management API) ----

async function wabaConfig() {
  const token = await getSetting('wa_access_token');
  const wabaId = await getSetting('wa_waba_id');
  if (!token || !wabaId) throw new Error('Configure the access token and WhatsApp Business Account (WABA) ID in Settings first');
  return { token, wabaId };
}

// Pull the WABA's template library into the local table (upsert by name).
export async function pullTemplatesFromMeta() {
  const { token, wabaId } = await wabaConfig();
  const upsert = db.prepare(`
    INSERT INTO templates (name, language, category, body, status, param_map, meta_id, header_image_url, buttons)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET language = excluded.language, category = excluded.category,
      body = excluded.body, status = excluded.status, param_map = excluded.param_map, meta_id = excluded.meta_id,
      header_image_url = COALESCE(excluded.header_image_url, templates.header_image_url), buttons = excluded.buttons
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
      const headerComp = (t.components || []).find((c) => c.type === 'HEADER' && c.format === 'IMAGE');
      // Meta returns an upload handle (not a URL) as the header example; only
      // keep it if it looks like a usable link, else the operator sets one.
      const headerExample = headerComp?.example?.header_handle?.[0];
      const headerUrl = headerExample && /^https?:\/\//.test(headerExample) ? headerExample : null;
      const buttonsComp = (t.components || []).find((c) => c.type === 'BUTTONS');
      const buttons = (buttonsComp?.buttons || [])
        .filter((b) => ['QUICK_REPLY', 'URL'].includes(b.type))
        .map((b) => ({ type: b.type, text: b.text, ...(b.type === 'URL' ? { url: b.url } : {}) }));
      await upsert.run(t.name, t.language || 'en', category, bodyComp.text, t.status || 'APPROVED',
        JSON.stringify(computeParamMap(bodyComp.text)), t.id || null, headerUrl, JSON.stringify(buttons));
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
  const { token, wabaId } = await wabaConfig();
  const metaBody = toMetaBody(template.body);
  const map = computeParamMap(template.body);
  const components = [];
  if (template.header_image_url) {
    // Meta prefers an upload handle here; a public URL works for many WABAs.
    // If Meta rejects it, upload the sample via the Resumable Upload API or
    // create the template in Business Manager and pull it with template sync.
    components.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [template.header_image_url] } });
  }
  const bodyComponent = { type: 'BODY', text: metaBody };
  if (map.length) {
    bodyComponent.example = { body_text: [map.map((tok, i) => (tok === 'name' ? 'Alex' : `example ${i + 1}`))] };
  }
  components.push(bodyComponent);
  let buttons = [];
  try { buttons = JSON.parse(template.buttons || '[]'); } catch { /* ignore */ }
  if (buttons.length) {
    components.push({
      type: 'BUTTONS',
      buttons: buttons.map((b) => b.type === 'URL'
        ? { type: 'URL', text: b.text, url: b.url }
        : { type: 'QUICK_REPLY', text: b.text }),
    });
  }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: template.name,
      language: template.language,
      category: template.category,
      components,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.error_user_msg || json.error?.message || `Template submission failed (${res.status})`);
  await db.prepare('UPDATE templates SET status = ?, meta_id = ? WHERE id = ?')
    .run(json.status || 'PENDING', json.id || null, template.id);
  return json;
}

// Shared by the live webhook and the sandbox receipt simulator.
export async function applyStatusUpdate(waMessageId, status, error = null) {
  const rank = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
  const msg = await db.prepare('SELECT id, conversation_id, status FROM messages WHERE wa_message_id = ?').get(waMessageId);
  if (msg && (rank[status] ?? 0) > (rank[msg.status] ?? 0)) {
    await db.prepare('UPDATE messages SET status = ?, error = COALESCE(?, error) WHERE id = ?').run(status, error, msg.id);
    emit('message_status', { message_id: msg.id, conversation_id: msg.conversation_id, status });
  }
  const recip = await db.prepare('SELECT id, broadcast_id, status FROM broadcast_recipients WHERE wa_message_id = ?').get(waMessageId);
  if (recip && (rank[status] ?? 0) > (rank[recip.status] ?? 0)) {
    await db.prepare('UPDATE broadcast_recipients SET status = ?, error = COALESCE(?, error) WHERE id = ?').run(status, error, recip.id);
    emit('broadcast_progress', { broadcast_id: recip.broadcast_id });
  }
}
