import { Router } from 'express';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import db, { getSetting, setSetting, computeParamMap, UPLOADS_DIR, SQL } from '../db.js';
import { signToken, requireAuth, requireAdmin } from '../auth.js';
import { emit, sseHandler } from '../services/events.js';
import { sendText, sendMedia, sendTemplate, buildTemplateParams, renderTemplate as renderTemplateBody, isSandbox, markConversationRead, pullTemplatesFromMeta, pushTemplateToMeta } from '../services/whatsapp.js';
import { assignConversation, addSystemNote } from '../services/assignment.js';
import { startBroadcast, broadcastStats, audienceForBroadcast } from '../services/broadcaster.js';
import { handleInboundMessage } from '../services/inbound.js';
import { getOrCreateConversation } from '../services/conversations.js';
import { importContacts } from '../services/importer.js';
import { getBusinessHoursConfig, setBusinessHoursConfig, computeNextOpenLabel, renderAwayMessage, DAY_KEYS } from '../services/businessHours.js';
import { getSessionWindowStatus } from '../services/sessionWindow.js';
import { getOptOutConfig, setOptOutConfig } from '../services/optOut.js';
import { getSlaConfig, setSlaConfig, slaStatusFor, recordResponse } from '../services/sla.js';
import { getCsatConfig, setCsatConfig, maybeSendSurvey } from '../services/csat.js';
import { fetchExternalData, isExternalDataConfigured } from '../services/externalData.js';
import { ingestText, ingestCsv, ingestUrl, mineConversations, retrieve } from '../services/knowledge.js';
import { SERVERLESS } from '../runtime.js';

const router = Router();

// ---------- Auth ----------
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase().trim());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!user.is_active) return res.status(401).json({ error: 'Account disabled' });
  res.json({
    token: signToken(user),
    user: { id: user.id, name: user.name, email: user.email, role: user.role, available: user.available, status: user.status || 'online' },
  });
});

router.use(requireAuth);

router.get('/me', (req, res) => res.json(req.user));

// Three-state presence. Only 'online' is available for round-robin; 'offline'
// additionally can't manually assign. `available` is kept in sync for the
// existing round-robin query.
const STATUSES = ['online', 'away', 'offline'];
router.patch('/me/status', async (req, res) => {
  const status = STATUSES.includes(req.body?.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'status must be online, away, or offline' });
  await db.prepare('UPDATE users SET status = ?, available = ? WHERE id = ?').run(status, status === 'online' ? 1 : 0, req.user.id);
  res.json({ ok: true, status, available: status === 'online' ? 1 : 0 });
});

// ---------- Client runtime config ----------
router.get('/config', async (req, res) => {
  res.json({ serverless: SERVERLESS, sandbox: await isSandbox() });
});

// ---------- Events (SSE) ----------
router.get('/events', sseHandler);

// ---------- Media uploads ----------
// Raw binary body (pasted screenshots, attached images, audio files).
const MEDIA_TYPES = {
  'image/png': { ext: 'png', kind: 'image' },
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'image/gif': { ext: 'gif', kind: 'image' },
  'audio/mpeg': { ext: 'mp3', kind: 'audio' },
  'audio/ogg': { ext: 'ogg', kind: 'audio' },
  'audio/wav': { ext: 'wav', kind: 'audio' },
  'audio/x-wav': { ext: 'wav', kind: 'audio' },
  'audio/webm': { ext: 'webm', kind: 'audio' },
  'audio/mp4': { ext: 'm4a', kind: 'audio' },
};

router.post('/uploads', express.raw({ type: () => true, limit: '10mb' }), (req, res) => {
  const mime = (req.headers['content-type'] || '').split(';')[0].trim();
  const spec = MEDIA_TYPES[mime];
  if (!spec) return res.status(400).json({ error: `Unsupported file type "${mime}". Images (png/jpg/webp/gif) and audio (mp3/ogg/wav/m4a/webm) are allowed.` });
  if (!req.body?.length) return res.status(400).json({ error: 'Empty upload' });
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}.${spec.ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, name), req.body);
  res.json({ url: `/uploads/${name}`, kind: spec.kind });
});

// ---------- Team (users) ----------
router.get('/users', async (req, res) => {
  const rows = await db.prepare('SELECT id, name, email, role, is_active, available, status, skills, created_at FROM users ORDER BY id').all();
  res.json(rows.map((u) => ({ ...u, skills: JSON.parse(u.skills || '[]') })));
});

router.post('/users', requireAdmin, async (req, res) => {
  const { name, email, password, role, skills } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });
  try {
    const info = await db.prepare('INSERT INTO users (name, email, password_hash, role, skills) VALUES (?, ?, ?, ?, ?)')
      .run(name, String(email).toLowerCase().trim(), bcrypt.hashSync(password, 10), role === 'admin' ? 'admin' : 'agent',
        JSON.stringify(Array.isArray(skills) ? skills : []));
    res.json(await db.prepare('SELECT id, name, email, role, is_active, available, skills FROM users WHERE id = ?').get(info.lastInsertRowid));
  } catch {
    res.status(400).json({ error: 'Email already in use' });
  }
});

router.patch('/users/:id', requireAdmin, async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { name, role, is_active, available, password, skills } = req.body || {};
  // Keep the three-state status coherent when an admin toggles availability.
  const newAvailable = available === undefined ? user.available : (available ? 1 : 0);
  let newStatus = user.status;
  if (available !== undefined) newStatus = available ? 'online' : (user.status === 'online' ? 'offline' : user.status);
  await db.prepare('UPDATE users SET name = ?, role = ?, is_active = ?, available = ?, status = ?, skills = ? WHERE id = ?').run(
    name ?? user.name,
    role === 'admin' || role === 'agent' ? role : user.role,
    is_active === undefined ? user.is_active : (is_active ? 1 : 0),
    newAvailable,
    newStatus,
    Array.isArray(skills) ? JSON.stringify(skills) : user.skills,
    user.id
  );
  if (password) await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), user.id);
  res.json({ ok: true });
});

// ---------- Routing skills ----------
router.get('/skills', async (req, res) => {
  res.json((await db.prepare('SELECT * FROM skills ORDER BY name').all())
    .map((s) => ({ ...s, keywords: JSON.parse(s.keywords) })));
});

