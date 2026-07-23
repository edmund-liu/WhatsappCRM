// Public web-chat channel — the embeddable widget's backend.
//
// A visitor gets an opaque session id, posts messages (which flow through the
// exact same inbound pipeline as WhatsApp, so routing/AI/SLA/CSAT/hours all
// apply), and long-polls for replies. No auth: these are public endpoints, so
// they're rate-limited and only ever expose the visitor's own conversation.
import { Router } from 'express';
import crypto from 'crypto';
import db from '../db.js';
import { handleInboundMessage } from '../services/inbound.js';

const router = Router();

// Tiny in-memory rate limiter (per IP): 30 messages / minute.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { n: 0, ts: now };
  if (now - rec.ts > 60000) { rec.n = 0; rec.ts = now; }
  rec.n++; hits.set(ip, rec);
  return rec.n > 30;
}

// Start (or resume) a visitor session. The returned id is the contact's wa_id
// on the webchat channel; the visitor keeps it in localStorage.
router.post('/session', async (req, res) => {
  let sessionId = String(req.body?.session_id || '').trim();
  if (!/^web_[a-f0-9]{24}$/.test(sessionId)) sessionId = 'web_' + crypto.randomBytes(12).toString('hex');
  const name = String(req.body?.name || '').trim().slice(0, 60) || null;
  const contact = await db.prepare('SELECT id FROM contacts WHERE wa_id = ?').get(sessionId);
  if (contact && name) await db.prepare('UPDATE contacts SET name = COALESCE(name, ?) WHERE id = ?').run(name, contact.id);
  res.json({ session_id: sessionId });
});

// Visitor sends a message.
router.post('/message', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ error: 'Too many messages, please slow down.' });
  const sessionId = String(req.body?.session_id || '').trim();
  const text = String(req.body?.text || '').trim().slice(0, 2000);
  if (!/^web_[a-f0-9]{24}$/.test(sessionId)) return res.status(400).json({ error: 'Invalid session' });
  if (!text) return res.status(400).json({ error: 'Message is required' });
  await handleInboundMessage({ waId: sessionId, name: req.body?.name || null, text, channel: 'webchat' });
  res.json({ ok: true });
});

// Visitor polls for new messages after `after` (a message id). Returns only
// their own conversation's customer-visible messages (no internal notes).
router.get('/poll', async (req, res) => {
  const sessionId = String(req.query.session_id || '').trim();
  const after = parseInt(req.query.after, 10) || 0;
  if (!/^web_[a-f0-9]{24}$/.test(sessionId)) return res.status(400).json({ error: 'Invalid session' });
  const contact = await db.prepare('SELECT id FROM contacts WHERE wa_id = ?').get(sessionId);
  if (!contact) return res.json({ messages: [] });
  // Only customer-facing messages: the visitor's own inbound, and outbound
  // replies/media/auto-replies/surveys. Internal system notes (type='system')
  // and team notes (type='note') are never exposed.
  const rows = await db.prepare(`
    SELECT m.id, m.direction, m.body, m.type, m.media_url, m.created_at,
           CASE WHEN m.sender_type = 'ai' THEN a.name ELSE u.name END AS sender_name
    FROM messages m
    JOIN conversations cv ON cv.id = m.conversation_id
    LEFT JOIN users u ON u.id = m.sender_user_id
    LEFT JOIN ai_agents a ON a.id = m.ai_agent_id
    WHERE cv.contact_id = ? AND m.id > ?
      AND (m.direction = 'in'
           OR (m.direction = 'out' AND m.type IN ('text','image','audio','template','auto_reply','csat')))
    ORDER BY m.id
  `).all(contact.id, after);
  res.json({ messages: rows });
});

export default router;
