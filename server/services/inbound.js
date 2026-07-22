// Inbound message pipeline — shared by the live Meta webhook and the sandbox
// simulator.
//
// For each customer message: upsert the contact, find/reopen a conversation,
// store the message, then route it:
//   1. Brand-new conversation + an active auto-assign AI agent -> AI picks it
//      up and auto-replies (round-robin to humans happens on handoff).
//   2. Otherwise a new conversation is round-robin assigned to the next
//      available staff member.
//   3. Existing conversations keep their owner; AI keeps replying if enabled.
import db from '../db.js';
import { emit } from './events.js';
import { SERVERLESS } from '../runtime.js';
import { roundRobinAssign, addSystemNote, detectSkill } from './assignment.js';
import { maybeAutoReply, pickAutoAssignAgent } from './aiResponder.js';

export async function handleInboundMessage({ waId, name, text, waMessageId, type = 'text' }) {
  waId = String(waId).replace(/\D/g, '');

  let contact = db.prepare('SELECT * FROM contacts WHERE wa_id = ?').get(waId);
  if (!contact) {
    const info = db.prepare('INSERT INTO contacts (wa_id, name) VALUES (?, ?)').run(waId, name || null);
    contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid);
    emit('contact_created', { contact_id: contact.id });
  } else if (name && !contact.name) {
    db.prepare('UPDATE contacts SET name = ? WHERE id = ?').run(name, contact.id);
  }
  db.prepare("UPDATE contacts SET last_message_at = datetime('now') WHERE id = ?").run(contact.id);

  let conversation = db.prepare(
    "SELECT * FROM conversations WHERE contact_id = ? AND status != 'resolved' ORDER BY id DESC LIMIT 1"
  ).get(contact.id);
  let isNew = false;
  if (!conversation) {
    // Reopen the latest resolved thread if one exists, else create fresh.
    const previous = db.prepare('SELECT * FROM conversations WHERE contact_id = ? ORDER BY id DESC LIMIT 1').get(contact.id);
    if (previous) {
      db.prepare("UPDATE conversations SET status = 'open', assigned_user_id = NULL, ai_enabled = 0 WHERE id = ?").run(previous.id);
      conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(previous.id);
      addSystemNote(conversation.id, 'Conversation reopened');
      isNew = true;
    } else {
      const info = db.prepare("INSERT INTO conversations (contact_id, status) VALUES (?, 'open')").run(contact.id);
      conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
      isNew = true;
    }
  }

  db.prepare(
    "INSERT INTO messages (conversation_id, direction, sender_type, type, body, wa_message_id, status) VALUES (?, 'in', 'contact', ?, ?, ?, 'received')"
  ).run(conversation.id, type, text, waMessageId || null);
  db.prepare(
    "UPDATE conversations SET last_message_at = datetime('now'), last_message_preview = ?, unread_count = unread_count + 1, status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END WHERE id = ?"
  ).run(text.slice(0, 120), conversation.id);

  emit('message_created', { conversation_id: conversation.id });
  emit('conversation_updated', { conversation_id: conversation.id });

  if (isNew) {
    // Skill-based routing: classify the first message, then prefer an AI
    // agent or staff pool that has the matching skill.
    const skill = detectSkill(text);
    if (skill) {
      db.prepare('UPDATE conversations SET required_skill = ? WHERE id = ?').run(skill, conversation.id);
      addSystemNote(conversation.id, `🏷 Topic detected: ${skill}`);
    }
    const aiAgent = pickAutoAssignAgent(skill);
    if (aiAgent) {
      db.prepare('UPDATE conversations SET ai_enabled = 1, ai_agent_id = ? WHERE id = ?').run(aiAgent.id, conversation.id);
      addSystemNote(conversation.id, `🤖 ${aiAgent.name} picked up this conversation`);
    } else {
      roundRobinAssign(conversation.id, skill);
    }
  }

  // Always-on servers fire-and-forget so webhook responses stay fast (Meta
  // requires <10s). Serverless freezes after the response, so await there.
  const autoReply = maybeAutoReply(conversation.id, text).catch((err) => console.error('Auto-reply error:', err));
  if (SERVERLESS) await autoReply;

  return { contact, conversation };
}
