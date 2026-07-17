// Round-robin assignment of conversations to staff.
//
// A persistent cursor walks the ordered list of active, available agents so
// new conversations are distributed evenly. Admins count as assignable only
// if they have marked themselves available.
import db, { getSetting, setSetting } from '../db.js';
import { emit } from './events.js';

export function nextAgent() {
  const agents = db.prepare(
    "SELECT id, name FROM users WHERE is_active = 1 AND available = 1 ORDER BY id"
  ).all();
  if (agents.length === 0) return null;
  const cursor = parseInt(getSetting('round_robin_cursor', '0'), 10) || 0;
  const agent = agents[cursor % agents.length];
  setSetting('round_robin_cursor', String((cursor + 1) % agents.length));
  return agent;
}

export function assignConversation(conversationId, userId, { by = 'round-robin' } = {}) {
  db.prepare('UPDATE conversations SET assigned_user_id = ? WHERE id = ?').run(userId, conversationId);
  const user = userId ? db.prepare('SELECT name FROM users WHERE id = ?').get(userId) : null;
  addSystemNote(conversationId, user ? `Assigned to ${user.name} (${by})` : 'Unassigned');
  emit('conversation_updated', { conversation_id: conversationId });
  return user;
}

export function roundRobinAssign(conversationId) {
  const agent = nextAgent();
  if (!agent) return null;
  assignConversation(conversationId, agent.id);
  return agent;
}

export function addSystemNote(conversationId, text) {
  db.prepare(
    "INSERT INTO messages (conversation_id, direction, sender_type, type, body, status) VALUES (?, 'out', 'system', 'system', ?, 'sent')"
  ).run(conversationId, text);
  emit('message_created', { conversation_id: conversationId });
}
