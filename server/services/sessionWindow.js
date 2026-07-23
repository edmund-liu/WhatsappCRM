// WhatsApp's 24-hour customer service session window.
//
// Meta only allows free-form (session) messages within 24 hours of the
// customer's last inbound message; outside that window (or if the customer
// has never messaged at all) only a pre-approved template can reach them.
// This applies regardless of sandbox/live mode, since it's a WhatsApp
// business rule, not a transport detail — enforcing it in sandbox too lets
// admins learn and test the "send a template to reopen" flow safely.
import db from '../db.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function getSessionWindowStatus(conversationId) {
  // The 24h window is a WhatsApp rule; other channels (web chat, etc.) have
  // no such restriction, so they're always "within window".
  const ch = await db.prepare('SELECT c.channel FROM conversations cv JOIN contacts c ON c.id = cv.contact_id WHERE cv.id = ?').get(conversationId);
  if (ch && ch.channel && ch.channel !== 'whatsapp') return { withinWindow: true, reason: null, lastInboundAt: null, hoursRemaining: Infinity };

  const last = await db.prepare(
    "SELECT created_at FROM messages WHERE conversation_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1"
  ).get(conversationId);
  if (!last) return { withinWindow: false, reason: 'no_session', lastInboundAt: null, hoursRemaining: 0 };

  // Postgres returns TIMESTAMPTZ columns as Date objects; SQLite returns the
  // TEXT column as a "YYYY-MM-DD HH:MM:SS" string (UTC, no zone suffix).
  const lastAt = last.created_at instanceof Date
    ? last.created_at
    : new Date(String(last.created_at).replace(' ', 'T') + (String(last.created_at).includes('Z') ? '' : 'Z'));
  const elapsed = Date.now() - lastAt.getTime();
  const withinWindow = elapsed < WINDOW_MS;
  return {
    withinWindow,
    reason: withinWindow ? null : 'expired',
    lastInboundAt: last.created_at,
    hoursRemaining: withinWindow ? Math.max(0, (WINDOW_MS - elapsed) / 3600000) : 0,
  };
}