router.post('/skills', requireAdmin, async (req, res) => {
  const { name, keywords } = req.body || {};
  const slug = String(name || '').toLowerCase().trim().replace(/\s+/g, '-');
  if (!slug) return res.status(400).json({ error: 'name is required' });
  try {
    const info = await db.prepare('INSERT INTO skills (name, keywords) VALUES (?, ?)')
      .run(slug, JSON.stringify(Array.isArray(keywords) ? keywords : []));
    res.json(await db.prepare('SELECT * FROM skills WHERE id = ?').get(info.lastInsertRowid));
  } catch {
    res.status(400).json({ error: 'A skill with that name already exists' });
  }
});

router.patch('/skills/:id', requireAdmin, async (req, res) => {
  const skill = await db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.id);
  if (!skill) return res.status(404).json({ error: 'Skill not found' });
  const { keywords } = req.body || {};
  await db.prepare('UPDATE skills SET keywords = ? WHERE id = ?')
    .run(Array.isArray(keywords) ? JSON.stringify(keywords) : skill.keywords, skill.id);
  res.json({ ok: true });
});

router.delete('/skills/:id', requireAdmin, async (req, res) => {
  const skill = await db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.id);
  if (!skill) return res.status(404).json({ error: 'Skill not found' });
  await db.prepare('DELETE FROM skills WHERE id = ?').run(skill.id);
  // Remove the skill from any user or AI agent that lists it.
  for (const table of ['users', 'ai_agents']) {
    for (const row of await db.prepare(`SELECT id, skills FROM ${table}`).all()) {
      const skills = JSON.parse(row.skills || '[]');
      if (skills.includes(skill.name)) {
        await db.prepare(`UPDATE ${table} SET skills = ? WHERE id = ?`)
          .run(JSON.stringify(skills.filter((s) => s !== skill.name)), row.id);
      }
    }
  }
  res.json({ ok: true });
});

// ---------- Contacts ----------
router.get('/contacts', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM contacts ORDER BY COALESCE(last_message_at, created_at) DESC').all();
  res.json(rows.map((c) => ({ ...c, tags: JSON.parse(c.tags), attributes: JSON.parse(c.attributes) })));
});

router.post('/contacts', async (req, res) => {
  const { wa_id, name, tags } = req.body || {};
  const phone = String(wa_id || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ error: 'A valid phone number (wa_id) is required' });
  try {
    const info = await db.prepare('INSERT INTO contacts (wa_id, name, tags) VALUES (?, ?, ?)')
      .run(phone, name || null, JSON.stringify(Array.isArray(tags) ? tags : []));
    emit('contact_created', { contact_id: info.lastInsertRowid });
    res.json(await db.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid));
  } catch {
    res.status(400).json({ error: 'A contact with that phone number already exists' });
  }
});

