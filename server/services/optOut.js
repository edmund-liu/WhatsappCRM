// STOP / START keyword compliance.
//
// WhatsApp Business Policy expects businesses to honor opt-out requests.
// A customer message that (after trimming punctuation) is *exactly* one of
// the configured keywords — not merely mentions it — flips the contact's
// subscription state and sends a confirmation. Broadcasts already exclude
// opted_out contacts, so this is the only piece needed to make it automatic.
import db, { getSetting, setSetting } from '../db.js';
import { sendText } from './whatsapp.js';
import { addSystemNote } from './assignment.js';

const DEFAULT_OPTOUT_KEYWORDS = ['stop', 'unsubscribe', 'opt out', 'cancel'];
const DEFAULT_OPTIN_KEYWORDS = ['start', 'subscribe', 'opt in'];
const DEFAULT_OPTOUT_MESSAGE = "You've been unsubscribed from our messages and won't receive further broadcasts. Reply START anytime to opt back in.";
const DEFAULT_OPTIN_MESSAGE = "You're subscribed again — we'll be in touch! Reply STOP anytime to opt out.";

export async function getOptOutConfig() {
  const parse = async (key, fallback) => { try { return JSON.parse(await getSetting(key, '')) || fallback; } catch { return fallback; } };
  return {
    optOutKeywords: await parse('optout_keywords', DEFAULT_OPTOUT_KEYWORDS),
    optOutMessage: await getSetting('optout_message', DEFAULT_OPTOUT_MESSAGE),
    optInKeywords: await parse('optin_keywords', DEFAULT_OPTIN_KEYWORDS),
    optInMessage: await getSetting('optin_message', DEFAULT_OPTIN_MESSAGE),
  };
}

export async function setOptOutConfig({ optOutKeywords, optOutMessage, optInKeywords, optInMessage }) {
  if (optOutKeywords !== undefined) await setSetting('optout_keywords', JSON.stringify(optOutKeywords));
  if (optOutMessage !== undefined) await setSetting('optout_message', optOutMessage);
  if (optInKeywords !== undefined) await setSetting('optin_keywords', JSON.stringify(optInKeywords));
  if (optInMessage !== undefined) await setSetting('optin_message', optInMessage);
}

// Exact-match only (case/punctuation-insensitive) so a sentence that merely
// contains "stop" ("please stop charging me twice") doesn't false-trigger.
function exactlyMatches(text, keywords) {
  const clean = String(text).trim().toLowerCase().replace(/[.!?]+$/, '');
  return keywords.some((k) => k && clean === String(k).trim().toLowerCase());
}

// Returns 'opt-out' | 'opt-in' | null, and handles the contact update,
// confirmation send, and audit note when matched.
export async function handleOptKeyword(conversationId, contact, text) {
  const config = await getOptOutConfig();

  if (exactlyMatches(text, config.optOutKeywords)) {
    await db.prepare('UPDATE contacts SET opted_out = 1 WHERE id = ?').run(contact.id);
    await sendAndLog(conversationId, contact, config.optOutMessage, '🚫 Customer opted out of broadcasts (STOP keyword)');
    return 'opt-out';
  }
  if (exactlyMatches(text, config.optInKeywords)) {
    await db.prepare('UPDATE contacts SET opted_out = 0 WHERE id = ?').run(contact.id);
    await sendAndLog(conversationId, contact, config.optInMessage, '✅ Customer opted back in (START keyword)');
    return 'opt-in';
  }
  return null;
}

async function sendAndLog(conversationId, contact, message, note) {
  const waMessageId = await sendText(contact.wa_id, message);
  await db.prepare(
    "INSERT INTO messages (conversation_id, direction, sender_type, type, body, wa_message_id, status) VALUES (?, 'out', 'system', 'auto_reply', ?, ?, 'sent')"
  ).run(conversationId, message, waMessageId);
  await db.prepare("UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = ? WHERE id = ?")
    .run(`🚫 ${message}`.slice(0, 120), conversationId);
  await addSystemNote(conversationId, note);
}

export { DEFAULT_OPTOUT_KEYWORDS, DEFAULT_OPTIN_KEYWORDS, DEFAULT_OPTOUT_MESSAGE, DEFAULT_OPTIN_MESSAGE };
