// One conversation per contact.
//
// A phone number has exactly one conversation thread, so its entire history
// (across resolved/reopened cycles, broadcasts, and agent-initiated chats)
// lives in one place. A UNIQUE index on conversations(contact_id) enforces
// this; this helper is the single funnel every code path uses to attach to
// that thread.
import db from '../db.js';

export async function getContactConversation(contactId) {
  return db.prepare('SELECT * FROM conversations WHERE contact_id = ? ORDER BY id LIMIT 1').get(contactId);
}

export async function getOrCreateConversation(contactId, { status = 'open', assignedUserId = null } = {}) {
  let conv = await getContactConversation(contactId);
  if (conv) return { conv, created: false };
  try {
    const info = await db.prepare(
      'INSERT INTO conversations (contact_id, status, assigned_user_id) VALUES (?, ?, ?)'
    ).run(contactId, status, assignedUserId);
    conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
    return { conv, created: true };
  } catch (err) {
    // Lost a race with a concurrent create (unique index) — return the winner.
    conv = await getContactConversation(contactId);
    if (conv) return { conv, created: false };
    throw err;
  }
}
