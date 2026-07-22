// Skill-based routing + round-robin assignment of conversations to staff.
//
// Inbound messages are classified against admin-defined skills (keyword
// matching, most hits wins). Conversations route to teammates who have the
// required skill, with a persistent round-robin cursor per skill pool so
// each pool is walked fairly. If no skill matches (or nobody has it), the
// general pool of all active, available agents is used. Admins count as
// assignable only if they have marked themselves available.
import db, { getSetting, setSetting } from '../db.js';
import { emit } from './events.js';

const parseSkills = (json) => { try { return JSON.parse(json || '[]'); } catch { return []; } };

// Classify a message: the skill with the most keyword hits, or null.
export async function detectSkill(text) {
  const lower = String(text).toLowerCase();
  let best = null;
  let bestHits = 0;
  for (const skill of await db.prepare('SELECT name, keywords FROM skills').all()) {
    const hits = parseSkills(skill.keywords)
      .filter((k) => k && lower.includes(String(k).toLowerCase())).length;
    if (hits > bestHits) { best = skill.name; bestHits = hits; }
  }
  return best;
}

export async function nextAgent(skill = null) {
  let agents = await db.prepare(
    'SELECT id, name, skills FROM users WHERE is_active = 1 AND available = 1 ORDER BY id'
  ).all();
  let poolKey = 'general';
  if (skill) {
    const skilled = agents.filter((a) => parseSkills(a.skills).includes(skill));
    if (skilled.length) { agents = skilled; poolKey = skill; }
  }
  if (agents.length === 0) return null;
  const cursorKey = 'round_robin_cursor:' + poolKey;
  const cursor = parseInt(await getSetting(cursorKey, '0'), 10) || 0;
  const agent = agents[cursor % agents.length];
  await setSetting(cursorKey, String((cursor + 1) % agents.length));
  return { ...agent, poolKey };
}

export async function assignConversation(conversationId, userId, { by = 'round-robin' } = {}) {
  await db.prepare('UPDATE conversations SET assigned_user_id = ? WHERE id = ?').run(userId, conversationId);
  const user = userId ? await db.prepare('SELECT name FROM users WHERE id = ?').get(userId) : null;
  await addSystemNote(conversationId, user ? `Assigned to ${user.name} (${by})` : 'Unassigned');
  emit('conversation_updated', { conversation_id: conversationId });
  return user;
}

export async function roundRobinAssign(conversationId, skill = null) {
  const agent = await nextAgent(skill);
  if (!agent) return null;
  const by = agent.poolKey === 'general' ? 'round-robin' : `round-robin · ${agent.poolKey} skill`;
  await assignConversation(conversationId, agent.id, { by });
  return agent;
}

export async function addSystemNote(conversationId, text) {
  await db.prepare(
    "INSERT INTO messages (conversation_id, direction, sender_type, type, body, status) VALUES (?, 'out', 'system', 'system', ?, 'sent')"
  ).run(conversationId, text);
  emit('message_created', { conversation_id: conversationId });
}