// Bulk import from a CSV or XLSX file (raw binary body).
router.post('/contacts/import', express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
  if (!req.body?.length) return res.status(400).json({ error: 'No file uploaded' });
  const result = await importContacts(req.body);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

router.patch('/contacts/:id', async (req, res) => {
  const contact = await db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const { name, tags, opted_out, attributes } = req.body || {};
  // Merge provided custom-field values into the existing attributes object.
  let attrs = contact.attributes;
  if (attributes && typeof attributes === 'object') {
    let current = {};
    try { current = JSON.parse(contact.attributes || '{}'); } catch { /* ignore */ }
    for (const [k, v] of Object.entries(attributes)) {
      if (v === '' || v == null) delete current[k]; else current[k] = String(v);
    }
    attrs = JSON.stringify(current);
  }
  await db.prepare('UPDATE contacts SET name = ?, tags = ?, opted_out = ?, attributes = ? WHERE id = ?').run(
    name ?? contact.name,
    Array.isArray(tags) ? JSON.stringify(tags) : contact.tags,
    opted_out === undefined ? contact.opted_out : (opted_out ? 1 : 0),
    attrs,
    contact.id
  );
  res.json({ ok: true });
});

// ---------- Conversations & messages ----------
router.get('/conversations', async (req, res) => {
  const { filter, status } = req.query;
  let where = '1=1';
  const params = [];
  if (status && ['open', 'pending', 'resolved'].includes(status)) { where += ' AND cv.status = ?'; params.push(status); }
  if (filter === 'mine') { where += ' AND cv.assigned_user_id = ?'; params.push(req.user.id); }
  if (filter === 'unassigned') where += ' AND cv.assigned_user_id IS NULL AND cv.ai_enabled = 0';
  if (filter === 'ai') where += ' AND cv.ai_enabled = 1';
  if (filter === 'webchat') where += " AND c.channel = 'webchat'";
  if (filter === 'mentions') {
    // Conversations where an unresolved note @mentions the current user.
    const noteRows = await db.prepare("SELECT DISTINCT conversation_id, mentions FROM messages WHERE type = 'note'").all();
    const ids = noteRows.filter((r) => { try { return JSON.parse(r.mentions || '[]').includes(req.user.id); } catch { return false; } })
      .map((r) => r.conversation_id);
    if (!ids.length) return res.json([]);
    where += ` AND cv.status != 'resolved' AND cv.id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  }
  const rows = await db.prepare(`
    SELECT cv.*, c.name AS contact_name, c.wa_id, c.channel AS contact_channel, u.name AS assigned_name, a.name AS ai_agent_name
    FROM conversations cv
    JOIN contacts c ON c.id = cv.contact_id
    LEFT JOIN users u ON u.id = cv.assigned_user_id
    LEFT JOIN ai_agents a ON a.id = cv.ai_agent_id
    WHERE ${where}
    ORDER BY cv.last_message_at DESC NULLS LAST
  `).all(...params);
  const [slaConfig, { scale: csatScale }] = await Promise.all([getSlaConfig(), getCsatConfig()]);
  res.json(rows.map((r) => ({ ...r, sla: slaStatusFor(r, slaConfig), csat_scale: csatScale })));
});

router.get('/conversations/:id', async (req, res) => {
  const conv = await db.prepare(`
    SELECT cv.*, c.name AS contact_name, c.wa_id, c.channel AS contact_channel, c.tags AS contact_tags, c.attributes AS contact_attributes, u.name AS assigned_name, a.name AS ai_agent_name
    FROM conversations cv
    JOIN contacts c ON c.id = cv.contact_id
    LEFT JOIN users u ON u.id = cv.assigned_user_id
    LEFT JOIN ai_agents a ON a.id = cv.ai_agent_id
    WHERE cv.id = ?
  `).get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  const [session, slaConfig, { scale: csatScale }, fields] = await Promise.all([
    getSessionWindowStatus(conv.id), getSlaConfig(), getCsatConfig(), getContactFields(),
  ]);
  res.json({
    ...conv, contact_tags: JSON.parse(conv.contact_tags),
    contact_attributes: JSON.parse(conv.contact_attributes || '{}'),
    fields,
    session, sla: slaStatusFor(conv, slaConfig), csat_scale: csatScale,
  });
});

router.get('/conversations/:id/messages', async (req, res) => {
  const rows = await db.prepare(`
    SELECT m.*, u.name AS sender_name, a.name AS ai_agent_name
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_user_id
    LEFT JOIN ai_agents a ON a.id = m.ai_agent_id
    WHERE m.conversation_id = ? ORDER BY m.id
  `).all(req.params.id);
  const conv = await db.prepare('SELECT unread_count FROM conversations WHERE id = ?').get(req.params.id);
  if (conv?.unread_count) {
    await db.prepare('UPDATE conversations SET unread_count = 0 WHERE id = ?').run(req.params.id);
    // Sync the read state back to Meta so the customer sees blue ticks.
    markConversationRead(Number(req.params.id)).catch((err) => console.error('Read-receipt sync failed:', err.message));
  }
  res.json(rows);
});

router.post('/conversations/:id/messages', async (req, res) => {
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  const text = String(req.body?.text || '').trim();
  const mediaUrl = req.body?.media_url || null;
  const mediaType = ['image', 'audio'].includes(req.body?.media_type) ? req.body.media_type : (mediaUrl ? 'image' : null);
  if (!text && !mediaUrl) return res.status(400).json({ error: 'Message text or an attachment is required' });
  const contact = await db.prepare('SELECT * FROM contacts WHERE id = ?').get(conv.contact_id);

  // Free-form messages only work within 24h of the customer's last message
  // (or if they've never messaged at all) — WhatsApp requires an approved
  // template to reach them outside that window. Applies in sandbox too,
  // since it's a WhatsApp rule, not a transport detail.
  const session = await getSessionWindowStatus(conv.id);
  if (!session.withinWindow) {
    return res.status(409).json({
      error: session.reason === 'no_session'
        ? "This customer hasn't messaged you yet, so WhatsApp only allows an approved template to reach them — send a template instead."
        : "This customer's 24-hour session window has closed — WhatsApp only allows an approved template to reach them now. Send a template to reopen the conversation.",
      session_expired: true,
    });
  }

  try {
    let waMessageId;
    if (mediaUrl) {
      // Relative upload paths must be absolute for Meta's servers to fetch.
      const link = mediaUrl.startsWith('/') ? `${req.protocol}://${req.get('host')}${mediaUrl}` : mediaUrl;
      waMessageId = await sendMedia(contact.wa_id, { type: mediaType, link, caption: text });
    } else {
      waMessageId = await sendText(contact.wa_id, text);
    }
    const info = await db.prepare(
      "INSERT INTO messages (conversation_id, direction, sender_type, sender_user_id, type, body, wa_message_id, status, media_url) VALUES (?, 'out', 'agent', ?, ?, ?, ?, 'sent', ?)"
    ).run(conv.id, req.user.id, mediaType || 'text', text, waMessageId, mediaUrl);
    const preview = mediaType === 'image' ? `📷 ${text || 'Photo'}` : mediaType === 'audio' ? '🎤 Voice message' : text;
    // A human replying takes the conversation over from the AI.
    await db.prepare(
      'UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = ?, ai_enabled = 0, assigned_user_id = COALESCE(assigned_user_id, ?) WHERE id = ?'
    ).run(preview.slice(0, 120), req.user.id, conv.id);
    await recordResponse(conv.id); // agent reply stops the SLA clock
    if (conv.ai_enabled) await addSystemNote(conv.id, `${req.user.name} took over from AI`);
    emit('message_created', { conversation_id: conv.id });
    emit('conversation_updated', { conversation_id: conv.id });
    res.json(await db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    res.status(502).json({ error: `Send failed: ${err.message}` });
  }
});

// Live customer data from the configured webhook (lazy — the panel fetches
// this after opening so the main conversation load stays fast).
router.get('/conversations/:id/external-data', async (req, res) => {
  const conv = await db.prepare('SELECT contact_id FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  if (!(await isExternalDataConfigured())) return res.json({ configured: false });
  const contact = await db.prepare('SELECT * FROM contacts WHERE id = ?').get(conv.contact_id);
  const data = await fetchExternalData(contact, { force: req.query.refresh === '1' });
  res.json({ configured: true, data });
});

// Internal note — team-only, never sent to the customer. @mentions of active
// teammates by name are detected and stored so a mentions filter can surface
// them for the person tagged.
router.post('/conversations/:id/notes', async (req, res) => {
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Note text is required' });
  const users = await db.prepare('SELECT id, name FROM users WHERE is_active = 1').all();
  const lower = text.toLowerCase();
  const mentioned = users.filter((u) => {
    const first = u.name.split(/\s+/)[0].toLowerCase();
    return lower.includes('@' + u.name.toLowerCase()) || lower.includes('@' + first);
  }).map((u) => u.id);
  const info = await db.prepare(
    "INSERT INTO messages (conversation_id, direction, sender_type, sender_user_id, type, body, status, mentions) VALUES (?, 'out', 'system', ?, 'note', ?, 'sent', ?)"
  ).run(conv.id, req.user.id, text, JSON.stringify(mentioned));
  emit('message_created', { conversation_id: conv.id });
  emit('conversation_updated', { conversation_id: conv.id });
  res.json(await db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
});

// ---------- Canned replies (snippets) ----------
router.get('/canned-replies', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM canned_replies ORDER BY shortcut').all());
});

router.post('/canned-replies', requireAdmin, async (req, res) => {
  const { shortcut, title, body } = req.body || {};
  const slug = String(shortcut || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '');
  if (!slug || !body) return res.status(400).json({ error: 'shortcut and body are required' });
  try {
    const info = await db.prepare('INSERT INTO canned_replies (shortcut, title, body) VALUES (?, ?, ?)').run(slug, title || null, body);
    res.json(await db.prepare('SELECT * FROM canned_replies WHERE id = ?').get(info.lastInsertRowid));
  } catch {
    res.status(400).json({ error: 'That shortcut is already in use' });
  }
});

router.patch('/canned-replies/:id', requireAdmin, async (req, res) => {
  const row = await db.prepare('SELECT * FROM canned_replies WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Snippet not found' });
  const { title, body } = req.body || {};
  await db.prepare('UPDATE canned_replies SET title = ?, body = ? WHERE id = ?').run(title ?? row.title, body ?? row.body, row.id);
  res.json({ ok: true });
});

router.delete('/canned-replies/:id', requireAdmin, async (req, res) => {
  await db.prepare('DELETE FROM canned_replies WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Send an approved template to this conversation's contact — the one kind of
// message WhatsApp allows regardless of the 24-hour session window, so this
// is how an agent reopens a conversation that's gone quiet.
router.post('/conversations/:id/send-template', async (req, res) => {
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  const template = await db.prepare('SELECT * FROM templates WHERE id = ?').get(req.body?.template_id);
  if (!template) return res.status(400).json({ error: 'A valid template_id is required' });
  const contact = await db.prepare('SELECT * FROM contacts WHERE id = ?').get(conv.contact_id);
  const variables = Array.isArray(req.body?.variables) ? req.body.variables : [];
  try {
    const params = buildTemplateParams(template, contact, variables);
    const waMessageId = await sendTemplate(contact.wa_id, template, params, { headerImageUrl: template.header_image_url || null });
    const renderedBody = renderTemplateBody(template.body, contact, variables.map((v) => renderTemplateBody(v, contact)));
    const info = await db.prepare(
      "INSERT INTO messages (conversation_id, direction, sender_type, sender_user_id, type, body, wa_message_id, status, media_url, buttons) VALUES (?, 'out', 'agent', ?, 'template', ?, ?, 'sent', ?, ?)"
    ).run(conv.id, req.user.id, renderedBody, waMessageId, template.header_image_url || null, template.buttons || '[]');
    await db.prepare(
      'UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = ?, ai_enabled = 0, assigned_user_id = COALESCE(assigned_user_id, ?) WHERE id = ?'
    ).run(`📄 ${renderedBody}`.slice(0, 120), req.user.id, conv.id);
    await recordResponse(conv.id);
    if (conv.ai_enabled) await addSystemNote(conv.id, `${req.user.name} took over from AI`);
    emit('message_created', { conversation_id: conv.id });
    emit('conversation_updated', { conversation_id: conv.id });
    res.json(await db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    res.status(502).json({ error: `Send failed: ${err.message}` });
  }
});

router.patch('/conversations/:id', async (req, res) => {
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  const { status, assigned_user_id, ai_enabled, ai_agent_id } = req.body || {};
  if (status && ['open', 'pending', 'resolved'].includes(status)) {
    // Resolving stamps resolved_at (for resolution-time reporting) and stops
    // any running SLA clock; reopening clears the stamp.
    if (status === 'resolved') {
      await db.prepare('UPDATE conversations SET status = ?, resolved_at = CURRENT_TIMESTAMP, awaiting_since = NULL WHERE id = ?').run(status, conv.id);
    } else {
      await db.prepare('UPDATE conversations SET status = ?, resolved_at = NULL WHERE id = ?').run(status, conv.id);
    }
    await addSystemNote(conv.id, `Marked as ${status} by ${req.user.name}`);
    // Fire the satisfaction survey on resolution (if enabled and reachable).
    if (status === 'resolved') await maybeSendSurvey(conv.id).catch((err) => console.error('CSAT send failed:', err.message));
  }
  if (assigned_user_id !== undefined) {
    // Offline agents can't assign conversations (Away can — they're present).
    const me = await db.prepare('SELECT status FROM users WHERE id = ?').get(req.user.id);
    if (me?.status === 'offline') return res.status(403).json({ error: "You're offline — go online or away to assign conversations." });
    await assignConversation(conv.id, assigned_user_id || null, { by: req.user.name });
  }
  if (ai_agent_id !== undefined || ai_enabled !== undefined) {
    const agentId = ai_agent_id !== undefined ? ai_agent_id : conv.ai_agent_id;
    const enabled = ai_enabled !== undefined ? (ai_enabled ? 1 : 0) : conv.ai_enabled;
    await db.prepare('UPDATE conversations SET ai_enabled = ?, ai_agent_id = ? WHERE id = ?').run(enabled && agentId ? 1 : 0, agentId || null, conv.id);
    if (enabled && agentId) {
      const agent = await db.prepare('SELECT name FROM ai_agents WHERE id = ?').get(agentId);
      await addSystemNote(conv.id, `🤖 ${agent?.name || 'AI agent'} enabled by ${req.user.name}`);
    }
  }
  emit('conversation_updated', { conversation_id: conv.id });
  res.json({ ok: true });
});

// Open the contact's conversation (reusing the single existing thread so past
// history is visible; reopening it if it was resolved).
router.post('/conversations', async (req, res) => {
  const contact = await db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.body?.contact_id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const { conv, created } = await getOrCreateConversation(contact.id, { assignedUserId: req.user.id });
  if (!created && conv.status === 'resolved') {
    await db.prepare("UPDATE conversations SET status = 'open', assigned_user_id = COALESCE(assigned_user_id, ?) WHERE id = ?").run(req.user.id, conv.id);
  }
  const fresh = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id);
  emit('conversation_updated', { conversation_id: conv.id });
  res.json(fresh);
});

// ---------- Templates ----------
router.get('/templates', async (req, res) => {
  res.json((await db.prepare('SELECT * FROM templates ORDER BY id DESC').all())
    .map((t) => ({ ...t, buttons: JSON.parse(t.buttons || '[]') })));
});

// Up to 3 buttons: quick replies ({type:'QUICK_REPLY', text}) and links
// ({type:'URL', text, url}), mirroring Meta's template button model.
function validateButtons(buttons) {
  if (buttons === undefined) return { ok: true, value: '[]' };
  if (!Array.isArray(buttons) || buttons.length > 3) return { ok: false, error: 'buttons must be an array of at most 3' };
  const clean = [];
  for (const b of buttons) {
    const text = String(b?.text || '').trim().slice(0, 25);
    if (!text) return { ok: false, error: 'Every button needs text' };
    if (b.type === 'URL') {
      const url = String(b.url || '').trim();
      if (!/^https?:\/\//.test(url)) return { ok: false, error: `Button "${text}" needs a valid http(s) URL` };
      clean.push({ type: 'URL', text, url });
    } else {
      clean.push({ type: 'QUICK_REPLY', text });
    }
  }
  return { ok: true, value: JSON.stringify(clean) };
}

router.post('/templates', async (req, res) => {
  const { name, language, category, body, header_image_url, buttons } = req.body || {};
  if (!name || !body) return res.status(400).json({ error: 'name and body are required' });
  const btn = validateButtons(buttons);
  if (!btn.ok) return res.status(400).json({ error: btn.error });
  if (header_image_url && !/^https?:\/\//.test(header_image_url)) {
    return res.status(400).json({ error: 'header_image_url must be a public http(s) URL' });
  }
  try {
    const info = await db.prepare(
      'INSERT INTO templates (name, language, category, body, param_map, header_image_url, buttons) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(String(name).toLowerCase().replace(/\s+/g, '_'), language || 'en', category || 'MARKETING', body,
      JSON.stringify(computeParamMap(body)), header_image_url || null, btn.value);
    res.json(await db.prepare('SELECT * FROM templates WHERE id = ?').get(info.lastInsertRowid));
  } catch {
    res.status(400).json({ error: 'A template with that name already exists' });
  }
});

// Pull the template library from Meta's Business Management API.
router.post('/templates/sync', requireAdmin, async (req, res) => {
  try {
    const count = await pullTemplatesFromMeta();
    res.json({ ok: true, count });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Submit a local template to Meta for approval.
router.post('/templates/:id/submit', requireAdmin, async (req, res) => {
  const template = await db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).json({ error: 'Template not found' });
  try {
    const out = await pushTemplateToMeta(template);
    res.json({ ok: true, status: out.status || 'PENDING' });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.delete('/templates/:id', requireAdmin, async (req, res) => {
  const used = (await db.prepare('SELECT COUNT(*) AS c FROM broadcasts WHERE template_id = ?').get(req.params.id)).c;
  if (used) return res.status(400).json({ error: 'Template is used by existing broadcasts' });
  await db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Broadcasts ----------
router.get('/broadcasts', async (req, res) => {
  const rows = await db.prepare(`
    SELECT b.*, t.name AS template_name, u.name AS created_by_name
    FROM broadcasts b JOIN templates t ON t.id = b.template_id
    LEFT JOIN users u ON u.id = b.created_by
    ORDER BY b.id DESC
  `).all();
  res.json(await Promise.all(rows.map(async (b) => ({ ...b, stats: await broadcastStats(b.id) }))));
});

router.post('/broadcasts', async (req, res) => {
  const { name, template_id, variables, audience_tag, scheduled_at, send_now, header_image_url } = req.body || {};
  const template = await db.prepare('SELECT * FROM templates WHERE id = ?').get(template_id);
  if (!name || !template) return res.status(400).json({ error: 'name and a valid template_id are required' });
  if (header_image_url && !/^https?:\/\//.test(header_image_url)) {
    return res.status(400).json({ error: 'header_image_url must be a public http(s) URL' });
  }
  const status = send_now ? 'sending' : scheduled_at ? 'scheduled' : 'draft';
  const info = await db.prepare(
    'INSERT INTO broadcasts (name, template_id, variables, audience_tag, status, scheduled_at, created_by, header_image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(name, template.id, JSON.stringify(variables || []), audience_tag || null, status, scheduled_at || null, req.user.id, header_image_url || null);
  const id = info.lastInsertRowid;
  if (send_now) {
    const run = startBroadcast(id);
    if (SERVERLESS) await run; // background work dies with the response on serverless
  }
  res.json(await db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id));
});

router.get('/broadcasts/:id/audience-preview', async (req, res) => {
  const audience = await audienceForBroadcast({ audience_tag: req.query.tag || null });
  res.json({ count: audience.length });
});

router.post('/broadcasts/:id/send', async (req, res) => {
  const b = await db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Broadcast not found' });
  if (['completed', 'cancelled'].includes(b.status)) return res.status(400).json({ error: `Broadcast already ${b.status}` });
  const run = startBroadcast(b.id);
  if (SERVERLESS) await run;
  res.json({ ok: true });
});

router.post('/broadcasts/:id/cancel', async (req, res) => {
  await db.prepare("UPDATE broadcasts SET status = 'cancelled' WHERE id = ? AND status IN ('draft','scheduled','sending')").run(req.params.id);
  emit('broadcast_progress', { broadcast_id: Number(req.params.id) });
  res.json({ ok: true });
});

// ---------- AI agents ----------
router.get('/ai-agents', async (req, res) => {
  res.json((await db.prepare('SELECT * FROM ai_agents ORDER BY id').all())
    .map((a) => ({ ...a, handoff_keywords: JSON.parse(a.handoff_keywords), skills: JSON.parse(a.skills || '[]') })));
});

router.post('/ai-agents', requireAdmin, async (req, res) => {
  const { name, system_prompt, model, handoff_keywords, auto_assign_new, skills } = req.body || {};
  if (!name || !system_prompt) return res.status(400).json({ error: 'name and system_prompt are required' });
  const info = await db.prepare(
    'INSERT INTO ai_agents (name, system_prompt, model, handoff_keywords, auto_assign_new, skills) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, system_prompt, model || 'claude-haiku-4-5-20251001',
    JSON.stringify(Array.isArray(handoff_keywords) ? handoff_keywords : ['human', 'agent']), auto_assign_new ? 1 : 0,
    JSON.stringify(Array.isArray(skills) ? skills : []));
  res.json(await db.prepare('SELECT * FROM ai_agents WHERE id = ?').get(info.lastInsertRowid));
});

router.patch('/ai-agents/:id', requireAdmin, async (req, res) => {
  const agent = await db.prepare('SELECT * FROM ai_agents WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'AI agent not found' });
  const { name, system_prompt, model, handoff_keywords, is_active, auto_assign_new, skills } = req.body || {};
  await db.prepare(
    'UPDATE ai_agents SET name = ?, system_prompt = ?, model = ?, handoff_keywords = ?, is_active = ?, auto_assign_new = ?, skills = ? WHERE id = ?'
  ).run(
    name ?? agent.name,
    system_prompt ?? agent.system_prompt,
    model ?? agent.model,
    Array.isArray(handoff_keywords) ? JSON.stringify(handoff_keywords) : agent.handoff_keywords,
    is_active === undefined ? agent.is_active : (is_active ? 1 : 0),
    auto_assign_new === undefined ? agent.auto_assign_new : (auto_assign_new ? 1 : 0),
    Array.isArray(skills) ? JSON.stringify(skills) : agent.skills,
    agent.id
  );
  res.json({ ok: true });
});

// ---------- Settings ----------
router.get('/settings', requireAdmin, async (req, res) => {
  res.json({
    sandbox_mode: (await getSetting('sandbox_mode', '1')) === '1',
    wa_phone_number_id: await getSetting('wa_phone_number_id', ''),
    wa_waba_id: await getSetting('wa_waba_id', ''),
    wa_access_token_set: Boolean(await getSetting('wa_access_token')),
    wa_verify_token: await getSetting('wa_verify_token', ''),
    anthropic_api_key_set: Boolean((await getSetting('anthropic_api_key')) || process.env.ANTHROPIC_API_KEY),
    data_webhook_url: await getSetting('data_webhook_url', ''),
    data_webhook_secret_set: Boolean(await getSetting('data_webhook_secret')),
  });
});

router.put('/settings', requireAdmin, async (req, res) => {
  const { sandbox_mode, wa_phone_number_id, wa_waba_id, wa_access_token, wa_verify_token, anthropic_api_key, data_webhook_url, data_webhook_secret } = req.body || {};
  if (sandbox_mode !== undefined) await setSetting('sandbox_mode', sandbox_mode ? '1' : '0');
  if (wa_phone_number_id !== undefined) await setSetting('wa_phone_number_id', wa_phone_number_id);
  if (wa_waba_id !== undefined) await setSetting('wa_waba_id', wa_waba_id);
  if (wa_access_token) await setSetting('wa_access_token', wa_access_token);
  if (wa_verify_token !== undefined) await setSetting('wa_verify_token', wa_verify_token);
  if (anthropic_api_key) await setSetting('anthropic_api_key', anthropic_api_key);
  if (data_webhook_url !== undefined) {
    if (data_webhook_url && !/^https?:\/\//.test(data_webhook_url)) return res.status(400).json({ error: 'Data webhook URL must be an http(s) URL' });
    await setSetting('data_webhook_url', data_webhook_url);
  }
  if (data_webhook_secret !== undefined) await setSetting('data_webhook_secret', data_webhook_secret);
  res.json({ ok: true });
});

// ---------- Business hours & holidays ----------
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateSchedule(schedule) {
  if (schedule === undefined) return { ok: true };
  if (typeof schedule !== 'object' || schedule === null) return { ok: false, error: 'schedule must be an object' };
  for (const day of Object.keys(schedule)) {
    if (!DAY_KEYS.includes(day)) return { ok: false, error: `Unknown day "${day}"` };
    const slot = schedule[day];
    if (slot === null) continue;
    if (!slot || !TIME_RE.test(slot.open) || !TIME_RE.test(slot.close)) {
      return { ok: false, error: `${day}: open/close must be HH:MM (24h)` };
    }
  }
  return { ok: true };
}

router.get('/business-hours', async (req, res) => {
  const config = await getBusinessHoursConfig();
  const nextOpenLabel = await computeNextOpenLabel(config);
  res.json({ ...config, nextOpenLabel, previewMessage: renderAwayMessage(config.awayMessage, { name: 'Alex', reason: config.enabled ? undefined : 'outside our business hours', nextOpenLabel }) });
});

router.put('/business-hours', requireAdmin, async (req, res) => {
  const { enabled, timezone, schedule, awayMessage } = req.body || {};
  if (timezone !== undefined) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
    catch { return res.status(400).json({ error: `"${timezone}" is not a recognized timezone (use an IANA name like America/New_York)` }); }
  }
  const v = validateSchedule(schedule);
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (awayMessage !== undefined && !String(awayMessage).trim()) return res.status(400).json({ error: 'Away message cannot be empty' });
  await setBusinessHoursConfig({ enabled, timezone, schedule, awayMessage });
  res.json({ ok: true });
});

router.get('/holidays', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM holidays ORDER BY date').all());
});

router.post('/holidays', requireAdmin, async (req, res) => {
  const { date, name } = req.body || {};
  if (!DATE_RE.test(date || '')) return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });
  try {
    const info = await db.prepare('INSERT INTO holidays (date, name) VALUES (?, ?)').run(date, name || null);
    res.json(await db.prepare('SELECT * FROM holidays WHERE id = ?').get(info.lastInsertRowid));
  } catch {
    res.status(400).json({ error: 'A holiday is already set for that date' });
  }
});

router.delete('/holidays/:id', requireAdmin, async (req, res) => {
  await db.prepare('DELETE FROM holidays WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Opt-out / opt-in compliance ----------
router.get('/opt-out-settings', requireAdmin, async (req, res) => {
  res.json(await getOptOutConfig());
});

router.put('/opt-out-settings', requireAdmin, async (req, res) => {
  const { optOutKeywords, optOutMessage, optInKeywords, optInMessage } = req.body || {};
  const cleanList = (v) => Array.isArray(v) ? v.map((k) => String(k).trim()).filter(Boolean) : undefined;
  if (optOutMessage !== undefined && !String(optOutMessage).trim()) return res.status(400).json({ error: 'Opt-out message cannot be empty' });
  if (optInMessage !== undefined && !String(optInMessage).trim()) return res.status(400).json({ error: 'Opt-in message cannot be empty' });
  await setOptOutConfig({
    optOutKeywords: cleanList(optOutKeywords), optOutMessage,
    optInKeywords: cleanList(optInKeywords), optInMessage,
  });
  res.json({ ok: true });
});

// ---------- SLA settings ----------
router.get('/sla-settings', requireAdmin, async (req, res) => {
  res.json(await getSlaConfig());
});

router.put('/sla-settings', requireAdmin, async (req, res) => {
  const { enabled, responseMinutes } = req.body || {};
  if (responseMinutes !== undefined && (!Number.isFinite(Number(responseMinutes)) || Number(responseMinutes) < 1)) {
    return res.status(400).json({ error: 'Response target must be at least 1 minute' });
  }
  await setSlaConfig({ enabled, responseMinutes });
  res.json({ ok: true });
});

// ---------- CSAT settings ----------
router.get('/csat-settings', requireAdmin, async (req, res) => {
  res.json(await getCsatConfig());
});

router.put('/csat-settings', requireAdmin, async (req, res) => {
  const { enabled, scale, message, thanksMessage } = req.body || {};
  if (scale !== undefined && (!Number.isInteger(Number(scale)) || Number(scale) < 2 || Number(scale) > 10)) {
    return res.status(400).json({ error: 'Scale must be a whole number between 2 and 10' });
  }
  if (message !== undefined && !String(message).trim()) return res.status(400).json({ error: 'Survey message cannot be empty' });
  await setCsatConfig({ enabled, scale, message, thanksMessage });
  res.json({ ok: true });
});

// ---------- Custom contact fields ----------
// Admin-defined field definitions; values live in contacts.attributes.
async function getContactFields() {
  try { return JSON.parse(await getSetting('contact_fields', '') || '[]'); } catch { return []; }
}

router.get('/contact-fields', async (req, res) => {
  res.json(await getContactFields());
});

router.put('/contact-fields', requireAdmin, async (req, res) => {
  const fields = Array.isArray(req.body?.fields) ? req.body.fields : [];
  const clean = [];
  const seen = new Set();
  for (const f of fields) {
    const label = String(f?.label || '').trim();
    if (!label) continue;
    const key = String(f?.key || label).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const type = ['text', 'number', 'date', 'url'].includes(f?.type) ? f.type : 'text';
    clean.push({ key, label, type });
  }
  await setSetting('contact_fields', JSON.stringify(clean));
  res.json({ ok: true, fields: clean });
});

// ---------- Analytics ----------
router.get('/analytics', async (req, res) => {
  const count = async (sql) => (await db.prepare(sql).get()).c;
  const counters = {
    contacts: await count('SELECT COUNT(*) AS c FROM contacts'),
    conversations_open: await count("SELECT COUNT(*) AS c FROM conversations WHERE status = 'open'"),
    messages_in_24h: await count(`SELECT COUNT(*) AS c FROM messages WHERE direction = 'in' AND created_at > ${SQL.ago('1 day')}`),
    messages_out_24h: await count(`SELECT COUNT(*) AS c FROM messages WHERE direction = 'out' AND sender_type != 'system' AND created_at > ${SQL.ago('1 day')}`),
    ai_replies_24h: await count(`SELECT COUNT(*) AS c FROM messages WHERE sender_type = 'ai' AND created_at > ${SQL.ago('1 day')}`),
    broadcasts_completed: await count("SELECT COUNT(*) AS c FROM broadcasts WHERE status = 'completed'"),
  };
  const perAgent = await db.prepare(`
    SELECT u.name, COUNT(cv.id) AS open_chats
    FROM users u LEFT JOIN conversations cv ON cv.assigned_user_id = u.id AND cv.status = 'open'
    WHERE u.is_active = 1 GROUP BY u.id, u.name ORDER BY u.id
  `).all();
  const daily = await db.prepare(`
    SELECT ${SQL.day('created_at')} AS day,
           SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS inbound,
           SUM(CASE WHEN direction = 'out' AND sender_type != 'system' THEN 1 ELSE 0 END) AS outbound
    FROM messages WHERE created_at > ${SQL.ago('14 day')}
    GROUP BY ${SQL.day('created_at')} ORDER BY day
  `).all();

  // SLA metrics: average first-response time, % of responded conversations
  // within target, resolution time, and currently-breaching open chats.
  const slaConfig = await getSlaConfig();
  const frtRow = await db.prepare('SELECT AVG(first_response_seconds) AS avg_secs, COUNT(*) AS c FROM conversations WHERE first_response_seconds IS NOT NULL').get();
  const withinRow = await db.prepare('SELECT COUNT(*) AS c FROM conversations WHERE first_response_seconds IS NOT NULL AND first_response_seconds <= ?').get(slaConfig.responseMinutes * 60);
  const resRow = await db.prepare(`
    SELECT AVG((${SQL.epoch('resolved_at')} - ${SQL.epoch('created_at')})) AS avg_secs, COUNT(*) AS c
    FROM conversations WHERE resolved_at IS NOT NULL
  `).get();
  // Currently open conversations past their response deadline.
  const openBreaches = slaConfig.enabled
    ? await count(`SELECT COUNT(*) AS c FROM conversations WHERE awaiting_since IS NOT NULL AND awaiting_since < ${SQL.ago(slaConfig.responseMinutes + ' minute')}`)
    : 0;
  const responded = frtRow.c || 0;
  const sla = {
    enabled: slaConfig.enabled,
    target_minutes: slaConfig.responseMinutes,
    avg_first_response_seconds: frtRow.avg_secs != null ? Math.round(frtRow.avg_secs) : null,
    within_target_pct: responded ? Math.round((withinRow.c / responded) * 100) : null,
    responded_count: responded,
    avg_resolution_seconds: resRow.avg_secs != null ? Math.round(resRow.avg_secs) : null,
    resolved_count: resRow.c || 0,
    open_breaches: openBreaches,
  };

  // CSAT: average score, response count, and rating distribution.
  const csatConfig = await getCsatConfig();
  const csatAgg = await db.prepare('SELECT AVG(csat_score) AS avg, COUNT(*) AS c FROM conversations WHERE csat_score IS NOT NULL').get();
  const dist = await db.prepare('SELECT csat_score AS score, COUNT(*) AS c FROM conversations WHERE csat_score IS NOT NULL GROUP BY csat_score ORDER BY csat_score').all();
  const surveysSent = await count('SELECT COUNT(*) AS c FROM conversations WHERE awaiting_csat = 1 OR csat_score IS NOT NULL');
  const csat = {
    enabled: csatConfig.enabled,
    scale: csatConfig.scale,
    avg_score: csatAgg.avg != null ? Math.round(csatAgg.avg * 100) / 100 : null,
    responses: csatAgg.c || 0,
    surveys_sent: surveysSent,
    distribution: dist,
  };
  res.json({ counters, perAgent, daily, sla, csat });
});

// ---------- Sandbox simulator ----------
// Emulates a customer sending a WhatsApp message (sandbox mode only).
router.post('/simulator/inbound', async (req, res) => {
  if (!(await isSandbox())) return res.status(400).json({ error: 'Simulator is only available in sandbox mode' });
  const { phone, name, text, media_url, media_type } = req.body || {};
  if (!phone || (!text && !media_url)) return res.status(400).json({ error: 'phone and text (or an attachment) are required' });
  const result = await handleInboundMessage({
    waId: phone,
    name,
    text: String(text || ''),
    waMessageId: 'wamid.SIM' + Date.now().toString(36),
    type: media_url ? (media_type === 'audio' ? 'audio' : 'image') : 'text',
    mediaUrl: media_url || null,
  });
  res.json({ ok: true, conversation_id: result.conversation.id });
});

// ---------- Knowledge base (AI training) ----------
// The knowledge base is what the AI "trains" on: reviewable snippets that get
// retrieved and injected into agent replies. Admin-only — it shapes automated
// answers, so ingestion and approval are restricted.
router.get('/knowledge', requireAdmin, async (req, res) => {
  const status = req.query.status;
  const rows = ['pending', 'active', 'archived'].includes(status)
    ? await db.prepare('SELECT id, source_type, source_ref, title, content, status, created_at FROM knowledge WHERE status = ? ORDER BY id DESC').all(status)
    : await db.prepare('SELECT id, source_type, source_ref, title, content, status, created_at FROM knowledge ORDER BY id DESC').all();
  const counts = await db.prepare('SELECT status, COUNT(*) AS c FROM knowledge GROUP BY status').all();
  res.json({ entries: rows, counts: Object.fromEntries(counts.map((r) => [r.status, r.c])) });
});

// Manually add a single entry (question/answer or a note).
router.post('/knowledge', requireAdmin, async (req, res) => {
  const title = String(req.body?.title || '').trim() || null;
  const content = String(req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Content is required' });
  const result = await ingestText({ text: content, title, sourceType: 'manual', createdBy: req.user.id });
  res.json({ ok: true, ...result });
});

// Upload a document (raw text/markdown/csv body) and chunk it into entries.
router.post('/knowledge/upload', requireAdmin, express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
  if (!req.body?.length) return res.status(400).json({ error: 'No file content received' });
  const mime = (req.headers['content-type'] || '').split(';')[0].trim();
  const filename = req.headers['x-filename'] ? decodeURIComponent(req.headers['x-filename']) : 'document';
  const text = req.body.toString('utf8');
  if (/[\x00-\x08]/.test(text.slice(0, 2000))) {
    return res.status(400).json({ error: 'This looks like a binary file (PDF/Word). Please upload plain text, Markdown, or CSV — or paste the text directly.' });
  }
  try {
    const result = mime === 'text/csv' || filename.toLowerCase().endsWith('.csv')
      ? await ingestCsv({ text, sourceRef: filename, createdBy: req.user.id })
      : await ingestText({ text, title: filename, sourceRef: filename, createdBy: req.user.id });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mine resolved conversations into candidate Q&A entries.
router.post('/knowledge/mine', requireAdmin, async (req, res) => {
  try {
    const result = await mineConversations({ createdBy: req.user.id });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch a URL (help-center article / FAQ page) and ingest its text.
router.post('/knowledge/url', requireAdmin, async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Enter a valid http(s) URL' });
  try {
    const result = await ingestUrl({ url, createdBy: req.user.id });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Approve / edit / archive an entry.
router.patch('/knowledge/:id', requireAdmin, async (req, res) => {
  const entry = await db.prepare('SELECT * FROM knowledge WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  const sets = [];
  const args = [];
  if (req.body?.status && ['pending', 'active', 'archived'].includes(req.body.status)) { sets.push('status = ?'); args.push(req.body.status); }
  if (req.body?.title !== undefined) { sets.push('title = ?'); args.push(String(req.body.title).trim() || null); }
  if (req.body?.content !== undefined) {
    const content = String(req.body.content).trim();
    if (!content) return res.status(400).json({ error: 'Content cannot be empty' });
    sets.push('content = ?'); args.push(content);
    // Editing the text invalidates the stored embedding — clear its signature
    // so retrieval re-embeds it lazily on next use.
    sets.push('embed_sig = ?'); args.push('stale');
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  args.push(req.params.id);
  await db.prepare(`UPDATE knowledge SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  res.json({ ok: true });
});

router.delete('/knowledge/:id', requireAdmin, async (req, res) => {
  await db.prepare('DELETE FROM knowledge WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Try a query against the active knowledge base (admin preview of retrieval).
router.post('/knowledge/search', requireAdmin, async (req, res) => {
  const q = String(req.body?.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Enter a question to test' });
  const hits = await retrieve(q, 5, 0.15);
  res.json({ hits: hits.map((h) => ({ id: h.id, title: h.title, content: h.content, score: Math.round(h.score * 100) / 100 })) });
});

// Embeddings provider settings.
router.get('/knowledge-settings', requireAdmin, async (req, res) => {
  res.json({
    provider: await getSetting('embeddings_provider', 'local'),
    has_key: !!(await getSetting('embeddings_api_key')),
  });
});
router.put('/knowledge-settings', requireAdmin, async (req, res) => {
  const provider = ['local', 'voyage', 'openai'].includes(req.body?.provider) ? req.body.provider : 'local';
  await setSetting('embeddings_provider', provider);
  if (req.body?.api_key !== undefined) await setSetting('embeddings_api_key', String(req.body.api_key || '').trim() || null);
  res.json({ ok: true, provider });
});

export default router;
