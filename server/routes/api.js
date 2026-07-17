import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db, { getSetting, setSetting } from '../db.js';
import { signToken, requireAuth, requireAdmin } from '../auth.js';
import { emit, sseHandler } from '../services/events.js';
import { sendText, isSandbox } from '../services/whatsapp.js';
import { assignConversation, addSystemNote } from '../services/assignment.js';
import { startBroadcast, broadcastStats, audienceForBroadcast } from '../services/broadcaster.js';
import { handleInboundMessage } from '../services/inbound.js';

const router = Router();

// ---------- Auth ----------
router.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase().trim());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!user.is_active) return res.status(401).json({ error: 'Account disabled' });
  res.json({
    token: signToken(user),
    user: { id: user.id, name: user.name, email: user.email, role: user.role, available: user.available },
  });
});

router.use(requireAuth);

router.get('/me', (req, res) => res.json(req.user));

router.patch('/me/availability', (req, res) => {
  const available = req.body.available ? 1 : 0;
  db.prepare('UPDATE users SET available = ? WHERE id = ?').run(available, req.user.id);
  res.json({ ok: true, available });
});

// ---------- Events (SSE) ----------
router.get('/events', sseHandler);

// ---------- Team (users) ----------
router.get('/users', (req, res) => {
  res.json(db.prepare('SELECT id, name, email, role, is_active, available, created_at FROM users ORDER BY id').all());
});

router.post('/users', requireAdmin, (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });
  try {
    const info = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(name, String(email).toLowerCase().trim(), bcrypt.hashSync(password, 10), role === 'admin' ? 'admin' : 'agent');
    res.json(db.prepare('SELECT id, name, email, role, is_active, available FROM users WHERE id = ?').get(info.lastInsertRowid));
  } catch {
    res.status(400).json({ error: 'Email already in use' });
  }
});

router.patch('/users/:id', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { name, role, is_active, available, password } = req.body || {};
  db.prepare('UPDATE users SET name = ?, role = ?, is_active = ?, available = ? WHERE id = ?').run(
    name ?? user.name,
    role === 'admin' || role === 'agent' ? role : user.role,
    is_active === undefined ? user.is_active : (is_active ? 1 : 0),
    available === undefined ? user.available : (available ? 1 : 0),
    user.id
  );
  if (password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), user.id);
  res.json({ ok: true });
});

// ---------- Contacts ----------
router.get('/contacts', (req, res) => {
  const rows = db.prepare('SELECT * FROM contacts ORDER BY COALESCE(last_message_at, created_at) DESC').all();
  res.json(rows.map((c) => ({ ...c, tags: JSON.parse(c.tags), attributes: JSON.parse(c.attributes) })));
});

router.post('/contacts', (req, res) => {
  const { wa_id, name, tags } = req.body || {};
  const phone = String(wa_id || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ error: 'A valid phone number (wa_id) is required' });
  try {
    const info = db.prepare('INSERT INTO contacts (wa_id, name, tags) VALUES (?, ?, ?)')
      .run(phone, name || null, JSON.stringify(Array.isArray(tags) ? tags : []));
    emit('contact_created', { contact_id: info.lastInsertRowid });
    res.json(db.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid));
  } catch {
    res.status(400).json({ error: 'A contact with that phone number already exists' });
  }
});

router.patch('/contacts/:id', (req, res) => {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const { name, tags, opted_out } = req.body || {};
  db.prepare('UPDATE contacts SET name = ?, tags = ?, opted_out = ? WHERE id = ?').run(
    name ?? contact.name,
    Array.isArray(tags) ? JSON.stringify(tags) : contact.tags,
    opted_out === undefined ? contact.opted_out : (opted_out ? 1 : 0),
    contact.id
  );
  res.json({ ok: true });
});

// ---------- Conversations & messages ----------
router.get('/conversations', (req, res) => {
  const { filter, status } = req.query;
  let where = '1=1';
  const params = [];
  if (status && ['open', 'pending', 'resolved'].includes(status)) { where += ' AND cv.status = ?'; params.push(status); }
  if (filter === 'mine') { where += ' AND cv.assigned_user_id = ?'; params.push(req.user.id); }
  if (filter === 'unassigned') where += ' AND cv.assigned_user_id IS NULL AND cv.ai_enabled = 0';
  if (filter === 'ai') where += ' AND cv.ai_enabled = 1';
  const rows = db.prepare(`
    SELECT cv.*, c.name AS contact_name, c.wa_id, u.name AS assigned_name, a.name AS ai_agent_name
    FROM conversations cv
    JOIN contacts c ON c.id = cv.contact_id
    LEFT JOIN users u ON u.id = cv.assigned_user_id
    LEFT JOIN ai_agents a ON a.id = cv.ai_agent_id
    WHERE ${where}
    ORDER BY cv.last_message_at DESC NULLS LAST
  `).all(...params);
  res.json(rows);
});

