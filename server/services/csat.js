// Post-resolution customer satisfaction (CSAT) surveys.
//
// When a conversation is resolved (and the feature is on, and the 24h session
// window is still open), a rating prompt is sent and the conversation is
// flagged awaiting_csat. The customer's next reply that is a bare number in
// range is captured as the score, a thank-you is sent, and the conversation
// stays resolved. A short free-text follow-up left immediately after is stored
// as the comment.
import db, { getSetting, setSetting } from '../db.js';
import { emit } from './events.js';
import { sendText, isSandbox } from './whatsapp.js';
import { getSessionWindowStatus } from './sessionWindow.js';
import { addSystemNote } from './assignment.js';
import { toDate } from './sla.js';

const DEFAULT_SCALE = 5;
const DEFAULT_MESSAGE = 'Thanks for chatting with us! 🙏 How would you rate your experience from 1 (poor) to 5 (great)? Just reply with a number.';
const DEFAULT_THANKS = 'Thank you for your feedback! 🌟';

export async function getCsatConfig() {
  return {
    enabled: (await getSetting('csat_enabled', '0')) === '1',
    scale: parseInt(await getSetting('csat_scale', String(DEFAULT_SCALE)), 10) || DEFAULT_SCALE,
    message: await getSetting('csat_message', DEFAULT_MESSAGE),
    thanksMessage: await getSetting('csat_thanks', DEFAULT_THANKS),
  };
}

export async function setCsatConfig({ enabled, scale, message, thanksMessage }) {
  if (enabled !== undefined) await setSetting('csat_enabled', enabled ? '1' : '0');
  if (scale !== undefined) await setSetting('csat_scale', String(Math.max(2, Math.min(10, parseInt(scale, 10) || DEFAULT_SCALE))));
  if (message !== undefined) await setSetting('csat_message', message);
  if (thanksMessage !== undefined) await setSetting('csat_thanks', thanksMessage);
}

// Send the survey when a conversation is resolved. No-op if disabled, if the
// session window is closed (can't free-form message), or if a rating for this
// resolution is already pending/collected.
export async function maybeSendSurvey(conversationId) {
  const config = await getCsatConfig();
  if (!config.enabled) return;
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conv || conv.awaiting_csat) return;
  if (!(await isSandbox())) {
    const session = await getSessionWindowStatus(conversationId);
    if (!session.withinWindow) return; // can't send a free-form survey outside 24h
  }
  const contact = await db.prepare('SELECT * FROM contacts WHERE id = ?').get(conv.contact_id);
  const waMessageId = await sendText(contact.wa_id, config.message);
  await db.prepare(
    "INSERT INTO messages (conversation_id, direction, sender_type, type, body, wa_message_id, status) VALUES (?, 'out', 'system', 'csat', ?, ?, 'sent')"
  ).run(conversationId, config.message, waMessageId);
  await db.prepare('UPDATE conversations SET awaiting_csat = 1, last_message_at = CURRENT_TIMESTAMP, last_message_preview = ? WHERE id = ?')
    .run('⭐ Sent satisfaction survey', conversationId);
  emit('message_created', { conversation_id: conversationId });
  emit('conversation_updated', { conversation_id: conversationId });
}

// Handle a reply while a survey is pending. Returns:
//   'scored'  — captured a rating (stops normal inbound routing)
//   'comment' — stored a follow-up comment for a just-given score (stops routing)
//   null      — not survey-related; let normal inbound handling proceed
export async function handleSurveyReply(conversation, contact, text) {
  const config = await getCsatConfig();

  if (conversation.awaiting_csat) {
    const match = String(text).trim().match(/^([0-9]{1,2})$/);
    const score = match ? parseInt(match[1], 10) : null;
    if (score != null && score >= 1 && score <= config.scale) {
      await db.prepare('UPDATE conversations SET awaiting_csat = 0, csat_score = ?, csat_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(score, conversation.id);
      const waMessageId = await sendText(contact.wa_id, config.thanksMessage);
      await db.prepare(
        "INSERT INTO messages (conversation_id, direction, sender_type, type, body, wa_message_id, status) VALUES (?, 'out', 'system', 'csat', ?, ?, 'sent')"
      ).run(conversation.id, config.thanksMessage, waMessageId);
      await db.prepare("UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = ? WHERE id = ?")
        .run(`⭐ Rated ${score}/${config.scale}`, conversation.id);
      await addSystemNote(conversation.id, `⭐ Customer rated ${score}/${config.scale}`);
      emit('message_created', { conversation_id: conversation.id });
      emit('conversation_updated', { conversation_id: conversation.id });
      return 'scored';
    }
    return null; // a non-numeric reply is a real message — reopen and route it
  }

  // A short free-text reply right after a rating, with no comment yet, is the
  // customer elaborating on their score — capture it, don't reopen.
  if (conversation.csat_score != null && conversation.csat_comment == null && conversation.status === 'resolved') {
    const csatMsg = await db.prepare("SELECT created_at FROM messages WHERE conversation_id = ? AND type = 'csat' ORDER BY id DESC LIMIT 1").get(conversation.id);
    const recent = csatMsg && (Date.now() - toDate(csatMsg.created_at).getTime()) < 10 * 60000;
    if (recent && String(text).trim().length <= 280) {
      await db.prepare('UPDATE conversations SET csat_comment = ? WHERE id = ?').run(String(text).trim(), conversation.id);
      await addSystemNote(conversation.id, '💬 Customer left a comment on their rating');
      emit('conversation_updated', { conversation_id: conversation.id });
      return 'comment';
    }
  }
  return null;
}

export { DEFAULT_MESSAGE, DEFAULT_THANKS };
