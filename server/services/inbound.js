// Inbound message pipeline — shared by the live Meta webhook and the sandbox
// simulator.
//
// For each customer message: upsert the contact, find/reopen a conversation,
// store the message, then route it:
//   1. Brand-new conversation: classify the topic against routing skills,
//      then prefer an AI agent whose skills match; otherwise round-robin to
//      the matching staff pool (general pool as fallback).
//   2. Existing conversations keep their owner; AI keeps replying if enabled.
//   3. Outside configured business hours (or on a holiday): still route/queue
//      the conversation for staff, but skip the AI and send the configurable
//      away message instead, at most once per business day.
//   4. An exact STOP/START keyword message is handled as pure subscription
//      housekeeping — confirmation sent, no AI/routing triggered.
import db from '../db.js';
import { emit } from './events.js';
import { SERVERLESS } from '../runtime.js';
import { roundRobinAssign, addSystemNote, detectSkill } from './assignment.js';
import { maybeAutoReply, pickAutoAssignAgent } from './aiResponder.js';
import { getOrCreateConversation } from './conversations.js';
import { getBusinessHoursStatus, computeNextOpenLabel, renderAwayMessage } from './businessHours.js';
import { handleOptKeyword } from './optOut.js';
import { markAwaiting, recordResponse } from './sla.js';
import { sendText } from './whatsapp.js';

export async function handleInboundMessage({ waId, name, text, waMessageId, type = 'text', mediaUrl = null }) {
  waId = String(waId).replace(/\D/g, '');

  let contact = await db.prepare('SELECT * FROM contacts WHERE wa_id = ?').get(waId);
  if (!contact) {
    const info = await db.prepare('INSERT INTO contacts (wa_id, name) VALUES (?, ?)').run(waId, name || null);
    contact = await db.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid);
    emit('contact_created', { contact_id: contact.id });
  } else if (name && !contact.name) {
    await db.prepare('UPDATE contacts SET name = ? WHERE id = ?').run(name, contact.id);
  }
  await db.prepare('UPDATE contacts SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?').run(contact.id);

  // Always the contact's single thread — history is never split across rows.
  const { conv, created } = await getOrCreateConversation(contact.id);
  let conversation = conv;
  let isNew = created;
  if (!created && conversation.status === 'resolved') {
    // A message after resolution reopens the same thread and re-routes it.
    await db.prepare("UPDATE conversations SET status = 'open', assigned_user_id = NULL, ai_enabled = 0, resolved_at = NULL WHERE id = ?").run(conversation.id);
    conversation = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation.id);
    await addSystemNote(conversation.id, 'Conversation reopened');
    isNew = true;
  }

  await db.prepare(
    "INSERT INTO messages (conversation_id, direction, sender_type, type, body, wa_message_id, status, media_url) VALUES (?, 'in', 'contact', ?, ?, ?, 'received', ?)"
  ).run(conversation.id, type, text, waMessageId || null, mediaUrl);
  const preview = type === 'image' ? `📷 ${text || 'Photo'}` : type === 'audio' ? '🎤 Voice message' : text;
  await db.prepare(
    "UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = ?, unread_count = unread_count + 1, status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END WHERE id = ?"
  ).run(preview.slice(0, 120), conversation.id);
  // Start the SLA clock — the customer is now waiting for a response.
  await markAwaiting(conversation.id);

  emit('message_created', { conversation_id: conversation.id });
  emit('conversation_updated', { conversation_id: conversation.id });

  // STOP/START is pure subscription housekeeping — handle it and stop, no
  // AI/routing/away-message noise for what's just an unsubscribe request.
  const optResult = await handleOptKeyword(conversation.id, contact, text);
  if (optResult) {
    emit('message_created', { conversation_id: conversation.id });
    emit('conversation_updated', { conversation_id: conversation.id });
    return { contact, conversation };
  }

  const hours = await getBusinessHoursStatus();
  const closed = hours.enabled && !hours.withinHours;

  if (isNew) {
    // Skill-based routing: classify the first message, then prefer an AI
    // agent or staff pool that has the matching skill — unless we're closed,
    // in which case a human (not the AI) should own it for when hours resume.
    const skill = await detectSkill(text);
    if (skill) {
      await db.prepare('UPDATE conversations SET required_skill = ? WHERE id = ?').run(skill, conversation.id);
      await addSystemNote(conversation.id, `🏷 Topic detected: ${skill}`);
    }
    const aiAgent = closed ? null : await pickAutoAssignAgent(skill);
    if (aiAgent) {
      await db.prepare('UPDATE conversations SET ai_enabled = 1, ai_agent_id = ? WHERE id = ?').run(aiAgent.id, conversation.id);
      await addSystemNote(conversation.id, `🤖 ${aiAgent.name} picked up this conversation`);
    } else {
      await roundRobinAssign(conversation.id, skill);
    }
  }

  if (closed) {
    // At most one away-message per business day per conversation, so a
    // chatty customer outside hours doesn't get greeted on every message.
    if (conversation.away_notified_on !== hours.dateStr) {
      const nextOpenLabel = await computeNextOpenLabel(hours.config);
      const away = renderAwayMessage(hours.config.awayMessage, { name: contact.name, reason: hours.reason, nextOpenLabel });
      const waMessageIdOut = await sendText(waId, away);
      await db.prepare(
        "INSERT INTO messages (conversation_id, direction, sender_type, type, body, wa_message_id, status) VALUES (?, 'out', 'system', 'auto_reply', ?, ?, 'sent')"
      ).run(conversation.id, away, waMessageIdOut);
      await db.prepare('UPDATE conversations SET away_notified_on = ?, last_message_at = CURRENT_TIMESTAMP, last_message_preview = ? WHERE id = ?')
        .run(hours.dateStr, `🕒 ${away}`.slice(0, 120), conversation.id);
      await addSystemNote(conversation.id, hours.holidayName ? `🕒 Sent holiday auto-reply (${hours.holidayName})` : '🕒 Sent after-hours auto-reply');
      // The away reply clears the SLA clock (no overnight breaches) but isn't
      // counted as a real first response.
      await recordResponse(conversation.id, { countAsFirstResponse: false });
      emit('message_created', { conversation_id: conversation.id });
      emit('conversation_updated', { conversation_id: conversation.id });
    }
    return { contact, conversation };
  }

  // Always-on servers fire-and-forget so webhook responses stay fast (Meta
  // requires <10s). Serverless freezes after the response, so await there.
  const aiText = text || (type === 'image' ? '[The customer sent a photo]' : type === 'audio' ? '[The customer sent a voice message]' : '[media message]');
  const autoReply = maybeAutoReply(conversation.id, aiText).catch((err) => console.error('Auto-reply error:', err));
  if (SERVERLESS) await autoReply;

  return { contact, conversation };
}