router.get('/conversations/:id', (req, res) => {
  const conv = db.prepare(`
    SELECT cv.*, c.name AS contact_name, c.wa_id, c.tags AS contact_tags, u.name AS assigned_name, a.name AS ai_agent_name
    FROM conversations cv
    JOIN contacts c ON c.id = cv.contact_id
    LEFT JOIN users u ON u.id = cv.assigned_user_id
    LEFT JOIN ai_agents a ON a.id = cv.ai_agent_id
    WHERE cv.id = ?
  `).get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ ...conv, contact_tags: JSON.parse(conv.contact_tags) });
});

router.get('/conversations/:id/messages', (req, res) => {
  const rows = db.prepare(`
    SELECT m.*, u.name AS sender_name, a.name AS ai_agent_name
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_user_id
    LEFT JOIN ai_agents a ON a.id = m.ai_agent_id
    WHERE m.conversation_id = ? ORDER BY m.id
  `).all(req.params.id);
  db.prepare('UPDATE conversations SET unread_count = 0 WHERE id = ?').run(req.params.id);
  res.json(rows);
});

router.post('/conversations/:id/messages', async (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Message text is required' });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(conv.contact_id);
  try {
    const waMessageId = await sendText(contact.wa_id, text);
    const info = db.prepare(
      "INSERT INTO messages (conversation_id, direction, sender_type, sender_user_id, type, body, wa_message_id, status) VALUES (?, 'out', 'agent', ?, 'text', ?, ?, 'sent')"
    ).run(conv.id, req.user.id, text, waMessageId);
    // A human replying takes the conversation over from the AI.
    db.prepare(
      "UPDATE conversations SET last_message_at = datetime('now'), last_message_preview = ?, ai_enabled = 0, assigned_user_id = COALESCE(assigned_user_id, ?) WHERE id = ?"
    ).run(text.slice(0, 120), req.user.id, conv.id);
    if (conv.ai_enabled) addSystemNote(conv.id, `${req.user.name} took over from AI`);
    emit('message_created', { conversation_id: conv.id });
    emit('conversation_updated', { conversation_id: conv.id });
    res.json(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    res.status(502).json({ error: `Send failed: ${err.message}` });
  }
});

router.patch('/conversations/:id', (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  const { status, assigned_user_id, ai_enabled, ai_agent_id } = req.body || {};
  if (status && ['open', 'pending', 'resolved'].includes(status)) {
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run(status, conv.id);
    addSystemNote(conv.id, `Marked as ${status} by ${req.user.name}`);
  }
  if (assigned_user_id !== undefined) {
    assignConversation(conv.id, assigned_user_id || null, { by: req.user.name });
  }
  if (ai_agent_id !== undefined || ai_enabled !== undefined) {
    const agentId = ai_agent_id !== undefined ? ai_agent_id : conv.ai_agent_id;
    const enabled = ai_enabled !== undefined ? (ai_enabled ? 1 : 0) : conv.ai_enabled;
    db.prepare('UPDATE conversations SET ai_enabled = ?, ai_agent_id = ? WHERE id = ?').run(enabled && agentId ? 1 : 0, agentId || null, conv.id);
    if (enabled && agentId) {
      const agent = db.prepare('SELECT name FROM ai_agents WHERE id = ?').get(agentId);
      addSystemNote(conv.id, `🤖 ${agent?.name || 'AI agent'} enabled by ${req.user.name}`);
    }
  }
  emit('conversation_updated', { conversation_id: conv.id });
  res.json({ ok: true });
});

// Start a fresh outbound conversation with a contact.
router.post('/conversations', (req, res) => {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.body?.contact_id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  let conv = db.prepare("SELECT * FROM conversations WHERE contact_id = ? AND status != 'resolved' ORDER BY id DESC LIMIT 1").get(contact.id);
  if (!conv) {
    const info = db.prepare("INSERT INTO conversations (contact_id, status, assigned_user_id) VALUES (?, 'open', ?)").run(contact.id, req.user.id);
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
    emit('conversation_updated', { conversation_id: conv.id });
  }
  res.json(conv);
});

// ---------- Templates ----------
router.get('/templates', (req, res) => res.json(db.prepare('SELECT * FROM templates ORDER BY id DESC').all()));

router.post('/templates', (req, res) => {
  const { name, language, category, body } = req.body || {};
  if (!name || !body) return res.status(400).json({ error: 'name and body are required' });
  try {
    const info = db.prepare('INSERT INTO templates (name, language, category, body) VALUES (?, ?, ?, ?)')
      .run(String(name).toLowerCase().replace(/\s+/g, '_'), language || 'en', category || 'MARKETING', body);
    res.json(db.prepare('SELECT * FROM templates WHERE id = ?').get(info.lastInsertRowid));
  } catch {
    res.status(400).json({ error: 'A template with that name already exists' });
  }
});

router.delete('/templates/:id', requireAdmin, (req, res) => {
  const used = db.prepare('SELECT COUNT(*) AS c FROM broadcasts WHERE template_id = ?').get(req.params.id).c;
  if (used) return res.status(400).json({ error: 'Template is used by existing broadcasts' });
  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Broadcasts ----------
router.get('/broadcasts', (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, t.name AS template_name, u.name AS created_by_name
    FROM broadcasts b JOIN templates t ON t.id = b.template_id
    LEFT JOIN users u ON u.id = b.created_by
    ORDER BY b.id DESC
  `).all();
  res.json(rows.map((b) => ({ ...b, stats: broadcastStats(b.id) })));
});

router.post('/broadcasts', (req, res) => {
  const { name, template_id, variables, audience_tag, scheduled_at, send_now } = req.body || {};
  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(template_id);
  if (!name || !template) return res.status(400).json({ error: 'name and a valid template_id are required' });
  const status = send_now ? 'sending' : scheduled_at ? 'scheduled' : 'draft';
  const info = db.prepare(
    'INSERT INTO broadcasts (name, template_id, variables, audience_tag, status, scheduled_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(name, template.id, JSON.stringify(variables || []), audience_tag || null, status, scheduled_at || null, req.user.id);
  const id = info.lastInsertRowid;
  if (send_now) startBroadcast(id);
  res.json(db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id));
});

router.get('/broadcasts/:id/audience-preview', (req, res) => {
  const audience = audienceForBroadcast({ audience_tag: req.query.tag || null });
  res.json({ count: audience.length });
});

router.post('/broadcasts/:id/send', (req, res) => {
  const b = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Broadcast not found' });
  if (['completed', 'cancelled'].includes(b.status)) return res.status(400).json({ error: `Broadcast already ${b.status}` });
  startBroadcast(b.id);
  res.json({ ok: true });
});

router.post('/broadcasts/:id/cancel', (req, res) => {
  db.prepare("UPDATE broadcasts SET status = 'cancelled' WHERE id = ? AND status IN ('draft','scheduled','sending')").run(req.params.id);
  emit('broadcast_progress', { broadcast_id: Number(req.params.id) });
  res.json({ ok: true });
});

// ---------- AI agents ----------
router.get('/ai-agents', (req, res) => {
  res.json(db.prepare('SELECT * FROM ai_agents ORDER BY id').all()
    .map((a) => ({ ...a, handoff_keywords: JSON.parse(a.handoff_keywords) })));
});

router.post('/ai-agents', requireAdmin, (req, res) => {
  const { name, system_prompt, model, handoff_keywords, auto_assign_new } = req.body || {};
  if (!name || !system_prompt) return res.status(400).json({ error: 'name and system_prompt are required' });
  const info = db.prepare(
    'INSERT INTO ai_agents (name, system_prompt, model, handoff_keywords, auto_assign_new) VALUES (?, ?, ?, ?, ?)'
  ).run(name, system_prompt, model || 'claude-haiku-4-5-20251001',
    JSON.stringify(Array.isArray(handoff_keywords) ? handoff_keywords : ['human', 'agent']), auto_assign_new ? 1 : 0);
  res.json(db.prepare('SELECT * FROM ai_agents WHERE id = ?').get(info.lastInsertRowid));
});

router.patch('/ai-agents/:id', requireAdmin, (req, res) => {
  const agent = db.prepare('SELECT * FROM ai_agents WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'AI agent not found' });
  const { name, system_prompt, model, handoff_keywords, is_active, auto_assign_new } = req.body || {};
  db.prepare(
    'UPDATE ai_agents SET name = ?, system_prompt = ?, model = ?, handoff_keywords = ?, is_active = ?, auto_assign_new = ? WHERE id = ?'
  ).run(
    name ?? agent.name,
    system_prompt ?? agent.system_prompt,
    model ?? agent.model,
    Array.isArray(handoff_keywords) ? JSON.stringify(handoff_keywords) : agent.handoff_keywords,
    is_active === undefined ? agent.is_active : (is_active ? 1 : 0),
    auto_assign_new === undefined ? agent.auto_assign_new : (auto_assign_new ? 1 : 0),
    agent.id
  );
  res.json({ ok: true });
});

// ---------- Settings ----------
router.get('/settings', requireAdmin, (req, res) => {
  res.json({
    sandbox_mode: getSetting('sandbox_mode', '1') === '1',
    wa_phone_number_id: getSetting('wa_phone_number_id', ''),
    wa_access_token_set: Boolean(getSetting('wa_access_token')),
    wa_verify_token: getSetting('wa_verify_token', ''),
    anthropic_api_key_set: Boolean(getSetting('anthropic_api_key') || process.env.ANTHROPIC_API_KEY),
  });
});

router.put('/settings', requireAdmin, (req, res) => {
  const { sandbox_mode, wa_phone_number_id, wa_access_token, wa_verify_token, anthropic_api_key } = req.body || {};
  if (sandbox_mode !== undefined) setSetting('sandbox_mode', sandbox_mode ? '1' : '0');
  if (wa_phone_number_id !== undefined) setSetting('wa_phone_number_id', wa_phone_number_id);
  if (wa_access_token) setSetting('wa_access_token', wa_access_token);
  if (wa_verify_token !== undefined) setSetting('wa_verify_token', wa_verify_token);
  if (anthropic_api_key) setSetting('anthropic_api_key', anthropic_api_key);
  res.json({ ok: true });
});

// ---------- Analytics ----------
router.get('/analytics', (req, res) => {
  const counters = {
    contacts: db.prepare('SELECT COUNT(*) AS c FROM contacts').get().c,
    conversations_open: db.prepare("SELECT COUNT(*) AS c FROM conversations WHERE status = 'open'").get().c,
    messages_in_24h: db.prepare("SELECT COUNT(*) AS c FROM messages WHERE direction = 'in' AND created_at > datetime('now','-1 day')").get().c,
    messages_out_24h: db.prepare("SELECT COUNT(*) AS c FROM messages WHERE direction = 'out' AND sender_type != 'system' AND created_at > datetime('now','-1 day')").get().c,
    ai_replies_24h: db.prepare("SELECT COUNT(*) AS c FROM messages WHERE sender_type = 'ai' AND created_at > datetime('now','-1 day')").get().c,
    broadcasts_completed: db.prepare("SELECT COUNT(*) AS c FROM broadcasts WHERE status = 'completed'").get().c,
  };
  const perAgent = db.prepare(`
    SELECT u.name, COUNT(cv.id) AS open_chats
    FROM users u LEFT JOIN conversations cv ON cv.assigned_user_id = u.id AND cv.status = 'open'
    WHERE u.is_active = 1 GROUP BY u.id ORDER BY u.id
  `).all();
  const daily = db.prepare(`
    SELECT date(created_at) AS day,
           SUM(direction = 'in') AS inbound,
           SUM(direction = 'out' AND sender_type != 'system') AS outbound
    FROM messages WHERE created_at > datetime('now', '-14 day')
    GROUP BY day ORDER BY day
  `).all();
  res.json({ counters, perAgent, daily });
});

// ---------- Sandbox simulator ----------
// Emulates a customer sending a WhatsApp message (sandbox mode only).
router.post('/simulator/inbound', async (req, res) => {
  if (!isSandbox()) return res.status(400).json({ error: 'Simulator is only available in sandbox mode' });
  const { phone, name, text } = req.body || {};
  if (!phone || !text) return res.status(400).json({ error: 'phone and text are required' });
  const result = await handleInboundMessage({
    waId: phone,
    name,
    text: String(text),
    waMessageId: 'wamid.SIM' + Date.now().toString(36),
  });
  res.json({ ok: true, conversation_id: result.conversation.id });
});

export default router;
